// 备份与导入：备份到微信（数据导出）、从文件导入（数据导入），还有自己写新菜用的导入模板
const template = require("../../data/import-template");
const ui = require("../../utils/ui");
const fileUtil = require("../../utils/file");

const templateText = () => JSON.stringify(template, null, 2);

function writeTemplate() {
  const filePath = `${wx.env.USER_DATA_PATH}/import-template.json`;
  try {
    wx.getFileSystemManager().writeFileSync(filePath, templateText(), "utf8");
    return filePath;
  } catch (err) {
    ui.alert("模板没生成出来", ui.errorText(err));
    return "";
  }
}

Page({
  data: {
    canSaveToDisk: false, // 电脑版微信：可以直接存到电脑
  },

  onLoad() {
    this.setData({ canSaveToDisk: fileUtil.canSaveToDisk() });
  },

  onOpenExport() {
    wx.navigateTo({ url: "/pages/export/index" });
  },

  onOpenImport() {
    wx.navigateTo({ url: "/pages/import/index" });
  },

  // 把导入模板存成文件发到微信聊天里：在电脑上照着改好，再发回来导入
  onSendTemplate() {
    const filePath = writeTemplate();
    if (filePath) fileUtil.shareToChat(filePath, "菜谱导入模板.json");
  },

  onSaveTemplate() {
    const filePath = writeTemplate();
    if (filePath) fileUtil.saveToDisk(filePath);
  },

  // 复制模板：在手机备忘录里改，改好全选复制，再「粘贴复制的内容」导入，不用经过聊天
  onCopyTemplate() {
    fileUtil.copyText(templateText(), "粘贴到备忘录里，照着例子改好，再全选复制，到「从文件导入」点「粘贴复制的内容」。");
  },
});
