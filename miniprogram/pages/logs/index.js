// 记录：两个人的做菜记录，按月份和日期排好；点一条可以修改，也可以补记以前做过的
const dishService = require("../../services/dish");
const logService = require("../../services/log");
const planService = require("../../services/plan");
const ui = require("../../utils/ui");
const { groupByMonth, logStats } = require("../../utils/log");

Page({
  data: {
    months: [], // [{ key, title, count, days: [{ key, title, logs: [卡片] }] }]
    stats: { thisMonth: 0, total: 0, dishCount: 0 },
    loaded: false,
  },

  onShow() {
    planService.updateBadge();
    this.refresh();
    // 对方可能刚打过卡，隔一会儿回来就去云上看看
    dishService.refreshIfStale().then((changed) => {
      if (changed) this.refresh();
    });
  },

  async onPullDownRefresh() {
    try {
      await dishService.sync();
    } catch (err) {
      ui.toast(ui.errorText(err));
    }
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  async refresh() {
    let logs = [];
    let dishes = [];
    try {
      [logs, dishes] = await Promise.all([logService.listLogs(), dishService.listDishes()]);
    } catch (err) {
      ui.toast(ui.errorText(err));
    }
    // 菜改过名的话，记录里显示现在的名字
    const names = {};
    dishes.forEach((d) => {
      names[d._id] = d.name;
    });
    this.setData({ months: groupByMonth(logs, names), stats: logStats(logs), loaded: true });
  },

  onOpenLog(e) {
    wx.navigateTo({ url: `/pages/log-edit/index?id=${e.currentTarget.dataset.id}` });
  },

  onAddLog() {
    wx.navigateTo({ url: "/pages/log-edit/index" });
  },
});
