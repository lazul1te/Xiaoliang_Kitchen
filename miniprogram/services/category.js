// 分类：新建、改名、删除、调整顺序（顺序就是菜单左边的顺序）。存在云数据库的 categories 集合（每本小本本各有一套）
const cloud = require("./cloud");
const db = require("./db");
const store = require("./store");
const samples = require("../data/samples");

const COLLECTION = "categories";
const MAX_NAME = 8;
const DEFAULT_NAMES = samples.categories.map((c) => c.name); // 家常菜、硬菜、汤羹、凉菜、主食

async function listCategories() {
  await store.ensureLoaded();
  return store.listCategories();
}

// 分类管理页用：带上每个分类里有几道菜
async function listWithCount() {
  await store.ensureLoaded();
  const dishes = store.listDishes();
  return store
    .listCategories()
    .map((c) => Object.assign(c, { count: dishes.filter((d) => d.categoryId === c._id).length }));
}

function checkName(name, list, exceptId) {
  const n = String(name || "").trim();
  if (!n) throw new Error("分类名不能是空的");
  if (n.length > MAX_NAME) throw new Error(`分类名最多 ${MAX_NAME} 个字`);
  if (list.some((c) => c.name === n && c._id !== exceptId)) throw new Error(`已经有「${n}」这个分类了`);
  return n;
}

function nextSort(list) {
  return list.reduce((max, c) => Math.max(max, c.sort), 0) + 1;
}

// 写云数据库；失败的话把报错翻成人话，并在后台重新同步一次，免得手机上和云上对不上。
// 改名、删除、调顺序如果返回「改了 0 条」，也算失败（家人刚删掉了）
async function write(task) {
  let res;
  try {
    res = await task();
  } catch (err) {
    store.sync().catch(() => {});
    throw cloud.explain(err);
  }
  const list = Array.isArray(res) ? res : [res];
  if (list.some((r) => r && r.stats && (r.stats.updated === 0 || r.stats.removed === 0))) {
    store.sync().catch(() => {});
    throw cloud.notWritten();
  }
  return res;
}

async function addCategory(name) {
  await store.ensureLoaded();
  const list = store.listCategories();
  const category = { name: checkName(name, list), sort: nextSort(list), createdAt: Date.now() };
  const res = await write(() => db.collection(COLLECTION).add({ data: category }));
  category._id = res._id;
  store.setCategories(list.concat(category));
  return category;
}

// 按名字补齐分类，已经有的不重复建。返回全部分类
async function ensureCategories(names) {
  await store.ensureLoaded();
  const list = store.listCategories();
  const missing = names.filter((n) => !list.some((c) => c.name === n));
  if (missing.length) {
    const start = nextSort(list);
    const now = Date.now();
    const added = missing.map((name, i) => ({ name, sort: start + i, createdAt: now + i }));
    const col = db.collection(COLLECTION);
    const results = await write(() => Promise.all(added.map((c) => col.add({ data: c }))));
    results.forEach((res, i) => {
      added[i]._id = res._id;
    });
    store.setCategories(list.concat(added));
  }
  return store.listCategories();
}

async function renameCategory(id, name) {
  await store.ensureLoaded();
  const list = store.listCategories();
  const target = list.find((c) => c._id === id);
  if (!target) throw new Error("这个分类已经不在了");
  target.name = checkName(name, list, id);
  await write(() => db.collection(COLLECTION).doc(id).update({ data: { name: target.name } }));
  store.setCategories(list);
}

async function removeCategory(id) {
  await store.ensureLoaded();
  const count = store.listDishes().filter((d) => d.categoryId === id).length;
  if (count) throw new Error(`这个分类里还有 ${count} 道菜，先把它们改到别的分类再删`);
  await write(() => db.collection(COLLECTION).doc(id).remove());
  store.setCategories(store.listCategories().filter((c) => c._id !== id));
}

// 上移（delta = -1）或下移（delta = 1）一格：重新编号，只更新编号变了的分类
async function moveCategory(id, delta) {
  await store.ensureLoaded();
  const list = store.listCategories();
  const i = list.findIndex((c) => c._id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  list.splice(j, 0, list.splice(i, 1)[0]);
  const changed = [];
  list.forEach((c, index) => {
    if (c.sort !== index + 1) {
      c.sort = index + 1;
      changed.push(c);
    }
  });
  const col = db.collection(COLLECTION);
  await write(() => Promise.all(changed.map((c) => col.doc(c._id).update({ data: { sort: c.sort } }))));
  store.setCategories(list);
}

module.exports = {
  DEFAULT_NAMES,
  listCategories,
  listWithCount,
  addCategory,
  ensureCategories,
  renameCategory,
  removeCategory,
  moveCategory,
};
