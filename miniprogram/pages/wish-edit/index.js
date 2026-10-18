// 记一个想吃的：菜名、一张图、一句备注（在哪吃到的、哪个视频教程……），也用来修改、删除
const wishService = require("../../services/wish");
const imageService = require("../../services/image");
const ui = require("../../utils/ui");

Page({
  data: {
    form: null, // { key, name, photo, note }
    isEdit: false,
  },

  onLoad(options) {
    const wish = options.key ? wishService.get(options.key) : null;
    if (options.key && !wish) {
      ui.alert("找不到了", "可能已经被删掉了").then(() => wx.navigateBack());
      return;
    }
    wx.setNavigationBarTitle({ title: wish ? "想吃的" : "记一个想吃的" });
    this.setData({
      form: wish
        ? { key: wish.key, name: wish.name, photo: wish.photo, note: wish.note }
        : { key: "", name: decodeURIComponent(options.name || "").slice(0, 20), photo: "", note: "" },
      isEdit: !!wish,
    });
  },

  async onChoosePhoto() {
    const path = await imageService.choose();
    if (path) this.setData({ "form.photo": path });
  },

  onRemovePhoto() {
    this.setData({ "form.photo": "" });
  },

  onInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  async onSave() {
    if (this.saving) return;
    if (!this.data.form.name.trim()) {
      ui.toast("写个菜名");
      return;
    }
    this.saving = true;
    wx.showLoading({ title: "保存中", mask: true });
    try {
      await wishService.save(this.data.form);
    } catch (err) {
      wx.hideLoading();
      this.saving = false;
      ui.alert("没存上", ui.errorText(err));
      return;
    }
    wx.hideLoading();
    wx.navigateBack({ success: () => ui.toast("记下了") });
  },

  // 开始学：带着菜名和照片去写菜谱
  onLearn() {
    wx.redirectTo({ url: `/pages/dish-edit/index?wish=${this.data.form.key}` });
  },

  async onDelete() {
    const ok = await ui.confirm({ title: `删掉「${this.data.form.name}」？`, confirmText: "删掉", danger: true });
    if (!ok) return;
    wishService.remove(this.data.form.key);
    wx.navigateBack({ success: () => ui.toast("已删除") });
  },
});
