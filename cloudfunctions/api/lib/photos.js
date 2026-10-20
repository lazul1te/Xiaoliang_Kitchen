// 照片：免费环境的云存储只有上传的人能读，而且改不了，所以看、删、读家人传的照片都交给云函数（管理员身份）。
// 只处理你是成员的那几本里的照片：新照片放在 books/<bookId>/covers|thumbs|steps|logs|wishes/ 下面，
// 以前的照片（路径里没有 books/）算旧数据变成的那本（legacy）的
const { cloud, fail, randomId, myBookIds, LEGACY_ID } = require("./common");

const OWN = /^cloud:\/\/[^/]+\/(?:books\/([\w-]+)\/)?(covers|thumbs|steps|logs|wishes)\/[^/]+$/;
const BATCH = 50; // getTempFileURL / deleteFile 一次最多 50 个
const MAX_IDS = 200;
const MAX_READ = 2 * 1024 * 1024; // 导出时一张照片最大 2MB（压缩过的照片一般 300KB 以内）

// 照片是哪本的，不是这个小程序的照片返回空字符串
function bookOf(fileID) {
  const m = typeof fileID === "string" ? OWN.exec(fileID) : null;
  return m ? m[1] || LEGACY_ID : "";
}

// 分成你能用的、不能用的（不是你那几本里的）
async function sortOut(ctx, list) {
  const mine = await myBookIds(ctx);
  const ids = (Array.isArray(list) ? list : []).filter((id) => typeof id === "string").slice(0, MAX_IDS);
  return { ok: ids.filter((id) => mine[bookOf(id)]), denied: ids.filter((id) => !mine[bookOf(id)]) };
}

// 删照片（不查是谁的，删一本小本本时用）
async function removeAll(ids) {
  const list = ids.filter((id, i) => bookOf(id) && ids.indexOf(id) === i);
  const tasks = [];
  for (let i = 0; i < list.length; i += BATCH) tasks.push(cloud.deleteFile({ fileList: list.slice(i, i + BATCH) }));
  const results = await Promise.all(tasks);
  return results.reduce((n, res) => n + res.fileList.filter((f) => f.status === 0).length, 0);
}

// 复制一张照片到另一本（复制菜的时候用），返回新的文件 ID；读不到就返回空字符串（这张照片不要了）
async function copy(fileID, bookId) {
  const m = typeof fileID === "string" ? OWN.exec(fileID) : null;
  if (!m) return "";
  try {
    const res = await cloud.downloadFile({ fileID });
    const ext = (/\.\w+$/.exec(fileID) || [".jpg"])[0];
    const up = await cloud.uploadFile({ cloudPath: `books/${bookId}/${m[2]}/${randomId("c")}${ext}`, fileContent: res.fileContent });
    return up.fileID;
  } catch (err) {
    return "";
  }
}

// 换临时链接：{ urls: { 文件ID: 链接 }, missing: [已经不在了的], denied: [不是你那几本里的] }
async function urls(ctx, { fileIDs }) {
  const { ok, denied } = await sortOut(ctx, fileIDs);
  const out = { urls: {}, missing: [], denied };
  for (let i = 0; i < ok.length; i += BATCH) {
    const res = await cloud.getTempFileURL({ fileList: ok.slice(i, i + BATCH) });
    res.fileList.forEach((f) => {
      if (f.status === 0 && f.tempFileURL) out.urls[f.fileID] = f.tempFileURL;
      else out.missing.push(f.fileID);
    });
  }
  return out;
}

async function removeFiles(ctx, { fileIDs }) {
  const { ok } = await sortOut(ctx, fileIDs);
  return { removed: await removeAll(ok) };
}

// 读一张照片的内容（base64），导出备份时用
async function readFile(ctx, { fileID }) {
  const { ok } = await sortOut(ctx, [fileID]);
  if (!ok.length) throw fail("NOT_MEMBER", "这张照片不是你的小本本里的");
  try {
    const res = await cloud.downloadFile({ fileID });
    if (res.fileContent.length > MAX_READ) return { tooBig: true };
    return { base64: res.fileContent.toString("base64") };
  } catch (err) {
    return { missing: true };
  }
}

module.exports = {
  bookOf,
  removeAll,
  copy,
  actions: { urls, removeFiles, readFile },
};
