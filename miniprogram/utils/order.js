// 点菜单：哪一顿、口味、编号这些小工具。菜篮页、点菜单图片和开饭页共用
const { dateValue, dayText, timeOf } = require("./log");

const MEALS = ["早饭", "午饭", "晚饭", "夜宵"];
const FLAVORS = ["少辣", "不要辣", "清淡点", "少油", "不要香菜", "多放蒜"]; // 常用的口味，点一下就行

const text = (v) => (v === undefined || v === null ? "" : String(v)).trim();
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");

// 按现在几点猜是哪一顿：10 点前早饭，14 点前午饭，21 点前晚饭，再晚是夜宵
function mealByTime(ts) {
  const h = new Date(ts || Date.now()).getHours();
  if (h < 10) return "早饭";
  if (h < 14) return "午饭";
  if (h < 21) return "晚饭";
  return "夜宵";
}

// 12 → "No.012"
function orderNoText(no) {
  return `No.${String(no).padStart(3, "0")}`;
}

// 存到云上的点菜单统一成固定格式；不像样的返回 null
//   no 编号、date 哪天 "2026-10-19"、meal 哪一顿、flavors 口味、note 备注、orderedBy 谁点的、cook 谁掌勺、
//   items 下单时点了哪些菜 { 菜品id: 份数 }（之后再点的算加菜）、orderedAt 下单时间
function normalizeOrder(o) {
  if (!o || typeof o !== "object" || !(Number(o.no) > 0)) return null;
  const items = {};
  Object.keys(o.items || {}).forEach((id) => {
    const n = parseInt(o.items[id], 10);
    if (n > 0) items[id] = n;
  });
  const flavors = [];
  (Array.isArray(o.flavors) ? o.flavors : []).forEach((f) => {
    const s = text(f).slice(0, 10);
    if (s && flavors.indexOf(s) < 0 && flavors.length < 8) flavors.push(s);
  });
  return {
    no: Number(o.no),
    date: isDate(o.date) ? o.date : dateValue(Number(o.orderedAt) || Date.now()),
    meal: MEALS.indexOf(o.meal) >= 0 ? o.meal : "晚饭",
    flavors,
    note: text(o.note).slice(0, 40),
    orderedBy: text(o.orderedBy).slice(0, 10),
    cook: text(o.cook).slice(0, 10),
    items,
    orderedAt: Number(o.orderedAt) || 0,
  };
}

// "2026-10-19" → "10月19日 周一"
function dateText(date) {
  return dayText(timeOf(date));
}

// 最慢的一道：[{ dish, qty }] → "最慢的台式卤肉饭要 90 分钟"；都没写用时返回空字符串
function slowestText(planned) {
  const slow = planned.filter((p) => p.dish.duration > 0).sort((a, b) => b.dish.duration - a.dish.duration)[0];
  return slow ? `最慢的${slow.dish.name}要 ${slow.dish.duration} 分钟` : "";
}

// 「点菜 小鱼 · 掌勺 大熊」，都没写就是空字符串
function peopleText(order) {
  return [order.orderedBy && `点菜 ${order.orderedBy}`, order.cook && `掌勺 ${order.cook}`].filter(Boolean).join(" · ");
}

// 一张点菜单上要写的东西：菜篮页的小票、存成的图片、小程序卡片都用它。
// order：下单时存的点菜单；planned：菜篮里现在的菜 [{ dish, qty }]（按菜单里的顺序）
function ticketOf(order, planned) {
  const items = planned.map(({ dish, qty }) => ({
    _id: dish._id,
    name: dish.name,
    qty,
    added: qty > (order.items[dish._id] || 0), // 下单以后又点的
  }));
  return {
    no: order.no,
    noText: orderNoText(order.no),
    date: order.date,
    dateText: dateText(order.date),
    meal: order.meal,
    peopleText: peopleText(order),
    items,
    count: items.length,
    portions: items.reduce((sum, i) => sum + i.qty, 0),
    flavorsText: order.flavors.join("、"),
    note: order.note,
    slowText: slowestText(planned),
  };
}

// 分享卡片的标题：「今晚吃这些：台式卤肉饭、奥尔良鸡翅等 4 道菜」
function shareTitle(ticket, now) {
  const today = dateValue(now || Date.now());
  const tomorrow = dateValue(timeOf(today) + 36 * 3600 * 1000);
  let when;
  if (ticket.date === today) when = ticket.meal === "晚饭" ? "今晚" : `今天${ticket.meal}`;
  else if (ticket.date === tomorrow) when = `明天${ticket.meal}`;
  else when = `${ticket.dateText.split(" ")[0]}${ticket.meal}`;
  const names = ticket.items.map((i) => i.name);
  const dishes = names.length > 2 ? `${names.slice(0, 2).join("、")}等 ${names.length} 道菜` : names.join("、");
  return `${when}吃这些：${dishes}`;
}

// 以前写过的名字（点菜人、掌勺），按给的顺序去重，最多 count 个
function recentNames(list, count) {
  const names = [];
  list.forEach((n) => {
    const s = text(n);
    if (s && names.indexOf(s) < 0) names.push(s);
  });
  return names.slice(0, count || 4);
}

module.exports = { MEALS, FLAVORS, mealByTime, orderNoText, normalizeOrder, dateText, slowestText, peopleText, ticketOf, shareTitle, recentNames };
