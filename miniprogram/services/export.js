// 数据导出：把菜谱、分类、做菜记录、菜篮、库存、想吃清单打包成一个 .json 文件，可以选择把照片也一起打包。
// 免费的云开发环境万一以后要收费或者停用了，有这个文件就能把数据完整搬走。
const store = require("./store");
const planService = require("./plan");
const pantryService = require("./pantry");
const wishService = require("./wish");
const imageService = require("./image");
const cloud = require("./cloud");

const APP = "nashoucai-xiaobenben";
const FORMAT = 1;

const pad = (n) => (n < 10 ? `0${n}` : String(n));

// 菜品成品照、步骤照片、做菜记录和想吃清单的照片（小图可以重新生成，不带）
function photoIds(dishes, logs, wishes) {
  const ids = [];
  const add = (id) => {
    if (imageService.isCloudFile(id) && ids.indexOf(id) < 0) ids.push(id);
  };
  dishes.forEach((d) => {
    add(d.cover);
    d.steps.forEach((s) => add(s.image));
  });
  logs.forEach((l) => add(l.photo));
  (wishes || []).forEach((w) => add(w.photo));
  return ids;
}

// 导出页上显示的概况
async function summary() {
  await store.ensureLoaded();
  const dishes = store.listDishes();
  const logs = store.listLogs();
  return {
    categoryCount: store.listCategories().length,
    dishCount: dishes.length,
    logCount: logs.length,
    photoCount: photoIds(dishes, logs, wishService.list()).length,
  };
}

// 生成导出文件，返回 { filePath, fileName, size, photoCount, failedPhotos }。
// onProgress(文字) 用来在页面上显示进度
async function buildFile({ withPhotos, onProgress }) {
  const progress = onProgress || (() => {});
  progress("正在整理数据…");
  await store.ensureLoaded();
  await store.whenFresh().catch(() => {}); // 尽量用云上最新的；没网就用手机上缓存的
  const dishes = store.listDishes();
  const logs = store.listLogs();
  const data = {
    app: APP,
    format: FORMAT,
    exportedAt: Date.now(),
    categories: store.listCategories(),
    dishes,
    logs,
    plan: planService.getPlan(),
    pantry: pantryService.getItems(),
    wishes: wishService.list(),
    photos: {}, // 云文件 ID → 照片内容（base64）
  };
  const fs = wx.getFileSystemManager();
  let failedPhotos = 0;
  if (withPhotos) {
    cloud.init();
    const ids = photoIds(dishes, logs, data.wishes);
    for (let i = 0; i < ids.length; i++) {
      progress(`正在打包照片 ${i + 1}/${ids.length}`);
      try {
        const res = await wx.cloud.downloadFile({ fileID: ids[i] });
        data.photos[ids[i]] = fs.readFileSync(res.tempFilePath, "base64");
      } catch (e) {
        failedPhotos += 1; // 下载失败的照片跳过，不影响其他数据
      }
    }
  }
  progress("正在生成文件…");
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const filePath = `${wx.env.USER_DATA_PATH}/nashoucai-backup.json`;
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
  return {
    filePath,
    fileName: `拿手菜小本本备份-${stamp}.json`,
    size: fs.statSync(filePath).size,
    photoCount: Object.keys(data.photos).length,
    failedPhotos,
  };
}

module.exports = { summary, buildFile };
