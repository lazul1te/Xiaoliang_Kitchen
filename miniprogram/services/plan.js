// 菜篮（点了哪些菜、各几份）和买菜清单的勾选：两个人共用，存在 plans 集合里 _id 为 current 的记录。
//   items    { 菜品id: 份数 }
//   checked  { 清单项key: true }            买菜清单里已经买到的
//   extras   { key: { name, createdAt } }   自己加的要买的东西（比如：牛奶）
// 加一份用 inc、去掉用 remove，两个人同时点不同的菜不会互相覆盖。
const { createSharedDoc } = require("./shared-doc");
const { newId } = require("../utils/id");

const BASKET_TAB_INDEX = 1; // 「菜篮」是第 2 个 Tab，角标显示在它上面

const clone = (data) => JSON.parse(JSON.stringify(data));

function normalize(doc) {
  const p = { items: {}, checked: {}, extras: {} };
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

const doc = createSharedDoc({
  id: "current",
  cacheKey: "plan_cache",
  label: "菜篮",
  normalize,
  onChange: (value) => updateBadge(value),
});

// ---------- 菜篮 ----------

function getBasket() {
  return clone(doc.current().items);
}

function getCount(basket) {
  return Object.keys(basket).reduce((sum, id) => sum + basket[id], 0);
}

// 加一份，返回新的菜篮
function add(id) {
  doc.write(
    (p) => {
      p.items[id] = (p.items[id] || 0) + 1;
    },
    (_) => ({ [`items.${id}`]: _.inc(1) })
  );
  return getBasket();
}

// 减一份，减到 0 就去掉
function remove(id) {
  const left = (doc.current().items[id] || 0) - 1;
  doc.write(
    (p) => {
      if (left > 0) p.items[id] = left;
      else delete p.items[id];
    },
    (_) => ({ [`items.${id}`]: left > 0 ? _.inc(-1) : _.remove() })
  );
  return getBasket();
}

// 菜被删掉了，或者做完打卡了，从菜篮里整个拿掉
function drop(id) {
  if (!(id in doc.current().items)) return getBasket();
  doc.write(
    (p) => {
      delete p.items[id];
    },
    (_) => ({ [`items.${id}`]: _.remove() })
  );
  return getBasket();
}

// 清空菜篮和买菜清单（两个人的都清空）
function clear() {
  doc.write(
    (p) => {
      p.items = {};
      p.checked = {};
      p.extras = {};
    },
    (_) => ({ items: _.set({}), checked: _.set({}), extras: _.set({}) })
  );
  return getBasket();
}

// ---------- 买菜清单 ----------

function getPlan() {
  return clone(doc.current());
}

// 买到了 / 没买到
function toggleChecked(key) {
  const on = !doc.current().checked[key];
  doc.write(
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
  doc.write(
    (p) => {
      p.extras[key] = extra;
    },
    (_) => ({ [`extras.${key}`]: _.set(extra) })
  );
}

function removeExtra(key) {
  doc.write(
    (p) => {
      delete p.extras[key];
      delete p.checked[key];
    },
    (_) => ({ [`extras.${key}`]: _.remove(), [`checked.${key}`]: _.remove() })
  );
}

// 刷新「菜篮」Tab 上的数字角标。
// 只有当前在 Tab 页时才会生效，在详情页调用会静默失败，所以每个 Tab 页的 onShow 里都会再调一次。
function updateBadge(value) {
  const count = getCount((value || doc.current()).items);
  if (count > 0) {
    wx.setTabBarBadge({
      index: BASKET_TAB_INDEX,
      text: count > 99 ? "99+" : String(count),
      fail() {},
    });
  } else {
    wx.removeTabBarBadge({ index: BASKET_TAB_INDEX, fail() {} });
  }
}

module.exports = {
  getVersion: doc.getVersion,
  sync: doc.sync,
  whenFresh: doc.whenFresh,
  syncIfStale: doc.syncIfStale,
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
  updateBadge: () => updateBadge(),
};
