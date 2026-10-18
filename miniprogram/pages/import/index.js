// 从文件导入：两种拿到内容的办法
// - 从微信聊天里选 .json 文件（手机上的文件先分享到「文件传输助手」，电脑上的文件拖进去）
// - 粘贴：用备忘录、记事本打开文件，全选复制，再点「粘贴复制的内容」（不用经过聊天）
// 内容可以是备份文件，也可以是照着导入模板写的菜谱
const importService = require("../../services/import");
const ui = require("../../utils/ui");
const fileUtil = require("../../utils/file");

Page({
  data: {
    status: "idle", // idle 还没选文件 / ready 选好了 / working 导入中 / done 导完了
    file: null, // { name, dishCount, newCount, skipNames, skipText, logCount, photoCount }
    progress: "",
    result: null, // { added, skipped, logsAdded }
  },

  onChoose() {
    if (this.data.status === "working") return;
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: ["json"],
      success: (res) => this.readFile(res.tempFiles[0]),
      fail: (err) => ui.apiFail("选文件", err),
    });
  },

  async readFile(tempFile) {
    try {
      const { data, summary } = await importService.readFile(tempFile.path);
      this.showReady(data, summary, tempFile.name);
    } catch (err) {
      ui.alert("打不开这个文件", ui.errorText(err));
    }
  },

  // 粘贴：读剪贴板里复制的文字
  async onPaste() {
    if (this.data.status === "working") return;
    const text = await fileUtil.readClipboard();
    if (text === null) return;
    try {
      const { data, summary } = await importService.readText(text);
      this.showReady(data, summary, "复制的内容");
    } catch (err) {
      ui.alert("导入不了", ui.errorText(err));
    }
  },

  showReady(data, summary, name) {
    this.importing = data;
    this.setData({
      status: "ready",
      result: null,
      file: Object.assign(summary, { name, skipText: summary.skipNames.join("、") }),
    });
  },

  async onImport() {
    if (this.data.status !== "ready") return;
    if (!this.data.file.newCount) {
      ui.toast("这些菜都已经有了");
      return;
    }
    this.setData({ status: "working", progress: "准备导入…" });
    try {
      const result = await importService.importData(this.importing, (progress) => this.setData({ progress }));
      this.setData({ status: "done", result });
      if (result.logsError) ui.alert("菜谱导进来了，做菜记录没导进去", result.logsError);
    } catch (err) {
      this.setData({ status: "ready" });
      ui.alert("导入失败", `${ui.errorText(err)}\n已经导进来的菜不会重复，可以再导入一次。`);
    }
  },

  onGoMenu() {
    wx.switchTab({ url: "/pages/menu/index" });
  },
});
