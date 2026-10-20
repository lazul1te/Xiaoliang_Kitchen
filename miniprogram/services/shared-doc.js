// 共用记录：plans 集合里每本小本本各有一条的几样东西，这本里的人一起看、一起改。
//   current  菜篮（点了哪些菜）、点菜单和买菜清单的勾选   → services/plan.js
//   pantry   家里的库存                                → services/pantry.js
//   wishes   想吃清单                                  → services/wish.js
// 手机上先改（按了马上有反应），后台再按顺序写云上；每次只改对应的那个字段，
// 几个人同时改不同的东西不会互相覆盖。写失败会提示，并以云上的为准重新同步。
// 换了一本就换成那本的（book.onSwitch），本地缓存每本各存一份。
const cloud = require("./cloud");
const db = require("./db");
const book = require("./book");
const storage = require("../utils/storage");
const ui = require("../utils/ui");

const COLLECTION = "plans";
let queue = Promise.resolve(); // 所有共用记录的写操作排一个队，一个一个来
let alerted = false; // 云函数没部署、集合建不了这类问题只弹一次窗，之后用轻提示

function reportError(label, err) {
  const e = cloud.explain(err);
  if (!alerted && (e.code === "COLLECTION_MISSING" || e.code === "NO_API")) {
    alerted = true;
    ui.alert(`${label}没存上`, e.message);
  } else {
    ui.toast(`${label}没同步上，稍后再试`);
  }
}

// id：current / pantry / wishes；label：提示里怎么称呼它；normalize(doc)：把云上的记录整理成固定格式（doc 可能是 null）
function createSharedDoc({ id, cacheKey, label, normalize, onChange }) {
  let value = null;
  let loadedFor = ""; // value 是哪本的
  let syncing = null;
  let lastSyncAt = 0;
  let fresh = false;
  let started = false;
  let writes = 0; // 本地改动计数：同步期间有新改动的话，取回来的就是旧数据，要再取一次
  let version = 0;

  function changed() {
    version += 1;
    try {
      storage.set(book.cacheKey(cacheKey, loadedFor), value);
    } catch (e) {} // 缓存写不进去不影响使用
    if (onChange) onChange(value);
  }

  book.onSwitch(() => {
    value = null;
    loadedFor = "";
    syncing = null;
    lastSyncAt = 0;
    fresh = false;
    started = false;
    version += 1;
    if (onChange) onChange(load());
  });

  function load() {
    const bookId = book.currentId();
    if (!value || loadedFor !== bookId) {
      value = normalize(bookId ? storage.get(book.cacheKey(cacheKey, bookId)) : null);
      loadedFor = bookId;
    }
    return value;
  }

  // 当前内容（同步返回）。第一次用时先拿本地缓存，同时在后台去云上取最新的
  function current() {
    load();
    if (!started) {
      started = true;
      sync().catch(() => {});
    }
    return value;
  }

  // 从云上取最新的，返回有没有变。等手上的写操作都写完了再取，免得取回旧数据
  function sync() {
    if (syncing) return syncing;
    started = true;
    const startWrites = writes;
    const task = queue
      .then(() => book.ready())
      .then(() => {
        const bookId = book.currentId();
        return db.findOne(COLLECTION, id, bookId).then((doc) => {
          if (syncing === task) syncing = null;
          if (bookId !== book.currentId()) return false; // 这期间换了一本
          if (writes !== startWrites) return sync();
          load();
          const next = normalize(doc);
          lastSyncAt = Date.now();
          fresh = true;
          if (JSON.stringify(next) === JSON.stringify(value)) return false;
          value = next;
          changed();
          return true;
        });
      })
      .catch((err) => {
        if (syncing === task) syncing = null;
        throw cloud.explain(err);
      });
    syncing = task;
    return task;
  }

  function whenFresh() {
    load();
    return fresh ? Promise.resolve(false) : sync();
  }

  function syncIfStale(maxAge) {
    if (syncing) return syncing;
    if (fresh && Date.now() - lastSyncAt < maxAge) return Promise.resolve(false);
    return sync();
  }

  // 改内容：mutate(value) 先改手机上的；buildUpdate(_) 返回要写到云上的字段（只写改了的那几个）。
  // 写到改的时候正在用的那本（排队期间换了本本也不会写错）
  function write(mutate, buildUpdate) {
    mutate(load());
    writes += 1;
    changed();
    const bookId = loadedFor;
    const done = queue.then(async () => {
      const data = Object.assign(buildUpdate(db.command()), { updatedAt: Date.now() }); // 带上时间，保证每次都真的改到了
      const res = await db.collection(COLLECTION, bookId).doc(id).update({ data });
      if (res.stats && res.stats.updated === 0) throw cloud.notWritten();
    });
    queue = done.catch((err) => {
      reportError(label, err);
      sync().catch(() => {}); // 以云上的为准
    });
    return queue;
  }

  return { current, sync, whenFresh, syncIfStale, write, getVersion: () => version };
}

module.exports = { createSharedDoc };
