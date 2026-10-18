// 买菜清单：把菜篮里几道菜的原料合并起来，再和家里的库存对一对。
// - 同名的原料放在一起；用量是数字、单位相同的直接加起来（再乘上点的份数），「适量」这类原样列出
// - 库存里有的 → 「家里有」，不用买；库存里标了用完了的 → 放进「要买的」
// - 调料、库存里又没记录的 → 单独一组，点「有」加进库存，以后就不再提醒

// 去掉括号里的说明，「口蘑（可选）」→「口蘑」，用来和库存对名字
function baseName(name) {
  return String(name || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .trim();
}

// 名字 → 一个固定的短 key，用来记「买到了没有」、对库存
function keyOf(name) {
  const s = baseName(name);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
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
// checked、extras 来自 services/plan.js；pantry 来自 services/pantry.js 的 getItems()
function buildShoppingList(planned, checked, extras, pantry) {
  const stock = pantry || {};
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

  const buy = [];
  const unknown = [];
  const stocked = [];
  Object.keys(map).forEach((name) => {
    const e = map[name];
    const key = keyOf(e.name);
    const item = stock[key];
    const row = {
      key,
      name: e.name,
      amountText: e.units
        .map((u) => formatNumber(e.sums[u]) + u)
        .concat(e.texts)
        .join(" + "),
      dishesText: e.dishes.join("、"),
      checked: !!checked[key],
      outOfStock: !!item && !item.inStock,
    };
    if (item && item.inStock) stocked.push(row);
    else if (!item && e.seasoning) unknown.push(row);
    else buy.push(row);
  });
  const extraItems = Object.keys(extras)
    .map((key) => ({ key, name: extras[key].name, createdAt: extras[key].createdAt, checked: !!checked[key] }))
    .sort((a, b) => a.createdAt - b.createdAt);
  // 勾掉（买到）的沉到每组最下面，没买的一直在上面
  const sink = (list) => list.filter((i) => !i.checked).concat(list.filter((i) => i.checked));
  const todo = buy.concat(unknown, extraItems);
  return {
    buy: sink(buy), // 要买的
    unknown: sink(unknown), // 调料，库存里没记录：家里有的话点「有」
    stocked, // 家里有，不用买
    extras: sink(extraItems), // 自己加的
    total: todo.length,
    done: todo.filter((i) => i.checked).length,
  };
}

module.exports = { buildShoppingList, parseAmount, keyOf, baseName };
