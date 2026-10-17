// 今日：点菜篮里点好的菜（购物清单在 M3 加）
const dishService = require("../../services/dish");
const basketStore = require("../../store/basket");
const { toCard } = require("../../utils/dish");

Page({
  data: {
    items: [], // 点了的菜（卡片）
    basket: {},
    count: 0, // 总份数
  },

  onShow() {
    basketStore.updateBadge();
    this.refresh();
  },

  async refresh() {
    const basket = basketStore.getBasket();
    const dishes = await dishService.listDishes();
    // 按点菜的先后顺序排
    const items = Object.keys(basket)
      .map((id) => dishes.find((d) => d._id === id))
      .filter(Boolean)
      .map(toCard);
    this.setData({ items, basket, count: basketStore.getCount(basket) });
  },

  onPlus(e) {
    basketStore.add(e.currentTarget.dataset.id);
    this.refresh();
  },

  onMinus(e) {
    basketStore.remove(e.currentTarget.dataset.id);
    this.refresh();
  },

  onClear() {
    wx.showModal({
      title: "清空今天点的菜？",
      confirmText: "清空",
      confirmColor: "#3B3B42",
      success: (res) => {
        if (!res.confirm) return;
        basketStore.clear();
        this.refresh();
      },
    });
  },

  onOpenDish(e) {
    wx.navigateTo({ url: `/pages/dish-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  onGoMenu() {
    wx.switchTab({ url: "/pages/menu/index" });
  },
});
