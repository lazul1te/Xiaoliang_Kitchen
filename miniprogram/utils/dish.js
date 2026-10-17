// 把菜品数据整理成页面好显示的样子，以及搜索匹配

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

// "2026-10-12" 或 Date → "10月12日"
function formatMonthDay(value) {
  if (!value) return "";
  // 换成 2026/10/12 再解析，iOS 上更稳
  const date = value instanceof Date ? value : new Date(String(value).replace(/-/g, "/"));
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
    cover: dish.cover,
    initial: dish.name.slice(0, 1), // 没有成品照时，用菜名第一个字当占位图
    meta: dish.tags.slice(0, 2).concat(`${dish.duration} 分钟`).join(" · "),
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
    ingredientGroups: INGREDIENT_GROUPS.map((group) => ({
      type: group.type,
      label: group.label,
      items: dish.ingredients
        .filter((i) => (i.type || "main") === group.type)
        .map((i) => ({ name: i.name, amountText: `${i.amount}${i.unit}` })),
    })).filter((group) => group.items.length),
    steps: dish.steps.map((s) => ({
      text: s.text,
      image: s.image,
      timerText: s.timer > 0 ? formatSeconds(s.timer) : "",
    })),
  });
}

// 搜索：菜名或任意一样原料里包含关键词就算匹配
function matchKeyword(dish, keyword) {
  return dish.name.includes(keyword) || dish.ingredients.some((i) => i.name.includes(keyword));
}

module.exports = { toCard, toDetail, matchKeyword, formatMonthDay, formatSeconds };
