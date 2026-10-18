// 我的：菜谱统计、常用的（想吃清单、库存）放大方块，不常用的（备份与导入、检查云开发）收起来
const dishService = require("../../services/dish");
const planService = require("../../services/plan");
const pantryService = require("../../services/pantry");
const wishService = require("../../services/wish");
const diagnose = require("../../services/diagnose");
const ui = require("../../utils/ui");

Page({
  data: {
    stats: { total: 0, mastered: 0, cooked: 0 },
    sampleCount: 0, // 还剩几道示例菜
    wishCount: 0, // 想吃清单里有几个
    outCount: 0, // 库存里几样用完了
    stockCount: 0, // 库存里家里有几样
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
      wishCount: wishService.list().length,
      outCount: pantryService.list().outOfStock.length,
      stockCount: pantryService.list().inStock.length,
    });
  },

  onOpenWishes() {
    wx.navigateTo({ url: "/pages/wishes/index" });
  },

  onOpenPantry() {
    wx.navigateTo({ url: "/pages/pantry/index" });
  },

  // 底部小字「遇到问题？检查一下云开发」
  onCheckDatabase() {
    return diagnose.run();
  },

  onGoMenu() {
    wx.switchTab({ url: "/pages/menu/index" });
  },

  onGoLogs() {
    wx.switchTab({ url: "/pages/logs/index" });
  },

  onOpenBackup() {
    wx.navigateTo({ url: "/pages/backup/index" });
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
});
