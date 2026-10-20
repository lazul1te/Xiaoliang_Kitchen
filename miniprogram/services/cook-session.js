// 一起做的进度：只存在这台手机上（不传云上，每本小本本各存一份），退出了、微信被关了，回来能接着做。开饭记下来以后清掉。
//   dishIds  一起做的菜（按建议的先后）
//   tab      正在看哪个："prep" 备菜，或者菜品 id
//   pos      { 菜品id: 第几步 }
//   done     { 菜品id: true }   做好了的
//   prep     { 原料key: true }  备好了的
//   timers   { "菜品id:第几步": { remaining, running, endAt } }   按结束时间算，回来补算
const storage = require("../utils/storage");
const book = require("./book");

const KEY = "cook_session";

function load() {
  const s = storage.get(book.cacheKey(KEY));
  if (!s || !Array.isArray(s.dishIds)) return null;
  return {
    dishIds: s.dishIds,
    tab: s.tab || "prep",
    pos: s.pos || {},
    done: s.done || {},
    prep: s.prep || {},
    timers: s.timers || {},
    startedAt: s.startedAt || Date.now(),
  };
}

function save(session) {
  try {
    storage.set(book.cacheKey(KEY), Object.assign({}, session, { updatedAt: Date.now() }));
  } catch (e) {} // 存不下也不影响做菜，只是退出后不能接着做
}

function clear() {
  storage.remove(book.cacheKey(KEY));
}

// 菜篮页的「继续做菜」：还有没做完的、菜还在菜篮里 → { done, total }，没有返回 null
function progress(basket) {
  const s = load();
  if (!s) return null;
  const ids = s.dishIds.filter((id) => basket[id]);
  if (!ids.length) return null;
  return { done: ids.filter((id) => s.done[id]).length, total: ids.length };
}

module.exports = { load, save, clear, progress };
