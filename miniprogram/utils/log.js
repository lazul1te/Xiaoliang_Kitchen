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

// 记录页、详情页里的一条记录
function toLogCard(log, dishNames) {
  const name = (dishNames && dishNames[log.dishId]) || log.dishName || "这道菜已经删掉了";
  return {
    _id: log._id,
    dishId: log.dishId,
    dishName: name,
    photo: log.photoThumb || log.photo,
    stars: log.rating ? "★".repeat(log.rating) + "☆".repeat(5 - log.rating) : "",
    note: log.note,
    cook: log.cook,
    dayText: dayText(log.cookedAt),
  };
}

// 按月份、再按日期分组：[{ key, title, count, days: [{ key, title, logs: [卡片] }] }]
// logs 要先按时间倒序排好
function groupByMonth(logs, dishNames) {
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
    day.logs.push(toLogCard(log, dishNames));
    month.count += 1;
  });
  return months;
}

// 统计：这个月做了几次、一共几次、做过几道不同的菜
function logStats(logs) {
  const now = new Date();
  const thisMonth = logs.filter((l) => {
    const d = new Date(l.cookedAt);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
  const dishes = {};
  logs.forEach((l) => {
    dishes[l.dishId] = true;
  });
  return { thisMonth, total: logs.length, dishCount: Object.keys(dishes).length };
}

module.exports = { timeOf, dateValue, dateToTime, normalizeLog, sortLogs, toLogCard, groupByMonth, logStats };
