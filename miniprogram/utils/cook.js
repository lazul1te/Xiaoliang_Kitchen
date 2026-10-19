// 一起做几道菜：先后顺序、要提前做的步骤、备菜清单（用量乘好份数）。planned 都是 [{ dish, qty }]
const { parseAmount } = require("./shopping");
const { formatSeconds } = require("./dish");

const WAIT_WORDS = /腌|泡|解冻|冷藏|醒面|发面|发酵/; // 这些步骤要等，得提前做
const WAIT_MIN = 10 * 60; // 计时 10 分钟以上才算

const formatNumber = (n) => String(Math.round(n * 100) / 100);

// 菜名太长放不下标签：去掉括号里的说明，最多 6 个字。「奥尔良鸡翅（空气炸锅版）」→「奥尔良鸡翅」
function shortName(name) {
  const s = String(name || "").replace(/[（(][^）)]*[）)]/g, "").trim() || String(name || "");
  return s.length > 6 ? `${s.slice(0, 5)}…` : s;
}

// 建议顺序：用时长的先做，快手菜最后下锅；没写用时的排最后，用时一样的按菜单顺序
function cookOrder(planned) {
  return planned
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.dish.duration || 0) - (a.p.dish.duration || 0) || a.i - b.i)
    .map((x) => x.p);
}

// 要提前做的步骤（腌、泡、解冻……计时 10 分钟以上）：[{ dishId, dishName, index, text, timerText }]
function waitSteps(planned) {
  const list = [];
  planned.forEach(({ dish }) => {
    dish.steps.forEach((s, index) => {
      if (s.timer >= WAIT_MIN && WAIT_WORDS.test(s.text)) {
        list.push({
          dishId: dish._id,
          dishName: shortName(dish.name),
          index,
          text: s.text.length > 24 ? `${s.text.slice(0, 23)}…` : s.text,
          timerText: formatSeconds(s.timer),
        });
      }
    });
  });
  return list;
}

// 用量乘上份数：「1/2个」× 2 →「1个」；「适量」原样
function scaledAmount(ing, qty) {
  const n = parseAmount(ing.amount);
  if (n === null || qty === 1) return `${ing.amount}${ing.unit}`;
  return `${formatNumber(n * qty)}${ing.unit}`;
}

// 备菜清单：每道菜一组，主料辅料一样一行（能勾），调料写成一行（拿出来就行）
//   [{ dishId, title: "台式卤肉饭 · 1 份", items: [{ key, name, amountText }], seasonings: "生抽、老抽" }]
function prepGroups(planned) {
  return planned.map(({ dish, qty }) => ({
    dishId: dish._id,
    title: `${dish.name} · ${qty} 份`,
    items: dish.ingredients
      .map((ing, i) => ({ ing, i }))
      .filter(({ ing }) => ing.type !== "seasoning")
      .map(({ ing, i }) => ({ key: `${dish._id}:${i}`, name: ing.name, amountText: scaledAmount(ing, qty) })),
    seasonings: dish.ingredients
      .filter((ing) => ing.type === "seasoning")
      .map((ing) => ing.name)
      .join("、"),
  }));
}

// 「看原料」面板：按主料、辅料、调料分组，用量乘好份数
const GROUPS = [
  { type: "main", label: "主料" },
  { type: "side", label: "辅料" },
  { type: "seasoning", label: "调料" },
];
function ingredientGroups(dish, qty) {
  return GROUPS.map((g) => ({
    type: g.type,
    label: g.label,
    items: dish.ingredients
      .map((ing, index) => ({ ing, index }))
      .filter(({ ing }) => (ing.type || "main") === g.type)
      .map(({ ing, index }) => ({ key: index, name: ing.name, amountText: scaledAmount(ing, qty) })),
  })).filter((g) => g.items.length);
}

module.exports = { shortName, cookOrder, waitSteps, prepGroups, ingredientGroups, scaledAmount };
