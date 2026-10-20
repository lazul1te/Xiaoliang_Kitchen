// 小本本：每人一本只有自己能看的「我的小本本」，还可以建家庭本本、用家庭码申请加入（本主同意了才算加入），随时切换。
// 正在用哪本存在手机上：打开小程序先显示上次那本的缓存，同时问云函数这次该进哪本（默认是上次用的那本，也可以指定一本）。
// 换了一本时通知 store.js、shared-doc.js、cook-session.js 换成那本的数据（onSwitch）；每本的缓存 key 用 cacheKey() 生成。
const api = require("./api");
const storage = require("../utils/storage");
const ui = require("../utils/ui");

const CURRENT_KEY = "book_current";
const INFO_KEY = "book_info";
const OLD_KEYS = ["cloud_cache", "plan_cache", "pantry_cache", "wish_cache", "cook_session"]; // 以前不分本本的缓存
const MINE_TAB_INDEX = 3; // 「我的」Tab：有人申请加入你的家庭本本时显示小红点
const MAX_NAMES = 3; // 成员名字最多列几个

const clone = (v) => JSON.parse(JSON.stringify(v));

function normalize(v) {
  const me = (v && v.me) || {};
  return {
    me: { personalBookId: me.personalBookId || "", defaultBook: me.defaultBook || "" },
    books: v && Array.isArray(v.books) ? v.books : [],
    pending: v && Array.isArray(v.pending) ? v.pending : [],
  };
}

let currentId = storage.get(CURRENT_KEY) || "";
let info = normalize(storage.get(INFO_KEY)); // { me, books, pending }：上次从云上拿到的
let booting = null;
let chosen = false; // 这次打开以后自己切过本本：云函数说的「这次进哪本」就不用了
let refreshing = null;
let lastRefreshAt = 0;
let version = 0;
let welcome = null; // 旧数据变成家庭本本以后第一次打开：菜单页说一声
let notices = []; // 申请通过了 / 没通过 / 不在某本里了，菜单页、「我的」页打开时弹出来
const names = {}; // 本本 id → 名字（已经不在的本本，提示里也要说得出名字）
const listeners = [];
const cacheBases = {};

function remember() {
  info.books.concat(info.pending).forEach((b) => {
    names[b._id] = b.name;
  });
}
remember();

function save() {
  version += 1;
  remember();
  try {
    storage.set(INFO_KEY, info);
  } catch (e) {} // 存不下不影响使用
  updateDot();
}

function addNotice(n) {
  if (notices.some((x) => x.key === n.key)) return;
  // 「被移出了」「这本删掉了」和自己发现「这本不在了」说的是一件事，只说一次
  if (n.type === "lost" && notices.some((x) => x.bookId === n.bookId && (x.type === "removed" || x.type === "deleted"))) return;
  if (n.type === "removed" || n.type === "deleted") notices = notices.filter((x) => !(x.type === "lost" && x.bookId === n.bookId));
  notices.push(n);
}

// 云函数返回的 { me, books, pending, notices }
function apply(res) {
  info = normalize(res);
  lastRefreshAt = Date.now();
  (res.notices || []).forEach(addNotice);
  save();
}

// 正在用的这本已经不在了（被移出了、这本删掉了）：回到个人本本
function lost(id) {
  if (!id || id !== currentId) return;
  addNotice({ type: "lost", key: `lost-${id}`, bookId: id, name: names[id] || "" });
  info.books = info.books.filter((b) => b._id !== id);
  save();
  setCurrent(info.me.personalBookId);
}

function checkCurrent() {
  if (currentId && !info.books.some((b) => b._id === currentId)) lost(currentId);
}

api.onNotMember(lost);

function setCurrent(id) {
  if (!id || id === currentId) return;
  currentId = id;
  try {
    storage.set(CURRENT_KEY, id);
  } catch (e) {}
  version += 1;
  listeners.forEach((fn) => fn(id));
}

// ---------- 打开小程序、切换 ----------

// 第一次要用云上数据时调用（每次打开小程序只问一次）：有哪些本本、这次进哪本。旧数据也是在这一步变成家庭本本的
function ready() {
  if (!booting) {
    booting = api.call("boot", {}).then(
      (res) => {
        apply(res);
        if (res.welcome) welcome = res.welcome;
        OLD_KEYS.forEach((key) => storage.remove(key));
        if (!chosen || !info.books.some((b) => b._id === currentId)) setCurrent(res.openBookId);
      },
      (err) => {
        booting = null; // 下次再试
        throw err;
      }
    );
  }
  return booting;
}

// 正在用的那本的 id；第一次打开新版本、还没问过云函数时是空的（先 await ready()）
function getCurrentId() {
  return currentId;
}

function onSwitch(fn) {
  listeners.push(fn);
}

// 每本各存一份的缓存用的 key，比如 cacheKey("plan_cache") → "plan_cache@那本的id"
function cacheKey(base, bookId) {
  cacheBases[base] = true;
  return `${base}@${bookId || currentId}`;
}

// 切到另一本：先换成手机上存着的那本，再记到云上（下次打开默认进它）
function switchTo(id) {
  if (!id || id === currentId) return;
  chosen = true;
  setCurrent(id);
  api.call("switchBook", { bookId: id }).catch(() => {});
}

// 从别人发来的卡片打开（卡片上带着是哪本）：你也在那本里，就切过去
async function openShared(bookId) {
  await ready().catch(() => {});
  if (bookId && bookId !== currentId && info.books.some((b) => b._id === bookId)) switchTo(bookId);
}

// 隔一会儿再去云上看看：有没有人申请加入、申请有没有通过、成员和名字变了没有。返回有没有变
function refresh() {
  if (refreshing) return refreshing;
  const before = JSON.stringify(info);
  const startedAt = Date.now();
  refreshing = ready()
    .then(() => (lastRefreshAt >= startedAt ? null : api.call("books", {}))) // 刚打开小程序时已经一起拿到了
    .then(
      (res) => {
        refreshing = null;
        if (res) apply(res);
        checkCurrent();
        return JSON.stringify(info) !== before;
      },
      (err) => {
        refreshing = null;
        throw err;
      }
    );
  return refreshing;
}

function refreshIfStale(maxAge) {
  if (refreshing) return refreshing;
  if (Date.now() - lastRefreshAt < maxAge) return Promise.resolve(false);
  return refresh();
}

// ---------- 页面上显示的样子 ----------

// 菜单左上角放得下的短名字：「我们家的小本本」→「我们家」，「我的小本本」→「我的」
function shortName(name) {
  const full = String(name || "");
  let s = full.replace(/小本本$/, "");
  if (s.length > 2 && /的$/.test(s)) s = s.slice(0, -1);
  s = s || full;
  return s.length > 4 ? `${s.slice(0, 4)}…` : s;
}

// 头像上的字：个人本本是「我」，「我们家……」是「家」，别的用名字第一个字
function initialOf(book) {
  if (book.type !== "family") return "我";
  const s = shortName(book.name);
  return /^我们/.test(s) || !s ? "家" : s.slice(0, 1);
}

// 成员、申请人显示的名字和头像上的字（没写名字的：自己是「我」，别人是「家人」）
function person(p, me) {
  const label = p.name || (me ? "我" : "家人");
  return Object.assign(p, { label, initial: label.slice(0, 1) });
}

function describe(b) {
  const book = b ? clone(b) : { _id: currentId, name: "小本本", type: "personal", owner: true, myName: "", members: [], code: "", requests: [] };
  const family = book.type === "family";
  book.members.forEach((m) => person(m, m.me));
  book.requests.forEach((r) => person(r, false));
  const labels = book.members.map((m) => m.label);
  const more = labels.length > MAX_NAMES ? ` 等 ${labels.length} 人` : "";
  return Object.assign(book, {
    family,
    current: book._id === currentId,
    initial: initialOf(book),
    shortName: shortName(book.name),
    sub: family ? `家庭 · ${labels.slice(0, MAX_NAMES).join("、")}${more}` : "个人 · 只有你能看",
    requestCount: book.owner ? book.requests.length : 0,
  });
}

// 正在用的这本（还不知道是哪本时是个空架子）
function current() {
  return describe(info.books.find((b) => b._id === currentId));
}

function get(id) {
  const b = info.books.find((x) => x._id === id);
  return b ? describe(b) : null;
}

// 你的本本（个人本本在最前面）
function list() {
  return info.books.map(describe);
}

// 你申请了、还在等本主同意的
function pending() {
  return clone(info.pending);
}

function has(id) {
  return info.books.some((b) => b._id === id);
}

// 正在用的是家庭本本：页面上的说法用「家人」「大家」，个人本本里不说「对方」「两个人」
function isShared() {
  return current().family;
}

// 这本里各人的名字（点菜、掌勺时点一下就行）
function memberNames() {
  return current()
    .members.map((m) => m.name)
    .filter(Boolean);
}

function personalId() {
  return info.me.personalBookId;
}

// 打开小程序时进哪本：空的是「上次用的那本」
function defaultBook() {
  return info.me.defaultBook;
}

// 「我的」Tab 上的小红点：你是本主的本本里有人申请加入
function updateDot() {
  const count = info.books.reduce((n, b) => n + (b.owner && Array.isArray(b.requests) ? b.requests.length : 0), 0);
  if (count) wx.showTabBarRedDot({ index: MINE_TAB_INDEX, fail() {} });
  else wx.hideTabBarRedDot({ index: MINE_TAB_INDEX, fail() {} });
}

function requestCount() {
  return info.books.reduce((n, b) => n + (b.owner && Array.isArray(b.requests) ? b.requests.length : 0), 0);
}

function takeWelcome() {
  const w = welcome;
  welcome = null;
  return w;
}

// 把攒着的通知一条条弹出来。返回有没有切到别的本本（页面要重新读）
async function showNotices() {
  let switched = false;
  while (notices.length) {
    const n = notices.shift();
    const name = `「${n.name || "那本小本本"}」`;
    if (n.type === "approved") {
      const go = await ui.confirm({
        title: "加入成功",
        content: `${name}的本主同意了，你已经是这本的成员。现在切换过去吗？`,
        confirmText: "切换过去",
        cancelText: "等会儿",
      });
      if (go && has(n.bookId)) {
        switchTo(n.bookId);
        switched = true;
      }
    } else if (n.type === "rejected") {
      await ui.alert("没有加入", `${name}的本主没有同意你加入`);
    } else if (n.type === "removed") {
      await ui.alert("不在这本里了", `${name}的本主把你移出了这本`);
    } else if (n.type === "deleted") {
      await ui.alert("这本没有了", `${name}已经删掉了，你的申请也没有了`);
    } else if (n.type === "lost") {
      await ui.alert("不在这本里了", `你已经不在${name}里了，先回到「我的小本本」`);
      switched = true;
    }
  }
  return switched;
}

// ---------- 新建、加入、设置 ----------

// 改了本本（建、申请、同意……）以后，云函数会把最新的本本列表一起返回
async function act(action, params) {
  const res = await api.call(action, params);
  apply(res);
  checkCurrent();
  return res;
}

// 新建家庭本本，返回新本的 id
async function create(name, myName) {
  return (await act("createBook", { name, myName })).bookId;
}

// 把 fromId 那本的菜复制到 toId（dishIds 不传就是整本，分类按名字对上）。onProgress(复制到第几道, 一共几道)
async function copyDishes(fromId, toId, dishIds, onProgress) {
  const result = { copied: 0, skipped: 0 };
  let after = "";
  for (let i = 0; i < 1000; i++) {
    const res = await api.call("copyDishes", { bookId: fromId, toBookId: toId, dishIds, after });
    result.copied += res.copied;
    result.skipped += res.skipped;
    if (onProgress) onProgress(res.done, res.total);
    if (!res.next) break;
    after = res.next;
  }
  return result;
}

async function dishCount(bookId) {
  return (await api.call("count", { bookId, collection: "dishes" })).total;
}

// 加入前先看看是哪一本：{ bookId, name, memberCount, dishCount, ownerName, status: "" | "pending" | "member" }
const peek = (code) => api.call("peekCode", { code });
// 申请加入，返回 "pending"（等本主同意）或 "member"（已经在里面了）
const requestJoin = async (code, myName) => (await act("requestJoin", { code, myName })).status;
const cancelRequest = (bookId) => act("cancelRequest", { bookId });
const approve = (bookId, memberId) => act("approve", { bookId, memberId });
const reject = (bookId, memberId) => act("reject", { bookId, memberId });
const rename = (bookId, name) => act("renameBook", { bookId, name });
const setMyName = (bookId, name) => act("setMyName", { bookId, name });
const newCode = (bookId) => act("newCode", { bookId });
const removeMember = (bookId, memberId) => act("removeMember", { bookId, memberId });
const setDefault = (bookId) => act("setDefault", { bookId });

// 退出一本（最后一个人退出，这本就删掉了）。退出的是正在用的那本，回到个人本本
async function leave(bookId) {
  const res = await api.call("leaveBook", { bookId });
  if (bookId === currentId) setCurrent(res.me.personalBookId);
  apply(res);
  Object.keys(cacheBases).forEach((base) => storage.remove(cacheKey(base, bookId)));
  return res;
}

module.exports = {
  ready,
  currentId: getCurrentId,
  onSwitch,
  cacheKey,
  switchTo,
  openShared,
  refresh,
  // 跟 plan.js 这些共用记录一样的接口，dish.js 刷新数据时一起刷新
  getVersion: () => version,
  whenFresh: () => ready().then(() => false),
  syncIfStale: refreshIfStale,
  sync: refresh,
  current,
  get,
  list,
  pending,
  has,
  isShared,
  memberNames,
  personalId,
  defaultBook,
  updateDot,
  requestCount,
  takeWelcome,
  showNotices,
  create,
  copyDishes,
  dishCount,
  peek,
  requestJoin,
  cancelRequest,
  approve,
  reject,
  rename,
  setMyName,
  newCode,
  removeMember,
  setDefault,
  leave,
};
