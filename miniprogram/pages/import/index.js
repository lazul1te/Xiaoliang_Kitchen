// 数据导入：从微信聊天记录里选一个 .json 文件（数据导出生成的备份，或者整理好的菜谱），把菜谱和做菜记录加进来
const importService = require("../../services/import");
const ui = require("../../utils/ui");

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
      this.importing = data;
      this.setData({
        status: "ready",
        result: null,
        file: Object.assign(summary, { name: tempFile.name, skipText: summary.skipNames.join("、") }),
      });
    } catch (err) {
      ui.alert("打不开这个文件", ui.errorText(err));
    }
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
