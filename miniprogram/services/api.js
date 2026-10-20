// 小程序读写云上的数据只走这一个口子：云函数 api（cloudfunctions/api）。
// 微信会把调用的人是谁直接交给云函数，手机上改不了；云函数先查你是不是这本小本本的成员，再去读写数据库和照片。
// 差不多同一时间发出的几个请求合成一次调用：打开小程序时要读好几样，只跑一趟。
const cloud = require("./cloud");

const FUNCTION = "api";
const MAX_BATCH = 20;
let queue = [];
let scheduled = false;
const notMemberHooks = [];

// 调一个操作，返回它的结果；出错时是看得懂的报错（err.code 是哪种问题）
function call(action, params) {
  return new Promise((resolve, reject) => {
    queue.push({ call: Object.assign({ action }, params), resolve, reject });
    if (scheduled) return;
    scheduled = true;
    // 等几轮再发：中间隔着几个 await 先后发出的请求也能合成一次
    let wait = Promise.resolve();
    for (let i = 0; i < 4; i++) wait = wait.then(() => {});
    wait.then(flush);
  });
}

function flush() {
  scheduled = false;
  const all = queue;
  queue = [];
  for (let i = 0; i < all.length; i += MAX_BATCH) send(all.slice(i, i + MAX_BATCH));
}

async function invoke(data) {
  cloud.init();
  const res = await wx.cloud.callFunction({ name: FUNCTION, data });
  return res.result || {};
}

async function send(batch) {
  let results;
  try {
    if (batch.length === 1) results = [await invoke(batch[0].call)];
    else results = (await invoke({ action: "batch", calls: batch.map((b) => b.call) })).results || [];
  } catch (err) {
    const e = cloud.explain(err);
    batch.forEach((b) => b.reject(e));
    return;
  }
  batch.forEach((b, i) => {
    const r = results[i];
    if (r && r.ok) {
      b.resolve(r.data);
      return;
    }
    const error = (r && r.error) || {};
    const e = cloud.friendly(error.message || "云函数没有返回结果，稍后再试", "", error.code || "SERVER");
    if (e.code === "NOT_MEMBER" && b.call.bookId) notMemberHooks.forEach((fn) => fn(b.call.bookId));
    b.reject(e);
  });
}

// 发现自己已经不在某本里了（被移出、那本删掉了）时通知一下（book.js 用来切回个人本本）
function onNotMember(fn) {
  notMemberHooks.push(fn);
}

module.exports = { call, onNotMember };
