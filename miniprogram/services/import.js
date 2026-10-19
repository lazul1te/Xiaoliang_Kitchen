// 数据导入：读「数据导出」生成的备份文件、整理好的菜谱文件（格式一样），
// 或者照着导入模板手写的文件（中文字段，见 docs/菜谱导入模板.json），把里面的菜谱和做菜记录加进来。
// - 已经有同名的菜就跳过，重复导入不会多出一份
// - 分类按名字对上，没有就新建
// - 文件里带的照片重新传到云存储；没带照片的，沿用原来的云文件 ID（同一个云环境里还能显示）
// - 做菜记录只导入能对上菜的，同一道菜、同一时间的记录已经有了就跳过（「做过几次」按记录算，不用另外改）
// - 开饭记下的每一顿：同一时间记的已经有了就跳过；做菜记录跟着换成新的那一顿
// - 库存、想吃清单按名字合并，已经有的不重复加
const cloud = require("./cloud");
const store = require("./store");
const dishService = require("./dish");
const categoryService = require("./category");
const imageService = require("./image");
const pantryService = require("./pantry");
const wishService = require("./wish");
const mealService = require("./meal");
const { normalizeLog, timeOf } = require("../utils/log");
const { normalizeMeal } = require("../utils/meal");
const { parseDuration } = require("../utils/dish");

const APP = "nashoucai-xiaobenben";
const FORMAT = 1;
const UNCATEGORIZED = "未分类";

const nameOf = (v) => String((v && v.name) || "").trim();

// ---------- 手写的导入模板（中文字段）→ 和导出文件一样的格式 ----------
const STATUS_NAMES = { 拿手菜: "mastered", 练习中: "learning", 想学: "wish" };
const INGREDIENT_KEYS = [
  ["主料", "main"],
  ["辅料", "side"],
  ["调料", "seasoning"],
];
const NUMBER = "(\\d+\\/\\d+|\\d+(?:\\.\\d+)?)";
const WORD_AMOUNT = /^(.+?)\s*(适量|少许|少量|若干|一点|一把|一小把|半个|半根|一个|一根)$/;

// 「土豆 2个」「番茄 2 个」「鸡蛋2个」「盐 适量」「葱 一把」→ { name, amount, unit, type }
// 末尾括号里的备注算在名字上：「干辣椒 2个（可选）」→ 名字「干辣椒（可选）」、2 个
function parseIngredient(text, type) {
  let s = String(text || "").trim();
  const note = /\s*([（(][^（）()]*[）)])$/.exec(s);
  if (note) s = s.slice(0, note.index).trim();
  const tail = note ? note[1] : "";
  let m = new RegExp(`^(.+?)\\s*${NUMBER}\\s*([^\\d\\s]*)$`).exec(s);
  if (m) return { name: m[1].trim() + tail, amount: m[2], unit: m[3], type };
  m = WORD_AMOUNT.exec(s) || /^(.+)\s+(\S+)$/.exec(s);
  if (m) return { name: m[1].trim() + tail, amount: m[2], unit: "", type };
  return { name: s + tail, amount: "", unit: "", type };
}

function stepOf(v) {
  if (v && typeof v === "object") return { text: String(v["步骤"] || v.text || "").trim(), image: "", timer: parseDuration(v["计时"]) };
  return { text: String(v || "").trim(), image: "", timer: 0 };
}

function fromTemplate(raw) {
  const categories = [];
  const catId = {};
  const dishes = raw["菜谱"]
    .filter((d) => d && String(d["菜名"] || "").trim())
    .map((d, i) => {
      const cat = String(d["分类"] || "").trim() || UNCATEGORIZED;
      if (!catId[cat]) {
        catId[cat] = `t-cat-${categories.length + 1}`;
        categories.push({ _id: catId[cat], name: cat, sort: categories.length + 1 });
      }
      const ingredients = [];
      INGREDIENT_KEYS.forEach(([key, type]) => {
        (Array.isArray(d[key]) ? d[key] : []).forEach((t) => {
          const item = parseIngredient(t, type);
          if (item.name) ingredients.push(item);
        });
      });
      return {
        _id: `t-${i + 1}`,
        name: String(d["菜名"]).trim(),
        categoryId: catId[cat],
        status: STATUS_NAMES[String(d["熟练度"] || "").trim()] || "wish",
        difficulty: parseInt(d["难度"], 10) || 0,
        duration: Math.round(parseDuration(d["用时"]) / 60),
        servings: parseInt(d["几人份"], 10) || 0,
        tags: (Array.isArray(d["标签"]) ? d["标签"] : []).map((t) => String(t).trim()).filter(Boolean),
        ingredients,
        steps: (Array.isArray(d["做法"]) ? d["做法"] : []).map(stepOf).filter((st) => st.text),
        tips: String(d["小贴士"] || "").trim(),
        cover: "",
      };
    });
  return { app: APP, format: FORMAT, categories, dishes, logs: [], photos: {} };
}

// 手写的文件常见小错：开头有 BOM（Windows 记事本）、最后一项后面多了逗号，这两种直接容忍；
// 别的错误告诉对方大概在第几行。what：「文件」或「复制的内容」，用在提示里
function parseJson(text, what) {
  const clean = String(text).replace(/^\uFEFF/, "");
  try {
    return JSON.parse(clean);
  } catch (e) {
    try {
      return JSON.parse(clean.replace(/,(\s*[}\]])/g, "$1"));
    } catch (e2) {
      const msg = e2.message || "";
      const lineNo = /line (\d+)/.exec(msg);
      const pos = /position (\d+)/.exec(msg);
      const n = lineNo ? Number(lineNo[1]) : pos ? clean.slice(0, Number(pos[1])).split("\n").length : 0;
      const line = n ? `（第 ${n} 行附近）` : "";
      throw new Error(`${what}格式不对${line}：检查一下引号、逗号、冒号是不是英文半角的，有没有少写逗号`);
    }
  }
}

// 读文件、检查格式，返回 { data, summary }
async function readFile(path) {
  let text;
  try {
    text = wx.getFileSystemManager().readFileSync(path, "utf8");
  } catch (e) {
    throw new Error("文件打不开，可能不是完整的 .json 文件");
  }
  return inspect(parseJson(text, "文件"));
}

// 粘贴导入：复制的文字（备份文件、导入模板的内容），返回 { data, summary }
async function readText(text) {
  if (!String(text || "").trim()) throw new Error("剪贴板里是空的：先把要导入的内容全选复制，再来点「粘贴」");
  return inspect(parseJson(text, "复制的内容"));
}

async function inspect(raw) {
  let data = raw;
  if (data && Array.isArray(data["菜谱"])) data = fromTemplate(data);
  if (!data || data.app !== APP || !Array.isArray(data.dishes)) {
    throw new Error("这不是「拿手菜小本本」的数据：要用「备份到微信」生成的文件，或者照着导入模板写的菜谱");
  }
  if (data.format > FORMAT) throw new Error("这个文件是更新的版本生成的，先把小程序更新到最新再导入");
  await store.ensureLoaded();
  const existing = {};
  store.listDishes().forEach((d) => {
    existing[d.name] = true;
  });
  const dishes = data.dishes.filter((d) => nameOf(d));
  const skipNames = dishes.filter((d) => existing[nameOf(d)]).map(nameOf);
  return {
    data,
    summary: {
      dishCount: dishes.length,
      newCount: dishes.length - skipNames.length,
      skipNames,
      logCount: Array.isArray(data.logs) ? data.logs.length : 0,
      photoCount: Object.keys(data.photos || {}).length,
    },
  };
}

// 导入。onProgress(文字) 用来在页面上显示进度。
// 返回 { added, skipped, logsAdded, logsError }
async function importData(data, onProgress) {
  const progress = onProgress || (() => {});
  await store.ensureLoaded();
  const fs = wx.getFileSystemManager();
  const photos = data.photos || {};
  const temps = [];

  // 文件里的照片是 base64，先写成手机上的文件，后面保存菜、记录时会传到云存储
  const toLocal = (ref) => {
    if (!ref) return "";
    if (photos[ref]) {
      const path = `${wx.env.USER_DATA_PATH}/import-${temps.length}.jpg`;
      fs.writeFileSync(path, photos[ref], "base64");
      temps.push(path);
      return path;
    }
    return imageService.isCloudFile(ref) ? ref : "";
  };

  try {
    // 1. 分类：按文件里的顺序，补齐还没有的
    const fileCats = (data.categories || []).filter(nameOf).sort((a, b) => (a.sort || 0) - (b.sort || 0));
    const catName = {};
    fileCats.forEach((c) => {
      catName[c._id] = nameOf(c);
    });
    const existingNames = {};
    store.listDishes().forEach((d) => {
      existingNames[d.name] = d._id;
    });
    const dishes = data.dishes.filter(nameOf);
    const toAdd = dishes.filter((d) => !existingNames[nameOf(d)]);
    const needed = {};
    toAdd.forEach((d) => {
      needed[catName[d.categoryId] || UNCATEGORIZED] = true;
    });
    const names = fileCats.map(nameOf).concat(UNCATEGORIZED).filter((n, i, arr) => needed[n] && arr.indexOf(n) === i);
    const categories = names.length ? await categoryService.ensureCategories(names) : store.listCategories();
    const catIdByName = {};
    categories.forEach((c) => {
      catIdByName[c.name] = c._id;
    });

    // 2. 菜谱
    const idMap = {}; // 文件里的菜 id → 现在的菜 id
    let added = 0;
    for (let i = 0; i < dishes.length; i++) {
      const d = dishes[i];
      const name = nameOf(d);
      if (existingNames[name]) {
        idMap[d._id] = existingNames[name];
        continue;
      }
      progress(`正在导入第 ${i + 1}/${dishes.length} 道菜：${name}`);
      const saved = await dishService.saveDish(
        Object.assign({}, d, {
          _id: "",
          categoryId: catIdByName[catName[d.categoryId] || UNCATEGORIZED],
          cover: toLocal(d.cover),
          coverThumb: "",
          steps: (d.steps || []).map((s) => Object.assign({}, s, { image: toLocal(s && s.image) })),
        })
      );
      idMap[d._id] = saved._id;
      existingNames[name] = saved._id;
      added += 1;
    }

    // 3. 每一顿：菜对得上的才导入；同一时间记的已经有了就用那一顿
    const mealMap = {}; // 文件里这一顿的 id → 现在的 id
    const meals = Array.isArray(data.meals) ? data.meals : [];
    let mealsError = "";
    for (let i = 0; i < meals.length; i++) {
      const m = normalizeMeal(meals[i] || {});
      const items = m.items.map((it) => Object.assign({}, it, { dishId: idMap[it.dishId] })).filter((it) => it.dishId);
      if (!items.length) continue;
      const same = store.listMeals().find((x) => x.createdAt === m.createdAt && x.date === m.date);
      if (same) {
        mealMap[m._id] = same._id;
        continue;
      }
      progress(`正在导入第 ${i + 1}/${meals.length} 顿饭`);
      try {
        const meal = normalizeMeal(Object.assign({}, m, { _id: mealService.newMealId(), items }));
        const photo = toLocal(m.photo);
        if (photo && !imageService.isCloudFile(photo)) {
          const files = await imageService.uploadCover(photo, "logs");
          meal.photo = files.cover;
          meal.photoThumb = files.thumb;
        } else {
          meal.photo = photo;
          meal.photoThumb = "";
        }
        await cloud.collection("meals").add({ data: meal });
        store.putMeal(meal);
        mealMap[m._id] = meal._id;
      } catch (err) {
        mealsError = cloud.explain(err, "meals").message; // 比如 meals 集合还没建：记录照样导入，只是不按顿合在一起
        break;
      }
    }

    // 4. 做菜记录
    const logs = Array.isArray(data.logs) ? data.logs : [];
    let logsAdded = 0;
    let logsError = "";
    for (let i = 0; i < logs.length; i++) {
      const l = logs[i];
      const dishId = idMap[l && l.dishId];
      if (!dishId) continue;
      const cookedAt = timeOf(l.cookedAt);
      const dup = store.listLogs().some((x) => x.dishId === dishId && Math.abs(x.cookedAt - cookedAt) < 60 * 1000);
      if (dup) continue;
      progress(`正在导入做菜记录 ${i + 1}/${logs.length}`);
      try {
        const dish = store.getDish(dishId);
        const log = normalizeLog(Object.assign({}, l, { _id: "", dishId, dishName: dish ? dish.name : l.dishName, mealId: mealMap[l.mealId] || "" }));
        const photo = toLocal(l.photo);
        if (photo && !imageService.isCloudFile(photo)) {
          const files = await imageService.uploadCover(photo, "logs");
          log.photo = files.cover;
          log.photoThumb = files.thumb;
        } else {
          log.photo = photo;
          log.photoThumb = "";
        }
        const doc = Object.assign({}, log);
        delete doc._id;
        const res = await cloud.collection("cook_logs").add({ data: doc });
        log._id = res._id;
        store.putLog(log);
        logsAdded += 1;
      } catch (err) {
        logsError = cloud.explain(err, "cook_logs").message; // 比如 cook_logs 集合还没建：菜已经导进来了，记录以后可以再导
        break;
      }
    }

    // 5. 库存：家里有的加进来（已经有的不动）
    const pantry = data.pantry || {};
    const inStock = Object.keys(pantry)
      .map((k) => pantry[k])
      .filter((i) => i && i.name && i.inStock !== false)
      .map((i) => i.name);
    if (inStock.length) pantryService.add(inStock);

    // 6. 想吃清单：同名的已经有了就跳过；文件里的菜已经写成菜谱的也不用再加
    const wishNames = {};
    wishService.list().forEach((w) => {
      wishNames[w.name] = true;
    });
    const wishes = (Array.isArray(data.wishes) ? data.wishes : []).filter((w) => nameOf(w) && !wishNames[nameOf(w)] && !existingNames[nameOf(w)]);
    for (let i = 0; i < wishes.length; i++) {
      progress(`正在导入想吃清单 ${i + 1}/${wishes.length}`);
      await wishService.save({ name: nameOf(wishes[i]), photo: toLocal(wishes[i].photo), note: wishes[i].note });
    }

    return { added, skipped: dishes.length - added, logsAdded, logsError: logsError || mealsError };
  } finally {
    temps.forEach((p) => {
      try {
        fs.unlinkSync(p);
      } catch (e) {}
    });
  }
}

module.exports = { readFile, readText, importData, parseIngredient };
