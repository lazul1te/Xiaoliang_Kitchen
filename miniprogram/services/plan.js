// 菜篮（点了哪些菜、各几份）、点菜单和买菜清单的勾选：这本小本本里的人共用，存在 plans 集合里这本的 current 那条。
//   items     { 菜品id: 份数 }
//   checked   { 清单项key: true }            买菜清单里已经买到的
//   extras    { key: { name, createdAt } }   自己加的要买的东西（比如：牛奶）
//   order     下了单的点菜单（没下单时没有这个字段），格式见 utils/order.js 的 normalizeOrder
//   orderSeq  点菜单编号数到几了
// 加一份用 inc、去掉用 remove，几个人同时点不同的菜不会互相覆盖。
const { createSharedDoc } = require("./shared-doc");
const { newId } = require("../utils/id");
const { normalizeOrder } = require("../utils/order");

const BASKET_TAB_INDEX = 1; // 「菜篮」是第 2 个 Tab，角标显示在它上面

const clone = (data) => JSON.parse(JSON.stringify(data));

function normalize(doc) {
  const p = { items: {}, checked: {}, extras: {}, order: null, orderSeq: 0 };
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
  p.order = normalizeOrder(doc && doc.order);
  p.orderSeq = Math.max(Number(doc && doc.orderSeq) || 0, p.order ? p.order.no : 0);
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

// 菜篮里的菜都拿掉了，点菜单也就没了
function emptiesBasket(ids) {
  const p = doc.current();
  return !!p.order && Object.keys(p.items).every((id) => ids.indexOf(id) >= 0);
}

// 减一份，减到 0 就去掉
function remove(id) {
  const left = (doc.current().items[id] || 0) - 1;
  const dropOrder = left <= 0 && emptiesBasket([id]);
  doc.write(
    (p) => {
      if (left > 0) p.items[id] = left;
      else delete p.items[id];
      if (dropOrder) p.order = null;
    },
    (_) => Object.assign({ [`items.${id}`]: left > 0 ? _.inc(-1) : _.remove() }, dropOrder ? { order: _.remove() } : {})
  );
  return getBasket();
}

// 一次加好几道：{ 菜品id: 份数 }（「再来一单」）
function addMany(counts) {
  const ids = Object.keys(counts).filter((id) => counts[id] > 0);
  if (!ids.length) return getBasket();
  doc.write(
    (p) => {
      ids.forEach((id) => {
        p.items[id] = (p.items[id] || 0) + counts[id];
      });
    },
    (_) => {
      const data = {};
      ids.forEach((id) => {
        data[`items.${id}`] = _.inc(counts[id]);
      });
      return data;
    }
  );
  return getBasket();
}

// 菜被删掉了，或者做完打卡了，从菜篮里整个拿掉
function drop(id) {
  return dropMany([id]);
}

// 一次拿掉好几道（开饭以后做了的菜）
function dropMany(ids) {
  const list = ids.filter((id) => id in doc.current().items);
  if (!list.length) return getBasket();
  const dropOrder = emptiesBasket(list);
  doc.write(
    (p) => {
      list.forEach((id) => delete p.items[id]);
      if (dropOrder) p.order = null;
    },
    (_) => {
      const data = {};
      list.forEach((id) => {
        data[`items.${id}`] = _.remove();
      });
      if (dropOrder) data.order = _.remove();
      return data;
    }
  );
  return getBasket();
}

// 清空菜篮、点菜单和买菜清单（这本里大家的都清空）
function clear() {
  doc.write(
    (p) => {
      p.items = {};
      p.checked = {};
      p.extras = {};
      p.order = null;
    },
    (_) => ({ items: _.set({}), checked: _.set({}), extras: _.set({}), order: _.remove() })
  );
  return getBasket();
}

// ---------- 点菜单 ----------

// 下了单的点菜单，没下单返回 null
function getOrder() {
  return clone(doc.current().order);
}

// 下单：info 是 { date, meal, flavors, note, orderedBy, cook }。编号接着云上的往下数，先同步一下
async function placeOrder(info) {
  await doc.sync().catch(() => {}); // 没网就按手机上的数
  const p = doc.current();
  if (!getCount(p.items)) throw new Error("菜篮是空的，先去点几道菜");
  const no = p.orderSeq + 1;
  const order = normalizeOrder(Object.assign({}, info, { no, items: p.items, orderedAt: Date.now() }));
  doc.write(
    (v) => {
      v.order = order;
      v.orderSeq = no;
    },
    (_) => ({ order: _.set(order), orderSeq: no })
  );
  return clone(order);
}

// 开饭了：做了的菜从菜篮拿掉，点菜单收起来；没做的留在菜篮里下次做。
// 菜篮空了，买菜清单的勾选也清掉，自己加的东西只留下还没买的
function finishMeal(madeIds) {
  const p = doc.current();
  const made = madeIds.filter((id) => id in p.items);
  const empty = Object.keys(p.items).every((id) => made.indexOf(id) >= 0);
  const extras = {};
  Object.keys(p.extras).forEach((key) => {
    if (!p.checked[key]) extras[key] = p.extras[key];
  });
  doc.write(
    (v) => {
      made.forEach((id) => delete v.items[id]);
      v.order = null;
      if (empty) {
        v.checked = {};
        v.extras = extras;
      }
    },
    (_) => {
      const data = { order: _.remove() };
      made.forEach((id) => {
        data[`items.${id}`] = _.remove();
      });
      if (empty) Object.assign(data, { checked: _.set({}), extras: _.set(extras) });
      return data;
    }
  );
}

// 撤单：回到下单前的样子，点的菜还在菜篮里
function cancelOrder() {
  if (!doc.current().order) return;
  doc.write(
    (p) => {
      p.order = null;
    },
    (_) => ({ order: _.remove() })
  );
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
  addMany,
  remove,
  drop,
  dropMany,
  finishMeal,
  clear,
  getOrder,
  placeOrder,
  cancelOrder,
  getPlan,
  toggleChecked,
  addExtra,
  removeExtra,
  updateBadge: () => updateBadge(),
};
