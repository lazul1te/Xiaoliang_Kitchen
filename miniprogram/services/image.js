// 照片：从相册选或者拍照 → 压缩 → 传到云存储；删菜、换照片时把云上的旧照片删掉
const cloud = require("./cloud");
const ui = require("../utils/ui");
const { newId } = require("../utils/id");

// 已经传到云存储的照片，路径是 cloud:// 开头；刚选的照片是手机上的临时文件
function isCloudFile(path) {
  return typeof path === "string" && path.indexOf("cloud://") === 0;
}

function compress(src, width, quality) {
  return new Promise((resolve) => {
    wx.compressImage({
      src,
      quality,
      compressedWidth: width,
      success: (res) => resolve(res.tempFilePath),
      fail: () => resolve(src), // 压不了就用原图
    });
  });
}

// 选一张照片（相册或拍照），返回压缩后的临时路径；取消了返回空字符串
function choose() {
  return new Promise((resolve) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["compressed"],
      success: (res) => resolve(compress(res.tempFiles[0].tempFilePath, 1080, 80)),
      fail: (err) => {
        ui.apiFail("选照片", err);
        resolve("");
      },
    });
  });
}

async function upload(filePath, folder) {
  cloud.init();
  const ext = (/\.(jpe?g|png|webp|gif)$/i.exec(filePath) || [".jpg"])[0].toLowerCase();
  const res = await wx.cloud.uploadFile({ cloudPath: `${folder}/${newId()}${ext}`, filePath });
  return res.fileID;
}

// 成品照传两张：大图给详情页，小图给列表（一次显示很多张，用小图省流量）。
// folder：菜品封面放 covers，做菜记录的照片放 logs
async function uploadCover(tempPath, folder) {
  const thumbPath = await compress(tempPath, 320, 70);
  const [cover, thumb] = await Promise.all([upload(tempPath, folder || "covers"), upload(thumbPath, "thumbs")]);
  return { cover, thumb };
}

function uploadPhoto(tempPath) {
  return upload(tempPath, "steps");
}

// 删掉云存储里的照片。删不掉也不影响使用，只是多占一点空间，所以不报错
function remove(fileIDs) {
  const fileList = fileIDs.filter(isCloudFile);
  if (!fileList.length) return Promise.resolve();
  cloud.init();
  return wx.cloud.deleteFile({ fileList }).catch(() => {});
}

module.exports = { isCloudFile, choose, uploadCover, uploadPhoto, remove };
