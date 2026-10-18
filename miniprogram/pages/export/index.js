// 备份到微信（数据导出）：先生成文件，再存起来——发到微信聊天、存到电脑（电脑版微信）、或者复制成文字。
// 发送 / 保存 / 复制必须是点按钮的那一下直接调用，所以分成两步
const exportService = require("../../services/export");
const ui = require("../../utils/ui");
const fileUtil = require("../../utils/file");

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
    canSaveToDisk: false, // 电脑版微信：可以直接存到电脑
  },

  async onLoad() {
    this.setData({ canSaveToDisk: fileUtil.canSaveToDisk() });
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
    if (this.data.status !== "ready") return;
    fileUtil.shareToChat(this.data.file.filePath, this.data.file.fileName);
  },

  onSaveToDisk() {
    if (this.data.status !== "ready") return;
    fileUtil.saveToDisk(this.data.file.filePath);
  },

  // 复制成文字（不带照片时）：粘贴到备忘录里存着，以后「粘贴复制的内容」导回来
  onCopy() {
    if (this.data.status !== "ready") return;
    const text = wx.getFileSystemManager().readFileSync(this.data.file.filePath, "utf8");
    fileUtil.copyText(text, "可以粘贴到备忘录里存着，或者发给自己。以后在「从文件导入」里点「粘贴复制的内容」就能导回来。");
  },
});
