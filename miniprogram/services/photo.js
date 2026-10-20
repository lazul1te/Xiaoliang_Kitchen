// 照片的显示地址。数据库里存的是云文件 ID（cloud://…），免费环境的云存储只有上传的人能读、权限也改不了，
// 所以显示前先请云函数 api（管理员身份）换成临时链接：只给你那几本小本本里的照片换，缓存一会儿，过期了再换。
// 云函数还没部署时退回直接用文件 ID：自己传的照片照样能看，家人传的看不到（「我的 → 检查一下云开发」会提示）。
const cloud = require("./cloud");
const api = require("./api");

const TTL = 9 * 60 * 1000; // 临时链接至少 10 分钟有效，提前 1 分钟换新的
const BATCH = 50;

const cache = {}; // 文件 ID → { url, expires }
let queue = []; // 等着换链接的 { id, resolve }
let timer = null;
let functionMissing = false; // 云函数没部署：这次打开小程序里不再试

function isCloudFile(id) {
  return typeof id === "string" && id.indexOf("cloud://") === 0;
}

async function flush() {
  timer = null;
  const batch = queue;
  queue = [];
  const ids = [...new Set(batch.map((b) => b.id))];
  const urls = {};
  try {
    if (functionMissing) throw new Error("FUNCTION_NOT_FOUND");
    const parts = [];
    for (let i = 0; i < ids.length; i += BATCH) parts.push(api.call("urls", { fileIDs: ids.slice(i, i + BATCH) }));
    (await Promise.all(parts)).forEach((res) => Object.assign(urls, res.urls || {}));
    const expires = Date.now() + TTL;
    Object.keys(urls).forEach((id) => {
      cache[id] = { url: urls[id], expires };
    });
  } catch (err) {
    if (err.code === "NO_API" || cloud.isFunctionMissing(err)) functionMissing = true;
    // 云函数调不通：直接用文件 ID，自己传的照片照样能显示
    ids.forEach((id) => {
      urls[id] = id;
    });
  }
  batch.forEach((b) => b.resolve(urls[b.id] || ""));
}

// 一张照片的显示地址：云文件换成临时链接，手机上的临时文件原样返回，换不到（文件没了、不是你那几本里的）返回空字符串。
// 同一时间要显示的照片攒成一批，只调一次云函数。fresh：不用缓存（链接过期了）
function urlOf(id, fresh) {
  if (!isCloudFile(id)) return Promise.resolve(id || "");
  const hit = cache[id];
  if (!fresh && hit && hit.expires > Date.now()) return Promise.resolve(hit.url);
  return new Promise((resolve) => {
    queue.push({ id, resolve });
    if (!timer) timer = setTimeout(flush, 20); // 同一屏的照片攒一小会儿，一起换
  });
}

// 删照片：交给云函数（家人传的也能删）；云函数没部署时自己删，删不掉家人的就算了，只是多占一点空间
function remove(ids) {
  const list = ids.filter(isCloudFile);
  if (!list.length) return Promise.resolve();
  list.forEach((id) => delete cache[id]);
  return api.call("removeFiles", { fileIDs: list }).catch(() => {
    cloud.init();
    return wx.cloud.deleteFile({ fileList: list }).catch(() => {});
  });
}

// 读一张照片的内容（base64），导出时自己读不到的照片（家人传的）用这个；读不到返回空字符串
async function read(id) {
  try {
    return (await api.call("readFile", { fileID: id })).base64 || "";
  } catch (err) {
    return "";
  }
}

// 「我的 → 检查一下云开发」：试着给几张照片换链接，看照片还在不在
async function check(fileIDs) {
  const list = [...new Set(fileIDs.filter(isCloudFile))].slice(0, BATCH);
  if (!list.length) return { name: "照片", ok: true, text: "还没有照片" };
  try {
    const res = await api.call("urls", { fileIDs: list });
    const missing = (res.missing || []).length + (res.denied || []).length;
    if (!missing) return { name: "照片", ok: true, text: `正常（试了 ${list.length} 张）` };
    return { name: "照片", ok: false, text: `试了 ${list.length} 张，${missing} 张已经不在云存储里了` };
  } catch (err) {
    return { name: "照片", ok: false, text: cloud.explain(err).message };
  }
}

module.exports = { isCloudFile, urlOf, remove, read, check };
