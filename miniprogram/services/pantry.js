// 库存：家里常备的东西（调料、米面、干货……），两个人共用，存在 plans 集合里 _id 为 pantry 的记录。
//   items  { key: { name, inStock, updatedAt } }    inStock：false 表示用完了，买菜清单里会提醒
// 买菜清单会自动对比库存：家里有的不再提醒买。
const { createSharedDoc } = require("./shared-doc");
const { baseName, keyOf } = require("../utils/shopping");

// 一键加入的常用调料
const COMMON_SEASONINGS = [
  "盐", "白糖", "生抽", "老抽", "蚝油", "料酒", "醋", "香油",
  "食用油", "白胡椒粉", "淀粉", "鸡精", "八角", "花椒", "干辣椒", "五香粉",
];

function normalize(doc) {
  const p = { items: {} };
  const items = (doc && doc.items) || {};
  Object.keys(items).forEach((key) => {
    const it = items[key];
    if (it && it.name) p.items[key] = { name: String(it.name), inStock: it.inStock !== false, updatedAt: Number(it.updatedAt) || 0 };
  });
  return p;
}

const doc = createSharedDoc({ id: "pantry", cacheKey: "pantry_cache", label: "库存", normalize });

// { key: { name, inStock } }，买菜清单对比用
function getItems() {
  return JSON.parse(JSON.stringify(doc.current().items));
}

// 列表：家里有的、用完了的，各自按名字排
function list() {
  const items = doc.current().items;
  const all = Object.keys(items).map((key) => Object.assign({ key }, items[key]));
  const byName = (a, b) => a.name.localeCompare(b.name, "zh");
  return { inStock: all.filter((i) => i.inStock).sort(byName), outOfStock: all.filter((i) => !i.inStock).sort(byName) };
}

// 加进库存（已经有的就标成「有」）。names 可以是一个名字或者一组名字；返回加了几样
function add(names) {
  const items = doc.current().items;
  const now = Date.now();
  const added = {};
  [].concat(names).forEach((n) => {
    const name = baseName(n);
    const key = keyOf(name);
    if (!name || (items[key] && items[key].inStock) || added[key]) return;
    added[key] = { name: (items[key] && items[key].name) || name, inStock: true, updatedAt: now };
  });
  const keys = Object.keys(added);
  if (!keys.length) return 0;
  doc.write(
    (p) => {
      keys.forEach((key) => {
        p.items[key] = added[key];
      });
    },
    (_) => {
      const data = {};
      keys.forEach((key) => {
        data[`items.${key}`] = _.set(added[key]);
      });
      return data;
    }
  );
  return keys.length;
}

// 用完了 / 补上了
function setInStock(key, inStock) {
  const item = doc.current().items[key];
  if (!item) return;
  doc.write(
    (p) => {
      p.items[key].inStock = inStock;
      p.items[key].updatedAt = Date.now();
    },
    () => ({ [`items.${key}.inStock`]: inStock, [`items.${key}.updatedAt`]: Date.now() })
  );
}

function remove(key) {
  doc.write(
    (p) => {
      delete p.items[key];
    },
    (_) => ({ [`items.${key}`]: _.remove() })
  );
}

module.exports = {
  COMMON_SEASONINGS,
  getVersion: doc.getVersion,
  sync: doc.sync,
  whenFresh: doc.whenFresh,
  syncIfStale: doc.syncIfStale,
  getItems,
  list,
  add,
  setInStock,
  remove,
};
