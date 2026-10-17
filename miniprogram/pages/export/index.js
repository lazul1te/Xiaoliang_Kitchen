// 数据导出：先生成文件，再发到微信聊天里保存（发送必须是点按钮的那一下直接调用，所以分成两步）
const exportService = require("../../services/export");
const ui = require("../../utils/ui");

function sizeText(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

Page({
  data: {
    summary: null, // { categoryCount, dishCount, logCount, photoCount }
    withPhotos: false,
    status: "idle", // idle 还没生成 / working 生成中 / ready 可以发送了
    progress: "",
    file: null, // { filePath, fileName, sizeText, photoCount, failedPhotos }
  },

  async onLoad() {
    try {
      this.setData({ summary: await exportService.summary() });
    } catch (err) {
      ui.alert("没读到数据", ui.errorText(err));
    }
  },

  // 换了「带不带照片」，要重新生成
  onTogglePhotos() {
    if (this.data.status === "working") return;
    this.setData({ withPhotos: !this.data.withPhotos, status: "idle", file: null });
  },

  async onBuild() {
    if (this.data.status === "working") return;
    this.setData({ status: "working", progress: "正在整理数据…", file: null });
    try {
      const file = await exportService.buildFile({
        withPhotos: this.data.withPhotos,
        onProgress: (progress) => this.setData({ progress }),
      });
      this.setData({ status: "ready", file: Object.assign(file, { sizeText: sizeText(file.size) }) });
    } catch (err) {
      this.setData({ status: "idle" });
      ui.alert("没生成成功", ui.errorText(err));
    }
  },

  onSend() {
    const file = this.data.file;
    if (!file) return;
    wx.shareFileMessage({
      filePath: file.filePath,
      fileName: file.fileName,
      success: () => ui.toast("已发送"),
      fail: (err) => ui.apiFail("发送", err),
    });
  },
});
