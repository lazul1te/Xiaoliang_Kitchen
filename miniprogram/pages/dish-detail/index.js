// 菜品详情：原料、分步做法、小贴士；底部可以加入点菜篮
const dishService = require("../../services/dish");
const basketStore = require("../../store/basket");
const { toDetail } = require("../../utils/dish");

Page({
  data: {
    dish: null,
    qty: 0, // 点菜篮里这道菜的份数
    notFound: false,
  },

  async onLoad(options) {
    const dish = await dishService.getDish(options.id);
    if (!dish) {
      this.setData({ notFound: true });
      return;
    }
    wx.setNavigationBarTitle({ title: dish.name });
    this.setData({ dish: toDetail(dish) });
    this.refreshQty();
  },

  onShow() {
    if (this.data.dish) this.refreshQty();
  },

  refreshQty() {
    this.setData({ qty: basketStore.getBasket()[this.data.dish._id] || 0 });
  },

  onPlus() {
    const isFirst = this.data.qty === 0;
    basketStore.add(this.data.dish._id);
    this.refreshQty();
    if (isFirst) wx.showToast({ title: "已加入点菜篮", icon: "none" });
  },

  onMinus() {
    basketStore.remove(this.data.dish._id);
    this.refreshQty();
  },

  onEdit() {
    wx.showToast({ title: "编辑功能下一步就做", icon: "none" });
  },

  onStartCook() {
    wx.showToast({ title: "烹饪模式还在开发中", icon: "none" });
  },
});
