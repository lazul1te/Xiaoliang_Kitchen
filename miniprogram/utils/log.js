// 做菜记录的整理：统一格式、日期换算、记录页按月份和日期分组

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const text = (v) => (v === undefined || v === null ? "" : String(v)).trim();
const int = (v, min, max) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? min : Math.min(max, Math.max(min, n));
};
const pad = (n) => (n < 10 ? `0${n}` : String(n));

// "2026-10-12"、时间戳或 Date → 时间戳；认不出来返回 0
function timeOf(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const t = new Date(String(value).replace(/-/g, "/")).getTime(); // 换成 2026/10/12 再解析，iOS 上更稳
  return isNaN(t) ? 0 : t;
}

// 时间戳 → "2026-10-17"（日期选择器用）
function dateValue(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 日期选择器的 "2026-10-17" → 时间戳。选的是今天就用现在的时间，别的日期取当天中午
function dateToTime(value) {
  if (value === dateValue(Date.now())) return Date.now();
  const t = timeOf(value);
  return t ? t + 12 * 3600 * 1000 : Date.now();
}

// 把一条做菜记录整理成统一的格式
function normalizeLog(l) {
  const now = Date.now();
  return {
    _id: text(l._id),
    dishId: text(l.dishId),
    dishName: text(l.dishName), // 记下当时的菜名，菜被删了记录也还看得懂
    cookedAt: timeOf(l.cookedAt) || now,
    photo: text(l.photo), // 成品照（大图）
    photoThumb: text(l.photoThumb), // 成品照（小图），记录页用
    rating: int(l.rating, 0, 5), // 好吃程度，0 表示没打分
    note: text(l.note), // 心得
    cook: text(l.cook), // 掌勺的人
    mealId: text(l.mealId), // 开饭时一起记的：属于哪一顿（meals 集合），单独打卡的是空的
    createdAt: Number(l.createdAt) || now,
    updatedAt: Number(l.updatedAt) || now,
  };
}

// 新的在前
function sortLogs(list) {
  return list.slice().sort((a, b) => b.cookedAt - a.cookedAt || b.createdAt - a.createdAt);
}

function dayText(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`;
}

// 记录页、详情页里的一条记录。meals：{ mealId: 一顿饭 }，这条记录自己没有照片时用那顿饭的整桌照片
function toLogCard(log, dishNames, meals) {
  const name = (dishNames && dishNames[log.dishId]) || log.dishName || "这道菜已经删掉了";
  const meal = meals && log.mealId ? meals[log.mealId] : null;
  return {
    _id: log._id,
    dishId: log.dishId,
    dishName: name,
    mealId: log.mealId,
    initial: name.slice(0, 1), // 没有照片时，用菜名第一个字当占位图
    photo: log.photoThumb || log.photo || (meal ? meal.photoThumb || meal.photo : ""),
    stars: log.rating ? "★".repeat(log.rating) + "☆".repeat(5 - log.rating) : "",
    note: log.note,
    cook: log.cook,
    dayText: dayText(log.cookedAt),
  };
}

// 按月份、再按日期分组：[{ key, title, count, days: [{ key, title, logs: [卡片] }] }]
// logs 要先按时间倒序排好；meals 见 toLogCard
function groupByMonth(logs, dishNames, meals) {
  const months = [];
  logs.forEach((log) => {
    const d = new Date(log.cookedAt);
    const monthKey = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    let month = months[months.length - 1];
    if (!month || month.key !== monthKey) {
      month = { key: monthKey, title: monthKey, count: 0, days: [] };
      months.push(month);
    }
    const dayKey = dayText(log.cookedAt);
    let day = month.days[month.days.length - 1];
    if (!day || day.key !== dayKey) {
      day = { key: dayKey, title: dayKey, logs: [] };
      month.days.push(day);
    }
    day.logs.push(toLogCard(log, dishNames, meals));
    month.count += 1;
  });
  return months;
}

// 做饭日历：某个月的格子，一周一行（周一开头），每天带上那天做了几道菜。month 是 0～11
function buildMonth(year, month, logs) {
  const counts = {};
  logs.forEach((l) => {
    const k = dateValue(l.cookedAt);
    counts[k] = (counts[k] || 0) + 1;
  });
  const prefix = `${year}-${pad(month + 1)}-`;
  const today = dateValue(Date.now());
  const lead = (new Date(year, month, 1).getDay() + 6) % 7; // 1 号前面空几格
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push({ key: `b${i}`, day: "", date: "", count: 0 });
  for (let d = 1; d <= days; d++) {
    const date = prefix + pad(d);
    cells.push({ key: date, day: d, date, count: counts[date] || 0, isToday: date === today, isFuture: date > today });
  }
  while (cells.length % 7) cells.push({ key: `a${cells.length}`, day: "", date: "", count: 0 });
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push({ key: `w${i}`, days: cells.slice(i, i + 7) });
  return { title: `${year}年${month + 1}月`, weeks }; // 下厨几次、最常做什么这些在 utils/stats.js（做饭总结）
}

module.exports = { timeOf, dateValue, dateToTime, dayText, normalizeLog, sortLogs, toLogCard, groupByMonth, buildMonth };
