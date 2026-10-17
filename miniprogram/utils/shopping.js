// 买菜清单：把今日菜单里几道菜的原料合并起来。
// 同名的原料放在一起；用量是数字、单位相同的直接加起来（再乘上点的份数），「适量」这类原样列出。
// 调料单独放一组（家里一般都有，看看缺不缺）。

// 原料名 → 一个固定的短 key，用来记「买到了没有」
function keyOf(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return `i${(h >>> 0).toString(36)}`;
}

// "3" → 3，"1.5" → 1.5，"1/2" → 0.5；「适量」「少许」之类返回 null
function parseAmount(text) {
  const s = String(text || "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const m = /^(\d+)\/(\d+)$/.exec(s);
  if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
  return null;
}

const formatNumber = (n) => String(Math.round(n * 100) / 100);

// planned: [{ dish, qty }]，qty 是点了几份（1 份 = 菜谱里写的用量）
// checked、extras 来自 services/plan.js
function buildShoppingList(planned, checked, extras) {
  const map = {};
  planned.forEach(({ dish, qty }) => {
    dish.ingredients.forEach((ing) => {
      const name = ing.name.trim();
      if (!name) return;
      const entry =
        map[name] || (map[name] = { name, seasoning: true, sums: {}, units: [], texts: [], dishes: [] });
      if (ing.type !== "seasoning") entry.seasoning = false; // 有一道菜把它当主料/辅料，就算要买的
      const n = parseAmount(ing.amount);
      if (n !== null) {
        const unit = ing.unit || "";
        if (!(unit in entry.sums)) {
          entry.sums[unit] = 0;
          entry.units.push(unit);
        }
        entry.sums[unit] += n * qty;
      } else {
        const t = `${ing.amount}${ing.unit}`.trim();
        if (t && entry.texts.indexOf(t) < 0) entry.texts.push(t);
      }
      if (entry.dishes.indexOf(dish.name) < 0) entry.dishes.push(dish.name);
    });
  });

  const toItem = (e) => {
    const key = keyOf(e.name);
    return {
      key,
      name: e.name,
      amountText: e.units
        .map((u) => formatNumber(e.sums[u]) + u)
        .concat(e.texts)
        .join(" + "),
      dishesText: e.dishes.join("、"),
      checked: !!checked[key],
    };
  };
  const entries = Object.keys(map).map((name) => map[name]);
  const buy = entries.filter((e) => !e.seasoning).map(toItem);
  const seasoning = entries.filter((e) => e.seasoning).map(toItem);
  const extraItems = Object.keys(extras)
    .map((key) => ({ key, name: extras[key].name, createdAt: extras[key].createdAt, checked: !!checked[key] }))
    .sort((a, b) => a.createdAt - b.createdAt);
  const all = buy.concat(seasoning, extraItems);
  return {
    buy,
    seasoning,
    extras: extraItems,
    total: all.length,
    done: all.filter((i) => i.checked).length,
  };
}

module.exports = { buildShoppingList, parseAmount, keyOf };
