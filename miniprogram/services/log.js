// 做菜记录（打卡）：做完一道菜记一笔，包括成品照、好吃程度、心得、谁掌勺。
// 存在云数据库的 cook_logs 集合（每条记着是哪本小本本的）。菜的「做过几次」「上次做」是按这些记录算出来的（见 store.js）。
const cloud = require("./cloud");
const db = require("./db");
const store = require("./store");
const imageService = require("./image");
const planService = require("./plan");
const mealService = require("./meal");
const storage = require("../utils/storage");
const { normalizeLog } = require("../utils/log");

const COLLECTION = "cook_logs";
const COOK_NAME_KEY = "cook_name";

async function listLogs() {
  await store.ensureLoaded();
  return store.listLogs();
}

async function getLog(id) {
  await store.ensureLoaded();
  return store.getLog(id);
}

// 这台手机上次填的掌勺人，打卡时自动填上
function getCookName() {
  return storage.get(COOK_NAME_KEY) || "";
}

function toDoc(log) {
  const doc = Object.assign({}, log);
  delete doc._id;
  delete doc._openid;
  return doc;
}

// 打卡照片也设成这道菜的成品照。另外传一份，以后删这条记录不会把菜的封面一起删掉
async function setCover(dishId, tempPath) {
  const dish = store.getDish(dishId);
  if (!dish) return;
  const files = await imageService.uploadCover(tempPath);
  const now = Date.now();
  try {
    const res = await db.collection("dishes").doc(dishId).update({
      data: { cover: files.cover, coverThumb: files.thumb, updatedAt: now },
    });
    if (res.stats && res.stats.updated === 0) throw cloud.notWritten();
  } catch (err) {
    imageService.remove([files.cover, files.thumb]);
    throw cloud.explain(err);
  }
  imageService.remove([dish.cover, dish.coverThumb]);
  store.putDish(Object.assign(dish, { cover: files.cover, coverThumb: files.thumb, updatedAt: now }));
}

// 保存一条记录（新增或修改）。
// options.useAsCover：照片也设成菜的成品照；options.removeFromPlan：从菜篮里拿掉这道菜
async function saveLog(input, options = {}) {
  await store.ensureLoaded();
  const old = input._id ? store.getLog(input._id) : null;
  const log = normalizeLog(Object.assign({}, old, input, { updatedAt: Date.now() }));
  if (!log.dishId) throw new Error("先选一道菜");
  const dish = store.getDish(log.dishId);
  if (dish) log.dishName = dish.name;
  const tempPhoto = log.photo && !imageService.isCloudFile(log.photo) ? log.photo : "";
  const uploaded = [];
  const col = db.collection(COLLECTION);
  try {
    if (tempPhoto) {
      const files = await imageService.uploadCover(tempPhoto, "logs");
      uploaded.push(files.cover, files.thumb);
      log.photo = files.cover;
      log.photoThumb = files.thumb;
    } else if (!log.photo) {
      log.photoThumb = "";
    }
    if (old) {
      const res = await col.doc(log._id).update({ data: toDoc(log) });
      if (res.stats && res.stats.updated === 0) throw cloud.notWritten();
    } else {
      const res = await col.add({ data: toDoc(log) });
      log._id = res._id;
    }
  } catch (err) {
    imageService.remove(uploaded);
    throw cloud.explain(err);
  }
  if (old) {
    const keep = [log.photo, log.photoThumb];
    imageService.remove([old.photo, old.photoThumb].filter((f) => keep.indexOf(f) < 0));
  }
  store.putLog(log);
  if (log.cook) {
    try {
      storage.set(COOK_NAME_KEY, log.cook);
    } catch (e) {}
  }
  if (options.useAsCover && tempPhoto) await setCover(log.dishId, tempPhoto).catch(() => {}); // 封面没设上不影响记录
  if (options.removeFromPlan) planService.drop(log.dishId);
  return log;
}

async function removeLog(id) {
  await store.ensureLoaded();
  const old = store.getLog(id);
  if (!old) return;
  let res;
  try {
    res = await db.collection(COLLECTION).doc(id).remove();
  } catch (err) {
    throw cloud.explain(err);
  }
  if (res.stats && res.stats.removed === 0) {
    // 没删掉：家人已经删了
    await store.sync().catch(() => {});
    if (store.getLog(id)) throw cloud.notWritten();
    return;
  }
  store.removeLog(id);
  imageService.remove([old.photo, old.photoThumb]);
  await mealService.removeIfEmpty(old.mealId); // 这一顿的菜都删光了，这一顿也删掉
}

module.exports = { listLogs, getLog, getCookName, saveLog, removeLog };
