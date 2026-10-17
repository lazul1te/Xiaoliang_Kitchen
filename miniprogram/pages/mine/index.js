// 我的：小程序信息、菜谱统计、设置入口
const dishService = require("../../services/dish");
const basketStore = require("../../store/basket");

Page({
  data: {
    stats: { total: 0, mastered: 0, cooked: 0 },
  },

  async onShow() {
    basketStore.updateBadge();
    const dishes = await dishService.listDishes();
    this.setData({
      stats: {
        total: dishes.length,
        mastered: dishes.filter((d) => d.status === "mastered").length,
        cooked: dishes.reduce((sum, d) => sum + (d.cookCount || 0), 0),
      },
    });
  },

  onTodo(e) {
    wx.showToast({ title: `${e.currentTarget.dataset.name}还在开发中`, icon: "none" });
  },
});
