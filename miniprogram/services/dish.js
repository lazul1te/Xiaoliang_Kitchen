// 菜品的增删改查，页面只调这里。数据存在云数据库的 dishes 集合（两个人共用），照片存在云存储。
const cloud = require("./cloud");
const store = require("./store");
const imageService = require("./image");
const categoryService = require("./category");
const planService = require("./plan");
const pantryService = require("./pantry");
const wishService = require("./wish");
const samples = require("../data/samples");
const { normalizeDish } = require("../utils/dish");

const COLLECTION = "dishes";
const STALE_MS = 15 * 1000; // 回到页面时，离上次同步超过 15 秒就去云上看看对方有没有改过

// 两个人共用的几条记录：菜篮、库存、想吃清单（都在 plans 集合里）
const SHARED = [planService, pantryService, wishService];

// 数据版本号（菜谱 + 共用记录）：页面 onShow 时跟上次比一比，变了就重新读
function getVersion() {
  return [store.getVersion()].concat(SHARED.map((s) => s.getVersion())).join("-");
}

// 等云上的最新数据回来（打开小程序时先显示的可能是上次的缓存）。共用记录取不到不影响看菜谱
function refresh() {
  return Promise.all([store.whenFresh()].concat(SHARED.map((s) => s.whenFresh().catch(() => false))));
}

// 回到页面时调用：隔了一会儿就在后台同步一次。返回有没有变，失败了当作没变
function refreshIfStale() {
  return Promise.all(
    [store.syncIfStale(STALE_MS)].concat(SHARED.map((s) => s.syncIfStale(STALE_MS))).map((p) => p.catch(() => false))
  ).then((changed) => changed.some(Boolean));
}

// 下拉刷新：马上去云上取。出错时报错里会写明是哪个集合
function sync() {
  return Promise.all([store.sync()].concat(SHARED.map((s) => s.sync()))).then((changed) => changed.some(Boolean));
}

async function listDishes() {
  await store.ensureLoaded();
  return store.listDishes();
}

async function getDish(id) {
  await store.ensureLoaded();
  let dish = store.getDish(id);
  if (!dish && !store.isFresh()) {
    // 缓存里没有，可能是对方刚加的，等云上的数据回来再找一次
    await store.whenFresh().catch(() => {});
    dish = store.getDish(id);
  }
  return dish;
}

// 存进数据库的字段：_id 由数据库生成，_openid 由云开发自动加上
function toDoc(dish) {
  const doc = Object.assign({}, dish);
  delete doc._id;
  delete doc._openid;
  return doc;
}

// 一道菜用到的所有云存储照片
function filesOf(dish) {
  return [dish.cover, dish.coverThumb].concat(dish.steps.map((s) => s.image)).filter(imageService.isCloudFile);
}

// 保存时发现对方刚改过这道菜，页面会问要不要覆盖
function conflictError() {
  const e = new Error("这道菜刚被改过");
  e.code = "CONFLICT";
  e.friendly = true;
  return e;
}

// 保存（新增或修改）。表单里新选的照片还在手机上，这里先传到云存储，再写数据库；
// 换掉或删掉的旧照片顺手从云存储删除，免得占空间。
// options.baseUpdatedAt：打开编辑页时这道菜的修改时间，用来判断这期间对方有没有改过；
// options.force：对方改过也直接覆盖
async function saveDish(input, options = {}) {
  await store.ensureLoaded();
  const col = cloud.collection(COLLECTION);
  let old = null;
  if (input._id) {
    // 两个人共用：保存前先看看云上这道菜还在不在、有没有被对方改过
    const remote = await cloud.findOne(COLLECTION, input._id);
    if (!remote) {
      store.sync().catch(() => {});
      throw new Error("这道菜已经被删掉了，可能是对方刚删的");
    }
    const base = options.baseUpdatedAt !== undefined ? options.baseUpdatedAt : (store.getDish(input._id) || {}).updatedAt;
    if (!options.force && Number(remote.updatedAt) !== Number(base)) {
      store.sync().catch(() => {});
      throw conflictError();
    }
    old = normalizeDish(remote); // 表单里没有的字段（小图、做过几次等）以云上的为准
  }
  // 改过的示例菜就算你们自己的了，不再跟着「删除示例菜」一起删
  const dish = normalizeDish(Object.assign({}, old, input, { sample: false, updatedAt: Date.now() }));
  if (!dish.name) throw new Error("菜名不能是空的");
  const uploaded = [];
  try {
    if (dish.cover && !imageService.isCloudFile(dish.cover)) {
      const files = await imageService.uploadCover(dish.cover);
      uploaded.push(files.cover, files.thumb);
      dish.cover = files.cover;
      dish.coverThumb = files.thumb;
    } else if (!dish.cover) {
      dish.coverThumb = "";
    }
    await Promise.all(
      dish.steps.map(async (step) => {
        if (!step.image || imageService.isCloudFile(step.image)) return;
        step.image = await imageService.uploadPhoto(step.image);
        uploaded.push(step.image);
      })
    );
    if (old) {
      const doc = toDoc(dish);
      // 数组字段明确地整个替换，保证删掉的原料、步骤不会留在旧记录里
      const _ = cloud.command();
      ["tags", "ingredients", "steps"].forEach((key) => {
        doc[key] = _.set(doc[key]);
      });
      const res = await col.doc(dish._id).update({ data: doc });
      if (res.stats && res.stats.updated === 0) throw cloud.notWritten();
    } else {
      const res = await col.add({ data: toDoc(dish) });
      dish._id = res._id;
    }
  } catch (err) {
    imageService.remove(uploaded);
    throw cloud.explain(err, COLLECTION);
  }
  if (old) {
    const keep = filesOf(dish);
    imageService.remove(filesOf(old).filter((f) => keep.indexOf(f) < 0));
  }
  store.putDish(dish);
  return dish;
}

async function removeDish(id) {
  await store.ensureLoaded();
  const old = store.getDish(id);
  let res;
  try {
    res = await cloud.collection(COLLECTION).doc(id).remove();
  } catch (err) {
    throw cloud.explain(err);
  }
  if (res.stats && res.stats.removed === 0) {
    // 没删掉：要么对方已经删了（那就算删好了），要么集合权限不允许删对方加的菜
    await store.sync().catch(() => {});
    if (store.getDish(id)) throw cloud.notWritten();
  } else {
    store.removeDish(id);
  }
  planService.drop(id);
  if (old) imageService.remove(filesOf(old));
}

// 欢迎页上点「放几道示例菜」：补齐示例用到的分类，再存进 11 道示例菜（带 sample 标记）
async function importSamples() {
  const categories = await categoryService.ensureCategories(samples.categories.map((c) => c.name));
  const idByName = {};
  categories.forEach((c) => {
    idByName[c.name] = c._id;
  });
  const nameBySampleId = {};
  samples.categories.forEach((c) => {
    nameBySampleId[c._id] = c.name;
  });
  const now = Date.now();
  const dishes = samples.dishes.map((d, i) =>
    normalizeDish(
      Object.assign({}, d, {
        _id: "",
        categoryId: idByName[nameBySampleId[d.categoryId]],
        sample: true,
        createdAt: now + i, // 保持示例菜原来的先后顺序
        updatedAt: now + i,
      })
    )
  );
  const col = cloud.collection(COLLECTION);
  try {
    const results = await Promise.all(dishes.map((d) => col.add({ data: toDoc(d) })));
    results.forEach((res, i) => {
      dishes[i]._id = res._id;
      store.putDish(dishes[i]);
    });
  } catch (err) {
    store.sync().catch(() => {}); // 可能存进去了一部分，重新同步一下
    throw cloud.explain(err);
  }
  return dishes.length;
}

// 删除全部示例菜（「我的」页里用），两个人的菜单里都会删掉。自己加的菜、改过的示例菜不会删
async function removeSamples() {
  await store.ensureLoaded();
  const list = store.listDishes().filter((d) => d.sample);
  const col = cloud.collection(COLLECTION);
  let results;
  try {
    results = await Promise.all(list.map((d) => col.doc(d._id).remove()));
  } catch (err) {
    store.sync().catch(() => {});
    throw cloud.explain(err);
  }
  const missed = results.some((res) => res.stats && res.stats.removed === 0);
  list.forEach((d, i) => {
    if (!(results[i].stats && results[i].stats.removed === 0)) store.removeDish(d._id);
  });
  if (missed) await store.sync().catch(() => {});
  list.forEach((d) => {
    if (store.getDish(d._id)) return;
    planService.drop(d._id);
    imageService.remove(filesOf(d));
  });
  if (list.some((d) => store.getDish(d._id))) throw cloud.notWritten();
  return list.length;
}

module.exports = {
  getVersion,
  refresh,
  refreshIfStale,
  sync,
  listDishes,
  getDish,
  saveDish,
  removeDish,
  importSamples,
  removeSamples,
};
