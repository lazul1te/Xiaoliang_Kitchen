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

// 分页把整个集合读完：两个人记的菜都会读到
async function fetchAll(name) {
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
}

const errorText = (err) => (err && (err.errMsg || err.message)) || String(err);

function friendly(text, raw) {
  const e = new Error(text);
  e.friendly = true;
  e.raw = raw || text;
  return e;
}

// 集合还没建
function isCollectionMissing(err) {
  return /-502005|collection not exist|table not exist/i.test(errorText(err));
}

// doc(id).get() 时这条记录已经不在了
function isDocMissing(err) {
  const msg = errorText(err);
  return /does not exist|document.*not exist/i.test(msg) && !/collection/i.test(msg);
}

// 写操作返回「改了 0 条」时用：要么对方刚好删掉了它，要么集合权限不允许改对方加的内容
function notWritten() {
  return friendly(`没改成：可能对方刚好删掉了它。如果一直这样，检查一下集合权限是不是设成了自定义安全规则 ${SHARED_RULE}`);
}

// 把云开发的报错翻成看得懂的话
function explain(err) {
  if (err && err.friendly) return err;
  const msg = errorText(err);
  if (isCollectionMissing(err)) {
    return friendly(
      `云数据库里还没建好集合：请在云开发控制台新建 ${COLLECTIONS} 四个集合，权限设成自定义安全规则 ${SHARED_RULE}`,
      msg
    );
  }
  if (/-502003|permission denied/i.test(msg)) {
    return friendly(`没有权限读写云数据库：请把 ${COLLECTIONS} 四个集合的权限都设成自定义安全规则 ${SHARED_RULE}`, msg);
  }
  if (/env/i.test(msg) && /not exist|invalid|not found/i.test(msg)) {
    return friendly("找不到云开发环境：检查一下 miniprogram/config.js 里的环境 ID", msg);
  }
  if (/timeout|request:fail|network/i.test(msg)) return friendly("网络不太好，稍后再试", msg);
  return friendly(msg, msg);
}

module.exports = { SHARED_RULE, init, collection, command, fetchAll, isCollectionMissing, isDocMissing, notWritten, explain };
