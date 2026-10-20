// 云函数 api：小程序读写数据只走这里。微信会把调用的人是谁（OPENID）直接交给云函数，手机上改不了；
// 这里先查 TA 是不是这本小本本的成员，再用管理员身份读写数据库和照片。
// 请求是 { action, bookId, ... }，几个请求可以合成一次：{ action: "batch", calls: [请求, ...] }。
// 返回 { ok: true, data } 或 { ok: false, error: { code, message } }；batch 返回 { ok: true, results: [每个请求的结果] }
//   lib/books.js   我的本本、新建、家庭码、申请加入和本主审核、成员、退出
//   lib/data.js    一本里的数据：打开一本、读写分类/菜/记录/每一顿/菜篮库存想吃清单、复制菜到另一本
//   lib/photos.js  照片：换临时链接、删、读（只管你那几本里的）
//   lib/legacy.js  以前共用的旧数据，第一次打开新版本时变成家庭本本「我们家的小本本」
const { cloud, errorText } = require("./lib/common");
const books = require("./lib/books");
const data = require("./lib/data");
const photos = require("./lib/photos");

const ACTIONS = Object.assign({}, books.actions, data.actions, photos.actions);
const MAX_BATCH = 50;

async function run(ctx, call) {
  const action = call && call.action;
  try {
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
      const e = new Error(`不认识的操作：${action}`);
      e.code = "BAD_ACTION";
      e.expected = true;
      throw e;
    }
    return { ok: true, data: await ACTIONS[action](ctx, call) };
  } catch (err) {
    if (err && err.expected) return { ok: false, error: { code: err.code, message: err.message } };
    console.error(action, err);
    return { ok: false, error: { code: "SERVER", message: `云函数出错了：${errorText(err)}` } };
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, error: { code: "NO_USER", message: "没拿到微信身份：要从小程序里调用" } };
  const ctx = { openid: OPENID, bookTasks: {} };
  if (event && event.action === "batch") {
    const calls = Array.isArray(event.calls) ? event.calls.slice(0, MAX_BATCH) : [];
    return { ok: true, results: await Promise.all(calls.map((c) => run(ctx, c))) };
  }
  return run(ctx, event || {});
};
