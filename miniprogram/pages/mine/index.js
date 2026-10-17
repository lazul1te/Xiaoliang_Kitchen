// 我的：小程序信息、菜谱统计、设置入口
const dishService = require("../../services/dish");
const planService = require("../../services/plan");
const pantryService = require("../../services/pantry");
const wishService = require("../../services/wish");
const cloud = require("../../services/cloud");
const photo = require("../../services/photo");
const ui = require("../../utils/ui");

Page({
  data: {
    stats: { total: 0, mastered: 0, cooked: 0 },
    sampleCount: 0, // 还剩几道示例菜
    wishCount: 0, // 想吃清单里有几个
    outCount: 0, // 库存里几样用完了
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
    });
  },

  onOpenWishes() {
    wx.navigateTo({ url: "/pages/wishes/index" });
  },

  onOpenPantry() {
    wx.navigateTo({ url: "/pages/pantry/index" });
  },

  // 四个集合挨个读一下，看是不是都建好了；再试试照片的云函数
  async onCheckDatabase() {
    wx.showLoading({ title: "检查中", mask: true });
    let photos = [];
    try {
      (await dishService.listDishes()).forEach((d) => photos.push(d.coverThumb || d.cover));
    } catch (e) {}
    const results = (await cloud.checkCollections()).concat(await photo.check(photos));
    wx.hideLoading();
    const lines = results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}：${r.text}`);
    const tips = [];
    if (results.some((r) => !r.ok && r.name !== "照片")) {
      tips.push(`数据库：没建的集合在云开发控制台「数据库」里新建，四个集合的权限都设成自定义安全规则 ${cloud.SHARED_RULE}`);
    }
    if (results.some((r) => r.needsFunction)) {
      tips.push("照片：在开发者工具左边的 cloudfunctions 里右键 photo 文件夹，选「上传并部署：云端安装依赖」，部署好以后重新打开小程序");
    }
    const tip = tips.length ? `\n\n${tips.join("\n\n")}` : "\n\n都正常";
    ui.alert("云数据库检查", lines.join("\n") + tip);
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

  onOpenImport() {
    wx.navigateTo({ url: "/pages/import/index" });
  },
});
