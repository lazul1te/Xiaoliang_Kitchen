// 数据仓库：两个人共用的分类、菜品、做菜记录、开饭记下的每一顿在内存里放一份，页面读的时候直接用，不用每次都去云上查。
// 改动由 services/dish.js、category.js、log.js、meal.js 先写进云数据库，成功以后再调这里更新。
// 手机本地也缓存一份：下次打开先显示缓存，同时去云上取最新的；没网的时候也能看菜谱。
// 对方在自己手机上改的内容，要等这边重新去云上取（打开小程序、隔一会儿回到页面、下拉刷新）才看得到。
const cloud = require("./cloud");
const storage = require("../utils/storage");
const { normalizeDish } = require("../utils/dish");
const { normalizeLog, sortLogs } = require("../utils/log");
const { normalizeMeal } = require("../utils/meal");

const CACHE_KEY = "cloud_cache";

let state = null; // { categories: [], dishes: [], logs: [], meals: [] }
let fresh = false; // 这次打开以后，有没有从云上取到过最新数据
let syncing = null; // 正在进行的同步（Promise）
let writes = 0; // 改动计数：同步期间有新改动的话，取回来的就是旧数据，要再取一次
let version = 0; // 数据每变一次 +1，页面 onShow 时比一比就知道要不要刷新
let lastSyncAt = 0; // 上次从云上取数据的时间

const clone = (data) => JSON.parse(JSON.stringify(data));

function normalizeCategory(c) {
  return {
    _id: c._id,
    name: String(c.name || "").trim(),
    sort: Number(c.sort) || 0,
    createdAt: Number(c.createdAt) || 0,
  };
}

function sortCategories(list) {
  return list.slice().sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
}

function changed() {
  version += 1;
  try {
    storage.set(CACHE_KEY, state);
  } catch (e) {} // 缓存写不进去不影响使用
}

// 做菜记录、每一顿的集合是后来加的，还没建的话先当作没有，不影响看菜谱（打卡、开饭时会提示去建）
function fetchOptional(name) {
  return cloud.fetchAll(name).catch((err) => {
    if (cloud.isCollectionMissing(err)) return [];
    throw err;
  });
}

const sortMeals = (list) => list.slice().sort((a, b) => b.createdAt - a.createdAt);

// 从云上取最新的分类、菜品和做菜记录，返回数据有没有变。同一时间只取一次
function sync() {
  if (syncing) return syncing;
  const startWrites = writes;
  syncing = Promise.all([cloud.fetchAll("categories"), cloud.fetchAll("dishes"), fetchOptional("cook_logs"), fetchOptional("meals")]).then(
    ([categories, dishes, logs, meals]) => {
      syncing = null;
      if (writes !== startWrites) return sync();
      const next = {
        categories: sortCategories(categories.map(normalizeCategory)),
        dishes: dishes.map(normalizeDish).sort((a, b) => a.createdAt - b.createdAt),
        logs: sortLogs(logs.map(normalizeLog)),
        meals: sortMeals(meals.map(normalizeMeal)),
      };
      lastSyncAt = Date.now();
      fresh = true;
      if (state && JSON.stringify(next) === JSON.stringify(state)) return false;
      state = next;
      changed();
      return true;
    },
    (err) => {
      syncing = null;
      throw cloud.explain(err);
    }
  );
  return syncing;
}

// 保证有数据可用：内存里有就直接用；有本地缓存就先用缓存，后台再去云上取；都没有就等云上的结果
function ensureLoaded() {
  if (state) return Promise.resolve();
  const cache = storage.get(CACHE_KEY);
  if (cache && Array.isArray(cache.categories) && Array.isArray(cache.dishes)) {
    state = {
      categories: sortCategories(cache.categories.map(normalizeCategory)),
      dishes: cache.dishes.map(normalizeDish),
      logs: sortLogs((cache.logs || []).map(normalizeLog)),
      meals: sortMeals((cache.meals || []).map(normalizeMeal)),
    };
    sync().catch(() => {}); // 后台刷新，失败了（比如没网）就先用缓存
    return Promise.resolve();
  }
  return sync();
}

// 等到拿到云上的最新数据（这次打开以后至少同步成功过一次）
function whenFresh() {
  if (fresh) return Promise.resolve();
  return ensureLoaded().then(() => (fresh ? undefined : sync()));
}

// 离上次去云上取数据超过 maxAge 毫秒，就再取一次（对方可能刚改过）。返回数据有没有变
function syncIfStale(maxAge) {
  if (syncing) return syncing;
  if (!state || Date.now() - lastSyncAt < maxAge) return Promise.resolve(false);
  return sync();
}

function touch() {
  writes += 1;
  changed();
}

// 下面这些都要在 ensureLoaded() 之后调用
function listCategories() {
  return clone(state.categories);
}

function setCategories(list) {
  state.categories = sortCategories(list.map(normalizeCategory));
  touch();
}

// 「做过几次」「上次做」直接按做菜记录算，跟记录页永远对得上
function statsByDish() {
  const map = {};
  state.logs.forEach((l) => {
    const s = map[l.dishId] || (map[l.dishId] = { count: 0, last: 0 });
    s.count += 1;
    if (l.cookedAt > s.last) s.last = l.cookedAt;
  });
  return map;
}

function withStats(dish, map) {
  const s = map[dish._id];
  dish.cookCount = s ? s.count : 0;
  dish.lastCookedAt = s ? s.last : null;
  return dish;
}

function listDishes() {
  const map = statsByDish();
  return clone(state.dishes).map((d) => withStats(d, map));
}

function getDish(id) {
  const dish = state.dishes.find((d) => d._id === id);
  return dish ? withStats(clone(dish), statsByDish()) : null;
}

function putDish(dish) {
  const d = normalizeDish(dish);
  const i = state.dishes.findIndex((x) => x._id === d._id);
  if (i >= 0) state.dishes[i] = d;
  else state.dishes.push(d);
  touch();
}

function removeDish(id) {
  state.dishes = state.dishes.filter((d) => d._id !== id);
  touch();
}

// 做菜记录，新的在前
function listLogs() {
  return clone(state.logs);
}

function getLog(id) {
  const log = state.logs.find((l) => l._id === id);
  return log ? clone(log) : null;
}

function putLog(log) {
  const l = normalizeLog(log);
  state.logs = sortLogs(state.logs.filter((x) => x._id !== l._id).concat(l));
  touch();
}

function removeLog(id) {
  state.logs = state.logs.filter((l) => l._id !== id);
  touch();
}

// 开饭记下的每一顿，新的在前
function listMeals() {
  return clone(state.meals);
}

function getMeal(id) {
  const meal = state.meals.find((m) => m._id === id);
  return meal ? clone(meal) : null;
}

function putMeal(meal) {
  const m = normalizeMeal(meal);
  state.meals = sortMeals(state.meals.filter((x) => x._id !== m._id).concat(m));
  touch();
}

function removeMeal(id) {
  state.meals = state.meals.filter((m) => m._id !== id);
  touch();
}

module.exports = {
  ensureLoaded,
  whenFresh,
  sync,
  syncIfStale,
  isFresh: () => fresh,
  getVersion: () => version,
  listCategories,
  setCategories,
  listDishes,
  getDish,
  putDish,
  removeDish,
  listLogs,
  getLog,
  putLog,
  removeLog,
  listMeals,
  getMeal,
  putMeal,
  removeMeal,
};
