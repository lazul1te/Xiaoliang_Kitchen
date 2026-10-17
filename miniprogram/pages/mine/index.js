// 我的：小程序信息、菜谱统计、设置入口
const dishService = require("../../services/dish");
const planService = require("../../services/plan");
const ui = require("../../utils/ui");

Page({
  data: {
    stats: { total: 0, mastered: 0, cooked: 0 },
    sampleCount: 0, // 还剩几道示例菜
  },

  onShow() {
    planService.updateBadge();
    this.refresh();
    dishService.refreshIfStale().then((changed) => {
      if (changed) this.refresh();
    });
  },

  async refresh() {
    let dishes;
    try {
      dishes = await dishService.listDishes();
    } catch (err) {
      return; // 读不到就先显示 0，菜单页会提示具体原因
    }
    this.setData({
      stats: {
        total: dishes.length,
        mastered: dishes.filter((d) => d.status === "mastered").length,
        cooked: dishes.reduce((sum, d) => sum + (d.cookCount || 0), 0),
      },
      sampleCount: dishes.filter((d) => d.sample).length,
    });
  },

  onOpenCategories() {
    wx.navigateTo({ url: "/pages/categories/index" });
  },

  async onRemoveSamples() {
    const ok = await ui.confirm({
      title: `删除 ${this.data.sampleCount} 道示例菜？`,
      content: "两个人的菜单里都会删掉。你们自己加的菜、改过的示例菜都会留着。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    wx.showLoading({ title: "删除中", mask: true });
    try {
      const count = await dishService.removeSamples();
      wx.hideLoading();
      ui.toast(`已删除 ${count} 道示例菜`);
    } catch (err) {
      wx.hideLoading();
      ui.alert("没删成", ui.errorText(err));
    }
    await this.refresh();
  },

  onOpenExport() {
    wx.navigateTo({ url: "/pages/export/index" });
  },
});
