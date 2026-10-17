// 今日菜单（点菜篮）和买菜清单：两个人共用，存在云数据库 plans 集合里 _id 为 current 的一条记录。
//   items    { 菜品id: 份数 }               点了哪些菜、各几份
//   checked  { 清单项key: true }            买菜清单里已经买到的
//   extras   { key: { name, createdAt } }   自己加的要买的东西（比如：牛奶）
// 点菜、打勾都是先改手机上的（按了马上有反应），再在后台按顺序写云上；写失败会提示，并以云上的为准重新同步。
// 每次只改对应的那个字段（加一份用 inc，去掉用 remove），两个人同时点不同的菜不会互相覆盖。
const cloud = require("./cloud");
const storage = require("../utils/storage");
const ui = require("../utils/ui");
const { newId } = require("../utils/id");

const COLLECTION = "plans";
const DOC_ID = "current";
const CACHE_KEY = "plan_cache";
const TODAY_TAB_INDEX = 1; // 「今日」是第 2 个 Tab，角标显示在它上面

let plan = null; // { items, checked, extras }
let syncing = null;
let lastSyncAt = 0;
let fresh = false;
let writes = 0; // 本地改动计数：同步期间有新改动的话，取回来的就是旧数据，要再取一次
let version = 0; // 今日菜单每变一次 +1
let docReady = false; // 云上那条记录是不是已经有了
let queue = Promise.resolve(); // 云上的写操作按顺序一个一个来
let alerted = false; // 集合没建、权限不对这类问题只弹一次窗，之后用轻提示
let started = false; // 这次打开以后有没有开始过第一次同步

const empty = () => ({ items: {}, checked: {}, extras: {} });
const clone = (data) => JSON.parse(JSON.stringify(data));

function normalize(doc) {
  const p = empty();
  const items = (doc && doc.items) || {};
  Object.keys(items).forEach((id) => {
    const n = parseInt(items[id], 10);
    if (n > 0) p.items[id] = n;
  });
  const checked = (doc && doc.checked) || {};
  Object.keys(checked).forEach((key) => {
    if (checked[key]) p.checked[key] = true;
  });
  const extras = (doc && doc.extras) || {};
  Object.keys(extras).forEach((key) => {
    const e = extras[key];
    if (e && e.name) p.extras[key] = { name: String(e.name), createdAt: Number(e.createdAt) || 0 };
  });
  return p;
}

function changed() {
  version += 1;
  try {
    storage.set(CACHE_KEY, plan);
  } catch (e) {} // 缓存写不进去不影响使用
  updateBadge();
}

function load() {
  if (!plan) plan = normalize(storage.get(CACHE_KEY));
  return plan;
}

// 当前的今日菜单（同步返回）。第一次用时先拿本地缓存，同时在后台去云上取最新的
function current() {
  load();
  if (!started) {
    started = true;
    sync().catch(() => {});
  }
  return plan;
}

async function fetchDoc() {
  try {
    const doc = (await cloud.collection(COLLECTION).doc(DOC_ID).get()).data;
    docReady = true;
    return doc;
  } catch (err) {
    if (cloud.isDocMissing(err)) return null; // 还没有这条记录：第一次点菜时再建
    throw err;
  }
}

// 从云上取最新的今日菜单，返回有没有变。等手上的写操作都写完了再取，免得取回旧数据
function sync() {
  if (syncing) return syncing;
  load();
  started = true;
  const startWrites = writes;
  syncing = queue
    .then(fetchDoc)
    .then(
      (doc) => {
        syncing = null;
        if (writes !== startWrites) return sync();
        const next = normalize(doc);
        lastSyncAt = Date.now();
        fresh = true;
        if (JSON.stringify(next) === JSON.stringify(plan)) return false;
        plan = next;
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

// 等到拿到云上的最新数据（这次打开以后至少同步成功过一次）
function whenFresh() {
  load();
  return fresh ? Promise.resolve(false) : sync();
}

function syncIfStale(maxAge) {
  if (syncing) return syncing;
  if (fresh && Date.now() - lastSyncAt < maxAge) return Promise.resolve(false);
  return sync();
}

// 云上还没有这条记录就建一条。两个人可能同时在建，建失败时再看一眼，已经有了就行
async function ensureDoc() {
  if (docReady) return;
  if (await fetchDoc()) return;
  try {
    await cloud.collection(COLLECTION).add({ data: Object.assign({ _id: DOC_ID, createdAt: Date.now() }, empty()) });
  } catch (err) {
    if (!(await fetchDoc())) throw err;
  }
  docReady = true;
}

function reportError(err) {
  const e = cloud.explain(err);
  if (!alerted && /集合|权限/.test(e.message)) {
    alerted = true;
    ui.alert("今日菜单没存上", e.message);
  } else {
    ui.toast("今日菜单没同步上，稍后再试");
  }
}

// 改今日菜单：mutate 先改手机上的；buildUpdate(_) 返回要写到云上的字段
function write(mutate, buildUpdate) {
  mutate(load());
  writes += 1;
  changed();
  queue = queue
    .then(async () => {
      await ensureDoc();
      const _ = cloud.command();
      const data = Object.assign(buildUpdate(_), { updatedAt: Date.now() }); // 带上时间，保证每次都真的改到了
      const res = await cloud.collection(COLLECTION).doc(DOC_ID).update({ data });
      if (res.stats && res.stats.updated === 0) throw cloud.notWritten();
    })
    .catch((err) => {
      reportError(err);
      sync().catch(() => {}); // 以云上的为准
    });
  return clone(plan.items);
}

// ---------- 点菜篮 ----------

function getBasket() {
  return clone(current().items);
}

function getCount(basket) {
  return Object.keys(basket).reduce((sum, id) => sum + basket[id], 0);
}

// 加一份，返回新的点菜篮
function add(id) {
  return write(
    (p) => {
      p.items[id] = (p.items[id] || 0) + 1;
    },
    (_) => ({ [`items.${id}`]: _.inc(1) })
  );
}

// 减一份，减到 0 就去掉
function remove(id) {
  const left = (current().items[id] || 0) - 1;
  return write(
    (p) => {
      if (left > 0) p.items[id] = left;
      else delete p.items[id];
    },
    (_) => ({ [`items.${id}`]: left > 0 ? _.inc(-1) : _.remove() })
  );
}

// 菜被删掉了，从今日菜单里整个拿掉
function drop(id) {
  if (!(id in current().items)) return getBasket();
  return write(
    (p) => {
      delete p.items[id];
    },
    (_) => ({ [`items.${id}`]: _.remove() })
  );
}

// 清空今日菜单和买菜清单（两个人的都清空）
function clear() {
  return write(
    (p) => {
      p.items = {};
      p.checked = {};
      p.extras = {};
    },
    (_) => ({ items: _.set({}), checked: _.set({}), extras: _.set({}) })
  );
}

// ---------- 买菜清单 ----------

function getPlan() {
  return clone(current());
}

// 买到了 / 没买到
function toggleChecked(key) {
  const on = !current().checked[key];
  write(
    (p) => {
      if (on) p.checked[key] = true;
      else delete p.checked[key];
    },
    (_) => ({ [`checked.${key}`]: on ? true : _.remove() })
  );
}

function addExtra(name) {
  const key = `x${newId()}`;
  const extra = { name, createdAt: Date.now() };
  write(
    (p) => {
      p.extras[key] = extra;
    },
    (_) => ({ [`extras.${key}`]: _.set(extra) })
  );
}

function removeExtra(key) {
  write(
    (p) => {
      delete p.extras[key];
      delete p.checked[key];
    },
    (_) => ({ [`extras.${key}`]: _.remove(), [`checked.${key}`]: _.remove() })
  );
}

// 刷新「今日」Tab 上的数字角标。
// 只有当前在 Tab 页时才会生效，在详情页调用会静默失败，所以每个 Tab 页的 onShow 里都会再调一次。
function updateBadge() {
  const count = getCount(current().items);
  if (count > 0) {
    wx.setTabBarBadge({
      index: TODAY_TAB_INDEX,
      text: count > 99 ? "99+" : String(count),
      fail() {},
    });
  } else {
    wx.removeTabBarBadge({ index: TODAY_TAB_INDEX, fail() {} });
  }
}

module.exports = {
  getVersion: () => version,
  sync,
  whenFresh,
  syncIfStale,
  getBasket,
  getCount,
  add,
  remove,
  drop,
  clear,
  getPlan,
  toggleChecked,
  addExtra,
  removeExtra,
  updateBadge,
};
