// 一顿饭：开饭时记下的一条 meals 记录。每道做了的菜另外各有一条做菜记录（cook_logs，带 mealId）
const { MEALS, orderNoText, peopleText, dateText } = require("./order");
const { dateValue } = require("./log");

const text = (v) => (v === undefined || v === null ? "" : String(v)).trim();

// 整理成统一的格式：存进去、读出来都过一遍
function normalizeMeal(m) {
  const now = Date.now();
  return {
    _id: text(m._id),
    no: Number(m.no) > 0 ? Number(m.no) : 0, // 点菜单编号；没下单直接做的是 0
    date: /^\d{4}-\d{2}-\d{2}$/.test(m.date || "") ? m.date : dateValue(Number(m.createdAt) || now),
    meal: MEALS.indexOf(m.meal) >= 0 ? m.meal : "晚饭",
    items: (Array.isArray(m.items) ? m.items : [])
      .map((i) => ({ dishId: text(i && i.dishId), dishName: text(i && i.dishName), qty: Math.max(1, parseInt(i && i.qty, 10) || 1) }))
      .filter((i) => i.dishId),
    flavors: (Array.isArray(m.flavors) ? m.flavors : []).map(text).filter(Boolean),
    note: text(m.note), // 这顿的心得
    orderedBy: text(m.orderedBy),
    cook: text(m.cook),
    photo: text(m.photo), // 整桌照片（大图）
    photoThumb: text(m.photoThumb), // 整桌照片（小图），记录页用
    createdAt: Number(m.createdAt) || now,
    updatedAt: Number(m.updatedAt) || now,
  };
}

// 点菜单记录页上的一顿饭：logs 是这顿饭的做菜记录（卡片，utils/log.js 的 toLogCard，不传 meals），按点菜的顺序排
function mealCard(meal, logs) {
  const qty = {};
  const order = {};
  meal.items.forEach((i, index) => {
    qty[i.dishId] = i.qty;
    order[i.dishId] = index;
  });
  const rank = (l) => (l.dishId in order ? order[l.dishId] : 999);
  return {
    _id: meal._id,
    title: meal.meal,
    noText: meal.no ? orderNoText(meal.no) : "",
    peopleText: peopleText(meal),
    photo: meal.photoThumb || meal.photo,
    note: meal.note,
    dishes: logs
      .slice()
      .sort((a, b) => rank(a) - rank(b))
      .map((l) => Object.assign({}, l, { qtyText: qty[l.dishId] > 1 ? `×${qty[l.dishId]}` : "" })),
  };
}

// 「分享这顿饭」的小票（utils/ticket.js 画）：盖着「已开饭」，每道菜的分数、这顿的心得。
// logs：这顿的做菜记录；names：{ 菜品id: 现在的菜名 }（菜改过名的话用新名字）
function mealTicket(meal, logs, names) {
  const qty = {};
  meal.items.forEach((i) => {
    qty[i.dishId] = i.qty;
  });
  return {
    title: meal.no ? "点菜单" : "这一顿",
    noText: meal.no ? orderNoText(meal.no) : "",
    lines: [`${dateText(meal.date)} · ${meal.meal}`].concat(peopleText(meal) ? [peopleText(meal)] : []),
    items: logs.map((l) => ({
      name: `${(names && names[l.dishId]) || l.dishName}${qty[l.dishId] > 1 ? ` ×${qty[l.dishId]}` : ""}`,
      right: l.rating ? "★".repeat(l.rating) + "☆".repeat(5 - l.rating) : "",
    })),
    notes: meal.note ? [meal.note] : [],
    stamp: "已开饭",
  };
}

module.exports = { normalizeMeal, mealCard, mealTicket };
