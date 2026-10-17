// 想吃清单：先记个菜名和一张图，以后慢慢学。点「开始学」就写成正式菜谱
const dishService = require("../../services/dish");
const wishService = require("../../services/wish");
const { formatMonthDay } = require("../../utils/dish");

Page({
  data: {
    list: [], // [{ key, name, photo, note, dayText }]
    loaded: false,
  },

  onShow() {
    this.refresh();
    dishService.refreshIfStale().then((changed) => {
      if (changed) this.refresh();
    });
  },

  refresh() {
    this.setData({
      list: wishService.list().map((w) => ({
        key: w.key,
        name: w.name,
        photo: w.photoThumb || w.photo,
        note: w.note,
        dayText: w.createdAt ? `${formatMonthDay(w.createdAt)}记的` : "",
      })),
      loaded: true,
    });
  },

  onAdd() {
    wx.navigateTo({ url: "/pages/wish-edit/index" });
  },

  onOpen(e) {
    wx.navigateTo({ url: `/pages/wish-edit/index?key=${e.currentTarget.dataset.key}` });
  },

  // 开始学：带着菜名和照片去写菜谱，存好以后从想吃清单里拿掉
  onLearn(e) {
    wx.navigateTo({ url: `/pages/dish-edit/index?wish=${e.currentTarget.dataset.key}` });
  },
});
