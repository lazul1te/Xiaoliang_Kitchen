// 数据仓库：正在用的这本小本本里的分类、菜品、做菜记录、开饭记下的每一顿，在内存里放一份，页面读的时候直接用，不用每次都去云上查。
// 改动由 services/dish.js、category.js、log.js、meal.js 先写到云上，成功以后再调这里更新。
// 手机本地每本各缓存一份：下次打开先显示缓存，同时去云上取最新的；没网的时候也能看菜谱。换了一本就换成那本的（book.onSwitch）。
// 家人在自己手机上改的内容，要等这边重新去云上取（打开小程序、隔一会儿回到页面、下拉刷新）才看得到。
const cloud = require("./cloud");
const db = require("./db");
const book = require("./book");
const storage = require("../utils/storage");
const { normalizeDish } = require("../utils/dish");
const { normalizeLog, sortLogs } = require("../utils/log");
const { normalizeMeal } = require("../utils/meal");

const CACHE_KEY = "cloud_cache";
const EMPTY = { categories: [], dishes: [], logs: [], meals: [] };

let state = null; // { categories: [], dishes: [], logs: [], meals: [] }
let loadedFor = ""; // state 是哪本的
let fresh = false; // 这次打开以后（换本本以后），有没有从云上取到过最新数据
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

const sortMeals = (list) => list.slice().sort((a, b) => b.createdAt - a.createdAt);

function changed() {
  version += 1;
  try {
    storage.set(book.cacheKey(CACHE_KEY, loadedFor), state);
  } catch (e) {} // 缓存写不进去不影响使用
}

// 换了一本：先清空，用到的时候再读那本的缓存、去云上取
book.onSwitch(() => {
  state = null;
  loadedFor = "";
  fresh = false;
  syncing = null;
  lastSyncAt = 0;
  version += 1;
});

// 从云上取正在用的这本的最新数据，返回数据有没有变。同一时间只取一次
function sync() {
  if (syncing) return syncing;
  const task = book
    .ready()
    .then(() => {
      const bookId = book.currentId();
      const startWrites = writes;
      return db.loadBook(bookId).then((data) => {
        if (syncing === task) syncing = null;
        if (bookId !== book.currentId()) return false; // 这期间换了一本，取回来的不要了
        if (writes !== startWrites) return sync();
        const next = {
          categories: sortCategories(data.categories.map(normalizeCategory)),
          dishes: data.dishes.map(normalizeDish).sort((a, b) => a.createdAt - b.createdAt),
          logs: sortLogs(data.cook_logs.map(normalizeLog)),
          meals: sortMeals(data.meals.map(normalizeMeal)),
        };
        lastSyncAt = Date.now();
        fresh = true;
        if (state && loadedFor === bookId && JSON.stringify(next) === JSON.stringify(state)) return false;
        state = next;
        loadedFor = bookId;
        changed();
        return true;
      });
    })
    .catch((err) => {
      if (syncing === task) syncing = null;
      throw cloud.explain(err);
    });
  syncing = task;
  return task;
}

// 保证有数据可用：内存里有就直接用；有本地缓存就先用缓存，后台再去云上取；都没有就等云上的结果
async function ensureLoaded() {
  for (let i = 0; i < 3; i++) {
    if (!book.currentId()) await book.ready(); // 第一次打开新版本：先问一下进哪本
    const bookId = book.currentId();
    if (state && loadedFor === bookId) return;
    const cache = storage.get(book.cacheKey(CACHE_KEY, bookId));
    if (cache && Array.isArray(cache.categories) && Array.isArray(cache.dishes)) {
      state = {
        categories: sortCategories(cache.categories.map(normalizeCategory)),
        dishes: cache.dishes.map(normalizeDish),
        logs: sortLogs((cache.logs || []).map(normalizeLog)),
        meals: sortMeals((cache.meals || []).map(normalizeMeal)),
      };
      loadedFor = bookId;
      sync().catch(() => {}); // 后台刷新，失败了（比如没网）就先用缓存
      return;
    }
    await sync();
    if (state && loadedFor === book.currentId()) return;
  }
  throw new Error("没读到小本本里的数据，稍后再试");
}

// 等到拿到云上的最新数据（这次打开以后至少同步成功过一次）
function whenFresh() {
  if (fresh) return Promise.resolve();
  return ensureLoaded().then(() => (fresh ? undefined : sync()));
}

// 离上次去云上取数据超过 maxAge 毫秒，就再取一次（家人可能刚改过）。返回数据有没有变
function syncIfStale(maxAge) {
  if (syncing) return syncing;
  if (!state || Date.now() - lastSyncAt < maxAge) return Promise.resolve(false);
  return sync();
}

function touch() {
  writes += 1;
  changed();
}

// 下面这些都要在 ensureLoaded() 之后调用。刚换了一本、还没读到的时候，读到的是空的，改动不记
const current = () => state || EMPTY;

function listCategories() {
  return clone(current().categories);
}

function setCategories(list) {
  if (!state) return;
  state.categories = sortCategories(list.map(normalizeCategory));
  touch();
}

// 「做过几次」「上次做」直接按做菜记录算，跟记录页永远对得上
function statsByDish() {
  const map = {};
  current().logs.forEach((l) => {
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
  return clone(current().dishes).map((d) => withStats(d, map));
}

function getDish(id) {
  const dish = current().dishes.find((d) => d._id === id);
  return dish ? withStats(clone(dish), statsByDish()) : null;
}

function putDish(dish) {
  if (!state) return;
  const d = normalizeDish(dish);
  const i = state.dishes.findIndex((x) => x._id === d._id);
  if (i >= 0) state.dishes[i] = d;
  else state.dishes.push(d);
  touch();
}

function removeDish(id) {
  if (!state) return;
  state.dishes = state.dishes.filter((d) => d._id !== id);
  touch();
}

// 做菜记录，新的在前
function listLogs() {
  return clone(current().logs);
}

function getLog(id) {
  const log = current().logs.find((l) => l._id === id);
  return log ? clone(log) : null;
}

function putLog(log) {
  if (!state) return;
  const l = normalizeLog(log);
  state.logs = sortLogs(state.logs.filter((x) => x._id !== l._id).concat(l));
  touch();
}

function removeLog(id) {
  if (!state) return;
  state.logs = state.logs.filter((l) => l._id !== id);
  touch();
}

// 开饭记下的每一顿，新的在前
function listMeals() {
  return clone(current().meals);
}

function getMeal(id) {
  const meal = current().meals.find((m) => m._id === id);
  return meal ? clone(meal) : null;
}

function putMeal(meal) {
  if (!state) return;
  const m = normalizeMeal(meal);
  state.meals = sortMeals(state.meals.filter((x) => x._id !== m._id).concat(m));
  touch();
}

function removeMeal(id) {
  if (!state) return;
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
