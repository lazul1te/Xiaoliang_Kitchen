// 照片的读和删统一交给这个云函数（管理员身份）来做。
// 免费环境的云存储权限是「只有上传的人能读」，而且改不了，所以小程序里直接读不到对方传的照片；
// 云函数不受这个限制：这里给两个人换照片的临时链接、删照片、读照片内容（导出备份用）。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 只处理这个小程序自己放照片的几个文件夹
const OWN = /^cloud:\/\/[^/]+\/(covers|thumbs|steps|logs|wishes)\/[^/]+$/;
const BATCH = 50; // getTempFileURL / deleteFile 一次最多 50 个
const MAX_IDS = 200;
const MAX_READ = 2 * 1024 * 1024; // 导出时一张照片最大 2MB（压缩过的照片一般 300KB 以内）

function ownIds(list) {
  return (Array.isArray(list) ? list : []).filter((id) => typeof id === "string" && OWN.test(id)).slice(0, MAX_IDS);
}

// 换临时链接：{ urls: { 文件ID: 链接 }, missing: [已经不在了的文件ID] }
async function urls(ids) {
  const out = { urls: {}, missing: [] };
  for (let i = 0; i < ids.length; i += BATCH) {
    const res = await cloud.getTempFileURL({ fileList: ids.slice(i, i + BATCH) });
    res.fileList.forEach((f) => {
      if (f.status === 0 && f.tempFileURL) out.urls[f.fileID] = f.tempFileURL;
      else out.missing.push(f.fileID);
    });
  }
  return out;
}

async function remove(ids) {
  let removed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const res = await cloud.deleteFile({ fileList: ids.slice(i, i + BATCH) });
    removed += res.fileList.filter((f) => f.status === 0).length;
  }
  return { removed };
}

// 读一张照片的内容（base64），导出备份时用
async function read(id) {
  try {
    const res = await cloud.downloadFile({ fileID: id });
    if (res.fileContent.length > MAX_READ) return { tooBig: true };
    return { base64: res.fileContent.toString("base64") };
  } catch (err) {
    return { missing: true };
  }
}

exports.main = async (event) => {
  const ids = ownIds(event.fileIDs);
  if (event.action === "urls") return urls(ids);
  if (event.action === "remove") return remove(ids);
  if (event.action === "read") return ids.length ? read(ids[0]) : { missing: true };
  return { error: `不认识的操作：${event.action}` };
};
