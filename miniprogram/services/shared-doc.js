// 共用记录：云数据库 plans 集合里 _id 固定的几条记录，两个人一起看、一起改。
//   current  菜篮（点了哪些菜）和买菜清单的勾选      → services/plan.js
//   pantry   家里的库存                              → services/pantry.js
//   wishes   想吃清单                                → services/wish.js
// 手机上先改（按了马上有反应），后台再按顺序写云上；每次只改对应的那个字段，
// 两个人同时改不同的东西不会互相覆盖。写失败会提示，并以云上的为准重新同步。
const cloud = require("./cloud");
const storage = require("../utils/storage");
const ui = require("../utils/ui");

const COLLECTION = "plans";
let queue = Promise.resolve(); // 所有共用记录的写操作排一个队，一个一个来
let alerted = false; // 集合没建、权限不对这类问题只弹一次窗，之后用轻提示

function reportError(label, err) {
  const e = cloud.explain(err, COLLECTION);
  if (!alerted && (e.code === "COLLECTION_MISSING" || e.code === "PERMISSION")) {
    alerted = true;
    ui.alert(`${label}没存上`, e.message);
  } else {
    ui.toast(`${label}没同步上，稍后再试`);
  }
}

// id：记录的 _id；label：提示里怎么称呼它；normalize(doc)：把云上的记录整理成固定格式（doc 可能是 null）
function createSharedDoc({ id, cacheKey, label, normalize, onChange }) {
  let value = null;
  let syncing = null;
  let lastSyncAt = 0;
  let fresh = false;
  let started = false;
  let writes = 0; // 本地改动计数：同步期间有新改动的话，取回来的就是旧数据，要再取一次
  let version = 0;
  let docReady = false; // 云上这条记录是不是已经有了

  function changed() {
    version += 1;
    try {
      storage.set(cacheKey, value);
    } catch (e) {} // 缓存写不进去不影响使用
    if (onChange) onChange(value);
  }

  function load() {
    if (!value) value = normalize(storage.get(cacheKey));
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

  async function fetchDoc() {
    const doc = await cloud.findOne(COLLECTION, id);
    if (doc) docReady = true;
    return doc;
  }

  // 从云上取最新的，返回有没有变。等手上的写操作都写完了再取，免得取回旧数据
  function sync() {
    if (syncing) return syncing;
    load();
    started = true;
    const startWrites = writes;
    syncing = queue.then(fetchDoc).then(
      (doc) => {
        syncing = null;
        if (writes !== startWrites) return sync();
        const next = normalize(doc);
        lastSyncAt = Date.now();
        fresh = true;
        if (JSON.stringify(next) === JSON.stringify(value)) return false;
        value = next;
        changed();
        return true;
      },
      (err) => {
        syncing = null;
        throw cloud.explain(err, COLLECTION);
      }
    );
    return syncing;
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

  // 云上还没有这条记录就建一条。两个人可能同时在建，建失败时再看一眼，已经有了就行
  async function ensureDoc() {
    if (docReady) return;
    if (await fetchDoc()) return;
    try {
      await cloud.collection(COLLECTION).add({ data: Object.assign({ _id: id, createdAt: Date.now() }, normalize(null)) });
    } catch (err) {
      if (!(await fetchDoc())) throw err;
    }
    docReady = true;
  }

  // 改内容：mutate(value) 先改手机上的；buildUpdate(_) 返回要写到云上的字段（只写改了的那几个）
  function write(mutate, buildUpdate) {
    mutate(load());
    writes += 1;
    changed();
    const done = queue.then(async () => {
      await ensureDoc();
      const data = Object.assign(buildUpdate(cloud.command()), { updatedAt: Date.now() }); // 带上时间，保证每次都真的改到了
      const res = await cloud.collection(COLLECTION).doc(id).update({ data });
      if (res.stats && res.stats.updated === 0) throw cloud.notWritten(COLLECTION);
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
