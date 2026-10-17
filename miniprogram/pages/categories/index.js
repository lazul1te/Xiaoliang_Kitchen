// 分类管理：新建、改名、删除、调整顺序（顺序就是菜单左边的顺序）
const categoryService = require("../../services/category");
const dishService = require("../../services/dish");
const ui = require("../../utils/ui");

Page({
  data: {
    list: [], // [{ _id, name, sort, count }]
    loaded: false,
  },

  onShow() {
    this.refresh();
    dishService.refreshIfStale().then((changed) => {
      if (changed) this.refresh();
    });
  },

  async refresh() {
    try {
      const list = await categoryService.listWithCount();
      this.setData({ list, loaded: true });
    } catch (err) {
      this.setData({ loaded: true });
      ui.alert("没读到分类", ui.errorText(err));
    }
  },

  // 改动都要写云数据库，期间显示「保存中」，做完刷新列表
  async run(task) {
    if (this.busy) return;
    this.busy = true;
    wx.showLoading({ title: "保存中", mask: true });
    try {
      await task();
      wx.hideLoading();
    } catch (err) {
      wx.hideLoading();
      ui.alert("没改成", ui.errorText(err));
    }
    this.busy = false;
    this.refresh();
  },

  async onAdd() {
    const name = await ui.prompt({ title: "新建分类", placeholder: "比如：早餐" });
    if (name === null) return;
    return this.run(() => categoryService.addCategory(name));
  },

  async onRename(e) {
    const item = this.data.list[e.currentTarget.dataset.index];
    const name = await ui.prompt({ title: "改分类名", placeholder: item.name, value: item.name });
    if (name === null || name === item.name) return;
    return this.run(() => categoryService.renameCategory(item._id, name));
  },

  async onRemove(e) {
    const item = this.data.list[e.currentTarget.dataset.index];
    if (item.count) {
      ui.alert("还不能删", `「${item.name}」里还有 ${item.count} 道菜，先把它们改到别的分类再删。`);
      return;
    }
    const ok = await ui.confirm({ title: `删除「${item.name}」？`, confirmText: "删除", danger: true });
    if (!ok) return;
    return this.run(() => categoryService.removeCategory(item._id));
  },

  // data-dir：-1 上移，1 下移
  onMove(e) {
    const { index, dir } = e.currentTarget.dataset;
    const target = index + dir;
    if (target < 0 || target >= this.data.list.length) return;
    return this.run(() => categoryService.moveCategory(this.data.list[index]._id, dir));
  },
});
