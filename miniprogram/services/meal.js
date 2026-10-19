// 开饭：把这一顿记下来。存在云数据库的 meals 集合（两个人共用），一顿饭一条：哪天、哪一顿、点菜单编号、
// 做了哪些菜、整桌照片、心得；每道做了的菜另外在 cook_logs 里各记一条（带 mealId），「做过几次」、日历照常按记录算。
// 做了的菜从菜篮拿掉，点菜单收起来（见 plan.js 的 finishMeal）。
const cloud = require("./cloud");
const store = require("./store");
const imageService = require("./image");
const planService = require("./plan");
const { newId } = require("../utils/id");
const { normalizeLog, dateValue, dateToTime } = require("../utils/log");
const { normalizeMeal } = require("../utils/meal");

const COLLECTION = "meals";
let focusDate = ""; // 刚记好的那天，记录页打开时直接选中它

async function listMeals() {
  await store.ensureLoaded();
  return store.listMeals();
}

// 这一顿的 id：在开饭页打开时就定好，网络不好重试时用同一个，不会记两遍
function newMealId() {
  return `meal${newId()}`;
}

const toDoc = (item) => {
  const doc = Object.assign({}, item);
  delete doc._openid;
  return doc;
};

const isDuplicate = (err) => /duplicate|dup key/i.test((err && (err.errMsg || err.message)) || String(err));

// 加一条记录，_id 是自己定的。已经有了（上次其实存上了）就算成功
async function addOnce(name, item) {
  try {
    await cloud.collection(name).add({ data: toDoc(item) });
  } catch (err) {
    if (isDuplicate(err) && (await cloud.findOne(name, item._id))) return;
    throw err;
  }
}

// 记下这一顿。input：
//   mealId（newMealId() 生成的）、date "2026-10-19"、meal 哪一顿、cook 掌勺、note 心得、photo 整桌照片（手机上的临时文件）、
//   order 点菜单（plan.js 的 getOrder()，没下单是 null）、dishes [{ dishId, qty, rating }]（做了的菜）
// 先存每道菜的记录，最后存这一顿：中途失败了，照片还没有记录用到，可以放心删掉；重试时已经存上的会跳过。
// 返回 { meal, logs }
async function finish(input) {
  await store.ensureLoaded();
  const dishes = input.dishes.filter((d) => store.getDish(d.dishId));
  if (!dishes.length) throw new Error("勾上这顿做了的菜");
  const order = input.order || null;
  const now = Date.now();
  // 今天的用现在的时间，以前的日子记在那天中午（跟补记一样）
  const cookedAt = input.date === dateValue(now) ? now : dateToTime(input.date);
  const meal = normalizeMeal({
    _id: input.mealId,
    no: order ? order.no : 0,
    date: dateValue(cookedAt),
    meal: input.meal,
    items: dishes.map((d) => ({ dishId: d.dishId, dishName: store.getDish(d.dishId).name, qty: d.qty })),
    flavors: order ? order.flavors : [],
    note: input.note,
    orderedBy: order ? order.orderedBy : "",
    cook: input.cook,
    createdAt: now,
    updatedAt: now,
  });
  const logs = dishes.map((d, i) =>
    normalizeLog({
      _id: `${meal._id}-${i + 1}`,
      dishId: d.dishId,
      dishName: store.getDish(d.dishId).name,
      cookedAt,
      rating: d.rating,
      cook: input.cook,
      mealId: meal._id,
      createdAt: now + i, // 同一顿的记录按点菜的顺序排
      updatedAt: now,
    })
  );
  const uploaded = [];
  let writing = "cook_logs";
  try {
    if (input.photo && !imageService.isCloudFile(input.photo)) {
      const files = await imageService.uploadCover(input.photo, "logs");
      uploaded.push(files.cover, files.thumb);
      meal.photo = files.cover;
      meal.photoThumb = files.thumb;
    }
    await Promise.all(logs.map((l) => addOnce("cook_logs", l)));
    writing = COLLECTION;
    await addOnce(COLLECTION, meal);
  } catch (err) {
    imageService.remove(uploaded);
    store.sync().catch(() => {}); // 可能存上了一部分，以云上的为准
    throw cloud.explain(err, writing);
  }
  store.putMeal(meal);
  logs.forEach((l) => store.putLog(l));
  planService.finishMeal(dishes.map((d) => d.dishId));
  focusDate = meal.date;
  return { meal, logs };
}

// 一顿饭的记录都删光了：这一顿和它的整桌照片也删掉（log.js 删记录时调用）
async function removeIfEmpty(mealId) {
  if (!mealId || store.listLogs().some((l) => l.mealId === mealId)) return;
  const meal = store.getMeal(mealId);
  if (!meal) return;
  try {
    await cloud.collection(COLLECTION).doc(mealId).remove();
  } catch (err) {
    return; // 删不掉也不影响使用，记录页不会显示没有菜的一顿
  }
  store.removeMeal(mealId);
  imageService.remove([meal.photo, meal.photoThumb]);
}

// 记录页打开时选中刚记好的那天（只用一次）
function takeFocusDate() {
  const date = focusDate;
  focusDate = "";
  return date;
}

module.exports = { listMeals, newMealId, finish, removeIfEmpty, takeFocusDate };
