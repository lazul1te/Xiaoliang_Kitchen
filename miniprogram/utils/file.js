// 把文件或文字交给用户：发到微信聊天、存到电脑（电脑版微信）、复制成文字；以及粘贴导入时读剪贴板。
// 发送、保存、复制都要在点按钮的那一下直接调用。
// 手机上小程序打不开系统的文件管理器，所以「本地文件」要么先分享到微信聊天里，要么复制成文字粘贴进来。
const ui = require("./ui");

const COPY_LIMIT = 500 * 1024; // 复制成文字最多 50 万字（带照片的备份太大，只能用文件）

// 电脑版微信（Windows / Mac）能弹出「保存到电脑」；开发者工具里也试一下
function canSaveToDisk() {
  if (typeof wx.saveFileToDisk !== "function") return false;
  let platform = "";
  try {
    platform = (wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()).platform;
  } catch (e) {}
  return ["windows", "mac", "devtools"].indexOf(platform) >= 0;
}

function shareToChat(filePath, fileName) {
  wx.shareFileMessage({
    filePath,
    fileName,
    success: () => ui.toast("已发送"),
    fail: (err) => ui.apiFail("发送", err),
  });
}

function saveToDisk(filePath) {
  wx.saveFileToDisk({
    filePath,
    success: () => ui.toast("已保存"),
    fail: (err) => ui.apiFail("保存到电脑", err),
  });
}

// 复制成文字。tip：复制好以后弹窗说一句接下来怎么用（不写就只有微信自己的「内容已复制」）
function copyText(text, tip) {
  if (text.length > COPY_LIMIT) {
    ui.alert("内容太长，复制不了", "带照片的备份太大了，请用「发到微信」或「存到电脑」。");
    return;
  }
  wx.setClipboardData({
    data: text,
    success: () => {
      if (tip) ui.alert("已复制", tip);
    },
    fail: (err) => ui.apiFail("复制", err),
  });
}

// 读剪贴板（粘贴导入）。读不到返回 null，原因已经提示过了
function readClipboard() {
  return new Promise((resolve) => {
    wx.getClipboardData({
      success: (res) => resolve(String(res.data || "")),
      fail: (err) => {
        ui.apiFail("读取剪贴板", err);
        resolve(null);
      },
    });
  });
}

module.exports = { canSaveToDisk, shareToChat, saveToDisk, copyText, readClipboard };
