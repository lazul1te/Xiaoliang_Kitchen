// 菜品数据的整理：统一格式、整理成页面好显示的样子、搜索匹配

const STATUS = {
  mastered: { text: "拿手菜", cls: "mastered" },
  learning: { text: "练习中", cls: "learning" },
  wish: { text: "想学", cls: "wish" },
};

const INGREDIENT_GROUPS = [
  { type: "main", label: "主料" },
  { type: "side", label: "辅料" },
  { type: "seasoning", label: "调料" },
];

const STATUS_KEYS = Object.keys(STATUS);
const INGREDIENT_TYPES = INGREDIENT_GROUPS.map((g) => g.type);

const text = (v) => (v === undefined || v === null ? "" : String(v)).trim();
const int = (v, min, max) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? min : Math.min(max, Math.max(min, n));
};
const list = (v) => (Array.isArray(v) ? v : []);

// 把一道菜整理成统一的格式：去掉空行和首尾空格、数字转成数字、缺的字段补上默认值。
// 保存表单、从云上读回来的数据都会过一遍，页面里就不用到处判断字段在不在。
function normalizeDish(d) {
  const now = Date.now();
  return {
    _id: text(d._id),
    name: text(d.name),
    categoryId: text(d.categoryId),
    cover: text(d.cover), // 成品照（大图），详情页用
    coverThumb: text(d.coverThumb), // 成品照（小图），菜单卡片用
    tags: list(d.tags)
      .map(text)
      .filter((t, i, arr) => t && arr.indexOf(t) === i),
    difficulty: int(d.difficulty, 1, 5),
    duration: int(d.duration, 0, 9999),
    servings: int(d.servings, 0, 99),
    status: STATUS_KEYS.indexOf(d.status) >= 0 ? d.status : "wish",
    ingredients: list(d.ingredients)
      .map((i) => ({
        name: text(i && i.name),
        amount: text(i && i.amount),
        unit: text(i && i.unit),
        type: INGREDIENT_TYPES.indexOf(i && i.type) >= 0 ? i.type : "main",
      }))
      .filter((i) => i.name),
    steps: list(d.steps)
      .map((s) => ({ text: text(s && s.text), image: text(s && s.image), timer: int(s && s.timer, 0, 86400) }))
      .filter((s) => s.text || s.image),
    tips: text(d.tips),
    cookCount: int(d.cookCount, 0, 999999),
    lastCookedAt: d.lastCookedAt || null,
    sample: !!d.sample, // 示例菜，「我的」里可以一起删掉
    createdAt: Number(d.createdAt) || now,
    updatedAt: Number(d.updatedAt) || now,
  };
}

// "2026-10-12"、时间戳或 Date → "10月12日"
function formatMonthDay(value) {
  if (!value) return "";
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value === "number") date = new Date(value);
  else date = new Date(String(value).replace(/-/g, "/")); // 换成 2026/10/12 再解析，iOS 上更稳
  if (isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

// 秒数 → "30 秒" / "2 分钟" / "1 分 30 秒" / "1 小时"
function formatSeconds(seconds) {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  return `${seconds} 秒`;
}

function statusOf(dish) {
  return STATUS[dish.status] || STATUS.wish;
}

// 菜单、今日页里的一张菜品卡片
function toCard(dish) {
  const status = statusOf(dish);
  return {
    _id: dish._id,
    name: dish.name,
    cover: dish.coverThumb || dish.cover,
    initial: dish.name.slice(0, 1), // 没有成品照时，用菜名第一个字当占位图
    meta: dish.tags
      .slice(0, 2)
      .concat(dish.duration > 0 ? [`${dish.duration} 分钟`] : [])
      .join(" · "),
    statusText: status.text,
    statusClass: status.cls,
    cookText: dish.cookCount > 0 ? `做过 ${dish.cookCount} 次` : "还没做过",
  };
}

// 详情页
function toDetail(dish) {
  const status = statusOf(dish);
  const difficulty = Math.max(0, Math.min(5, dish.difficulty || 0));
  const lastCooked = formatMonthDay(dish.lastCookedAt);
  return Object.assign({}, dish, {
    initial: dish.name.slice(0, 1),
    statusText: status.text,
    statusClass: status.cls,
    stars: "★".repeat(difficulty) + "☆".repeat(5 - difficulty),
    cookLine:
      dish.cookCount > 0
        ? `做过 ${dish.cookCount} 次` + (lastCooked ? ` · 上次 ${lastCooked}` : "")
        : "还没做过，等你第一次下厨",
    updatedText: formatMonthDay(dish.updatedAt), // 最近一次修改的日期，两个人一起改时方便看
    ingredientGroups: INGREDIENT_GROUPS.map((group) => ({
      type: group.type,
      label: group.label,
      items: dish.ingredients
        .filter((i) => (i.type || "main") === group.type)
        .map((i, index) => ({ key: index, name: i.name, amountText: `${i.amount}${i.unit}` })),
    })).filter((group) => group.items.length),
    steps: dish.steps.map((s, index) => ({
      key: index,
      text: s.text,
      image: s.image,
      timerText: s.timer > 0 ? formatSeconds(s.timer) : "",
    })),
  });
}

// 搜索：菜名、任意一样原料或标签里包含关键词就算匹配
function matchKeyword(dish, keyword) {
  return (
    dish.name.includes(keyword) ||
    dish.ingredients.some((i) => i.name.includes(keyword)) ||
    dish.tags.some((t) => t.includes(keyword))
  );
}

// 用量一格写完：「2个」「2 个」「1/2小勺」「1.5两」→ 数字和单位分开；「适量」「少许」「一把」整个当用量
function splitAmount(text) {
  const s = String(text || "").trim();
  const m = /^(\d+\/\d+|\d+(?:\.\d+)?)\s*(.*)$/.exec(s);
  return m ? { amount: m[1], unit: m[2].trim() } : { amount: s, unit: "" };
}

// 「10分钟」「1分30秒」「90秒」「1.5小时」「半小时」→ 秒；只写数字按分钟算
function parseDuration(v) {
  if (typeof v === "number") return v > 0 ? Math.round(v * 60) : 0;
  const s = String(v || "").trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60);
  const h = /(\d+(?:\.\d+)?)\s*(?:个)?小时/.exec(s);
  const m = /(\d+(?:\.\d+)?)\s*分/.exec(s);
  const sec = /(\d+)\s*秒/.exec(s);
  let total = (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (sec ? Number(sec[1]) : 0);
  if (/半小时/.test(s)) total += 1800;
  return Math.round(total);
}

module.exports = { normalizeDish, toCard, toDetail, matchKeyword, formatMonthDay, formatSeconds, splitAmount, parseDuration };
