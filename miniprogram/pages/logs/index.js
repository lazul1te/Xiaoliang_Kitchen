// 做菜记录：M4 实现打卡后在这里按日期展示
const basketStore = require("../../store/basket");

Page({
  onShow() {
    basketStore.updateBadge();
  },
});
