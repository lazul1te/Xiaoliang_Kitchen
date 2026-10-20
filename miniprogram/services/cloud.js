// 云开发：初始化，以及把报错翻成看得懂的话。
// 读写数据都交给云函数 api（见 api.js、db.js），小程序不直接读写云数据库
const { ENV_ID } = require("../config");

const DEPLOY_TIP = "在开发者工具左边的 cloudfunctions 里右键 api 文件夹，选「上传并部署：云端安装依赖」，部署好以后重新打开小程序";
const NO_API_TEXT = `云函数 api 还没部署：${DEPLOY_TIP}`;
let ready = false;

function init() {
  if (ready) return;
  if (!wx.cloud) throw new Error("微信版本太旧，用不了云开发，请先升级微信");
  // 没填环境 ID 时，用账号下第一个创建的环境
  wx.cloud.init(ENV_ID ? { env: ENV_ID, traceUser: true } : { traceUser: true });
  ready = true;
}

const errorText = (err) => (err && (err.raw || err.errMsg || err.message)) || String(err);

// code：哪种问题（NO_API 云函数没部署、NETWORK 网络、NOT_MEMBER 不在这本里了……），页面可以按它决定怎么提示
function friendly(text, raw, code) {
  const e = new Error(text);
  e.friendly = true;
  e.raw = raw || text;
  e.code = code || "";
  return e;
}

function isFunctionMissing(err) {
  return /-501000|FunctionName|ResourceNotFound\.Function|FUNCTION_NOT_FOUND|未找到指定的\s*Function/i.test(errorText(err));
}

// 写操作返回「改了 0 条」：多半是刚被删掉了
function notWritten() {
  return friendly("没改成：可能刚被删掉了，下拉刷新看看", "", "NOT_WRITTEN");
}

// 把云开发的报错翻成看得懂的话（云函数已经翻好的原样返回）
function explain(err) {
  if (err && err.friendly) return err;
  const msg = errorText(err);
  if (isFunctionMissing(err)) return friendly(NO_API_TEXT, msg, "NO_API");
  if (/-504003|timed out after/i.test(msg)) return friendly("云函数超时了，稍后再试", msg, "TIMEOUT");
  if (/env/i.test(msg) && /not exist|invalid|not found/i.test(msg)) {
    return friendly("找不到云开发环境：检查一下 miniprogram/config.js 里的环境 ID", msg, "ENV");
  }
  if (/timeout|request:fail|network/i.test(msg)) return friendly("网络不太好，稍后再试", msg, "NETWORK");
  return friendly(msg, msg, "");
}

module.exports = { DEPLOY_TIP, NO_API_TEXT, init, friendly, isFunctionMissing, notWritten, explain };
