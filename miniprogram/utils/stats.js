// 做饭总结（pages/stats）：按「一个月 / 一年 / 全部」统计做菜记录。都是纯函数。
// 「下厨几次」跟「我的」页一样按记录算：一道菜做一次算一次（开饭时一起做了 3 道就是 3 次）。
// range：{ kind: "month" | "year" | "all", year, month }，month 是 0～11（按年、全部时也记着，切回按月时用）
const { dateValue } = require("./log");

const TOP = 5; // 最常做的列几道
const BEST = 3; // 打分最高的列几道
const STALE = 3; // 好久没做的列几道
const STALE_DAYS = 30; // 多少天没做算「好久没做了」
const DAY = 24 * 3600 * 1000;
const COOK_COLORS = ["#ffb21e", "#a0693f", "#5db15a", "#9a9aa0"]; // 谁掌勺：蛋黄、木柄、葱绿，再多的人都是灰色

// 这段时间的 [开始, 结束) 时间戳；全部是 [0, Infinity)
function spanOf(range) {
  if (range.kind === "month") return [new Date(range.year, range.month, 1).getTime(), new Date(range.year, range.month + 1, 1).getTime()];
  if (range.kind === "year") return [new Date(range.year, 0, 1).getTime(), new Date(range.year + 1, 0, 1).getTime()];
  return [0, Infinity];
}

function titleOf(range) {
  if (range.kind === "month") return `${range.year}年${range.month + 1}月`;
  if (range.kind === "year") return `${range.year}年`;
  return "全部";
}

// 往前（-1）、往后（1）挪一个月或一年；全部不动
function shiftRange(range, delta) {
  if (range.kind === "month") {
    const d = new Date(range.year, range.month + delta, 1);
    return { kind: "month", year: d.getFullYear(), month: d.getMonth() };
  }
  if (range.kind === "year") return { kind: "year", year: range.year + delta, month: range.month };
  return range;
}

// 能不能往前、往后翻：比最早的记录还早、还没到的日子都不用翻
function canShift(range, delta, logs, now) {
  if (range.kind === "all") return false;
  const [start, end] = spanOf(range);
  return delta > 0 ? end <= now : logs.some((l) => l.cookedAt < start);
}

// 现在落在这段时间里（这个月、今年、全部）
function isCurrent(range, now) {
  const [start, end] = spanOf(range);
  return now >= start && now < end;
}

function starsOf(avg) {
  const n = Math.round(avg);
  return "★".repeat(n) + "☆".repeat(5 - n);
}

function agoText(days) {
  return days < 60 ? `上次是 ${days} 天前` : `上次是 ${Math.floor(days / 30)} 个月前`;
}

// 统计 range 里的做菜记录。logs：做菜记录（normalizeLog 过的）；dishes：现在的菜（显示现在的名字，删掉的菜标 gone，点不进去）；
// now：现在的时间戳。返回：
//   title 「2026年10月」，count 次下厨，dishCount 道不同的菜，days 天在做饭，
//   top 最常做的 [{ dishId, name, gone, count, pct }]（pct 是条的长短，最多的那道 100），
//   cooks 谁掌勺 [{ name, count, pct, color }]（写了名字的才算），best 打分最高 [{ dishId, name, gone, stars, avgText, rated }]，
//   firstTimes 这段时间第一次做的菜 [{ dishId, name, gone }]（看全部时不算），
//   chart 每个月下厨几次 [{ key, label, count, pct, current }]（按年是这一年，全部是最近 12 个月；按月不用，日历上有），
//   stale 好久没做的菜 [{ dishId, name, days, text }]（只在看全部时）
function summarize(logs, dishes, range, now) {
  const [start, end] = spanOf(range);
  const byId = {};
  dishes.forEach((d) => {
    byId[d._id] = d;
  });
  const nameOf = (l) => (byId[l.dishId] ? byId[l.dishId].name : l.dishName || "删掉的菜");
  const picked = logs.filter((l) => l.cookedAt >= start && l.cookedAt < end);
  const brief = (p) => ({ dishId: p.dishId, name: p.name, gone: p.gone });

  // 每道菜：做了几次、最近一次、打分
  const perDish = {};
  picked.forEach((l) => {
    let p = perDish[l.dishId];
    if (!p) {
      p = { dishId: l.dishId, name: nameOf(l), gone: !byId[l.dishId], count: 0, lastAt: 0, ratingSum: 0, rated: 0 };
      perDish[l.dishId] = p;
    }
    p.count += 1;
    p.lastAt = Math.max(p.lastAt, l.cookedAt);
    if (l.rating) {
      p.ratingSum += l.rating;
      p.rated += 1;
    }
  });
  const list = Object.keys(perDish).map((k) => perDish[k]);

  // 最常做：次数一样的，最近做过的在前
  const top = list
    .slice()
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, TOP);
  const most = top.length ? top[0].count : 0;

  // 谁掌勺
  const cookCounts = {};
  picked.forEach((l) => {
    if (l.cook) cookCounts[l.cook] = (cookCounts[l.cook] || 0) + 1;
  });
  const cookNames = Object.keys(cookCounts).sort((a, b) => cookCounts[b] - cookCounts[a]);
  const cookTotal = cookNames.reduce((sum, n) => sum + cookCounts[n], 0);
  const cooks = cookNames.map((name, i) => ({
    name,
    count: cookCounts[name],
    pct: Math.round((cookCounts[name] / cookTotal) * 100),
    color: COOK_COLORS[Math.min(i, COOK_COLORS.length - 1)],
  }));

  // 打分最高：按平均分，一样的话打分次数多的在前
  const best = list
    .filter((p) => p.rated)
    .map((p) => Object.assign({ avg: p.ratingSum / p.rated }, p))
    .sort((a, b) => b.avg - a.avg || b.rated - a.rated)
    .slice(0, BEST)
    .map((p) => Object.assign(brief(p), { stars: starsOf(p.avg), avgText: p.avg.toFixed(1), rated: p.rated }));

  // 第一次做：这道菜最早的一条记录落在这段时间里
  const firstAt = {};
  logs.forEach((l) => {
    if (!(l.dishId in firstAt) || l.cookedAt < firstAt[l.dishId]) firstAt[l.dishId] = l.cookedAt;
  });
  const firstTimes =
    range.kind === "all"
      ? []
      : list
          .filter((p) => firstAt[p.dishId] >= start)
          .sort((a, b) => firstAt[a.dishId] - firstAt[b.dishId])
          .map(brief);

  // 每个月下厨几次
  let chart = [];
  if (range.kind !== "month") {
    const nowDate = new Date(now);
    const from = range.kind === "year" ? new Date(range.year, 0, 1) : new Date(nowDate.getFullYear(), nowDate.getMonth() - 11, 1);
    for (let i = 0; i < 12; i++) {
      const m = new Date(from.getFullYear(), from.getMonth() + i, 1);
      const s = m.getTime();
      const e = new Date(m.getFullYear(), m.getMonth() + 1, 1).getTime();
      chart.push({
        key: dateValue(s).slice(0, 7),
        label: `${m.getMonth() + 1}月`,
        count: logs.filter((l) => l.cookedAt >= s && l.cookedAt < e).length,
        current: now >= s && now < e,
      });
    }
    const max = Math.max.apply(null, chart.map((c) => c.count));
    if (max) chart.forEach((c) => (c.pct = Math.round((c.count / max) * 100)));
    else chart = [];
  }

  // 好久没做了：还在菜单里、做过的菜，最后一次做是 30 天以前，最久的在前
  let stale = [];
  if (range.kind === "all") {
    const lastAt = {};
    logs.forEach((l) => {
      if (byId[l.dishId] && !(lastAt[l.dishId] >= l.cookedAt)) lastAt[l.dishId] = l.cookedAt;
    });
    stale = Object.keys(lastAt)
      .map((id) => ({ dishId: id, name: byId[id].name, days: Math.floor((now - lastAt[id]) / DAY) }))
      .filter((d) => d.days >= STALE_DAYS)
      .sort((a, b) => b.days - a.days)
      .slice(0, STALE)
      .map((d) => Object.assign(d, { text: agoText(d.days) }));
  }

  const days = {};
  picked.forEach((l) => {
    days[dateValue(l.cookedAt)] = true;
  });
  return {
    title: titleOf(range),
    count: picked.length,
    dishCount: list.length,
    days: Object.keys(days).length,
    top: top.map((p) => Object.assign(brief(p), { count: p.count, pct: Math.max(4, Math.round((p.count / most) * 100)) })),
    cooks,
    best,
    firstTimes,
    chart,
    stale,
  };
}

module.exports = { spanOf, titleOf, shiftRange, canShift, isCurrent, summarize };
