// 云开发：初始化，以及读写云数据库时用的小工具
const { ENV_ID } = require("../config");

const PAGE_SIZE = 20; // 小程序端一次最多只能读 20 条
// 两个人共用：categories、dishes、plans、cook_logs 四个集合的权限都要设成这条自定义安全规则。
// 意思是用微信打开这个小程序的人都能读写；体验版只有体验成员能打开。
// （控制台不接受 { "read": true, "write": true } 这种写法，会报 rule invalid）
const SHARED_RULE = '{ "read": "auth.openid != null", "write": "auth.openid != null" }';
const COLLECTIONS = "categories、dishes、plans、cook_logs";
let ready = false;

function init() {
  if (ready) return;
  if (!wx.cloud) throw new Error("微信版本太旧，用不了云开发，请先升级微信");
  // 没填环境 ID 时，用账号下第一个创建的环境
  wx.cloud.init(ENV_ID ? { env: ENV_ID, traceUser: true } : { traceUser: true });
  ready = true;
}

function collection(name) {
  init();
  return wx.cloud.database().collection(name);
}

// 更新操作符，比如 command().set(数组) 表示整个替换掉这个字段
function command() {
  init();
  return wx.cloud.database().command;
}

// 分页把整个集合读完：两个人记的菜都会读到。出错时报错里会写明是哪个集合
async function fetchAll(name) {
  try {
    const col = collection(name);
    const { total } = await col.count();
    const tasks = [];
    for (let skip = 0; skip < total; skip += PAGE_SIZE) {
      tasks.push(col.orderBy("createdAt", "asc").orderBy("_id", "asc").skip(skip).limit(PAGE_SIZE).get());
    }
    const pages = await Promise.all(tasks);
    const seen = {};
    const all = [];
    pages.forEach((res) =>
      res.data.forEach((doc) => {
        if (seen[doc._id]) return;
        seen[doc._id] = true;
        all.push(doc);
      })
    );
    return all;
  } catch (err) {
    throw explain(err, name);
  }
}

// 按 _id 找一条记录，找不到返回 null。
// 用条件查询而不是 doc(id).get()：后者找不到时会报错，报错文字还不固定，不好判断
async function findOne(name, id) {
  try {
    const res = await collection(name).where({ _id: id }).limit(1).get();
    return res.data[0] || null;
  } catch (err) {
    throw explain(err, name);
  }
}

const errorText = (err) => (err && (err.raw || err.errMsg || err.message)) || String(err);

function friendly(text, raw, code, name) {
  const e = new Error(text);
  e.friendly = true;
  e.raw = raw || text;
  e.code = code || "";
  e.collection = name || "";
  return e;
}

// 集合还没建
function isCollectionMissing(err) {
  return (err && err.code === "COLLECTION_MISSING") || /-502005|collection not exist|table not exist/i.test(errorText(err));
}

// doc(id) 找不到这条记录（文字有好几种写法）
function isDocMissing(err) {
  const msg = errorText(err);
  return /does not exist|document.*not exist|cannot find document/i.test(msg) && !/collection/i.test(msg);
}

// 写操作返回「改了 0 条」时用：要么对方刚好删掉了它，要么集合权限不允许改对方加的内容
function notWritten(name) {
  const which = name ? ` ${name} ` : "";
  return friendly(`没改成：可能对方刚好删掉了它。如果一直这样，检查一下${which}集合权限是不是设成了自定义安全规则 ${SHARED_RULE}`, "", "NOT_WRITTEN", name);
}

// 把云开发的报错翻成看得懂的话。name：出错的是哪个集合（知道的话写进提示里）
function explain(err, name) {
  if (err && err.friendly) return err;
  const msg = errorText(err);
  const which = name || COLLECTIONS;
  if (isCollectionMissing(err)) {
    return friendly(
      name
        ? `云数据库里还没有 ${name} 集合：请在云开发控制台新建这个集合，权限设成自定义安全规则 ${SHARED_RULE}`
        : `云数据库里还没建好集合：请在云开发控制台新建 ${COLLECTIONS} 四个集合，权限设成自定义安全规则 ${SHARED_RULE}`,
      msg,
      "COLLECTION_MISSING",
      name
    );
  }
  if (/-502003|permission denied/i.test(msg)) {
    return friendly(`没有权限读写 ${which}：请把它的权限设成自定义安全规则 ${SHARED_RULE}`, msg, "PERMISSION", name);
  }
  if (/duplicate|dup key/i.test(msg)) {
    // 共用记录已经有了却看不到，多半是集合权限还是「仅创建者可读写」
    return friendly(`看不到对方建的记录：检查一下 ${which} 的权限是不是设成了自定义安全规则 ${SHARED_RULE}`, msg, "PERMISSION", name);
  }
  if (/env/i.test(msg) && /not exist|invalid|not found/i.test(msg)) {
    return friendly("找不到云开发环境：检查一下 miniprogram/config.js 里的环境 ID", msg, "ENV", name);
  }
  if (/timeout|request:fail|network/i.test(msg)) return friendly("网络不太好，稍后再试", msg, "NETWORK", name);
  return friendly(msg, msg, "", name);
}

// 「我的 → 检查一下云开发」：四个集合挨个读一下，看是不是都建好了、读得到
async function checkCollections() {
  const names = ["categories", "dishes", "plans", "cook_logs"];
  return Promise.all(
    names.map((name) =>
      collection(name)
        .limit(1)
        .get()
        .then(
          () => ({ name, ok: true, text: "正常" }),
          (err) => {
            const e = explain(err, name);
            const text = { COLLECTION_MISSING: "还没建", PERMISSION: "权限不对", NETWORK: "网络不好" }[e.code] || e.message;
            return { name, ok: false, text };
          }
        )
    )
  );
}

module.exports = {
  SHARED_RULE,
  init,
  collection,
  command,
  fetchAll,
  findOne,
  isCollectionMissing,
  isDocMissing,
  notWritten,
  explain,
  checkCollections,
};
