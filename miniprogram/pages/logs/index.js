// 记录：上面是做饭日历（哪天做了几道菜一眼就能看到），下面是做菜记录。
// 点日历上的某一天，只看那天的记录；点没做饭的日子可以补记一条
const dishService = require("../../services/dish");
const logService = require("../../services/log");
const planService = require("../../services/plan");
const ui = require("../../utils/ui");
const { groupByMonth, logStats, buildMonth, dateValue, dayText, toLogCard, timeOf } = require("../../utils/log");

Page({
  data: {
    cal: null, // { title, weeks, monthCount }
    selected: "", // 选中的日期 "2026-10-02"，空表示看全部
    dayTitle: "",
    dayLogs: [], // 选中那天的记录（卡片）
    months: [], // 全部记录：[{ key, title, count, days: [{ key, title, logs }] }]
    stats: { thisMonth: 0, total: 0, dishCount: 0 },
    loaded: false,
  },

  onLoad() {
    const now = new Date();
    this.calYear = now.getFullYear();
    this.calMonth = now.getMonth();
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
      ui.showError(err);
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
    this.names = {};
    dishes.forEach((d) => {
      this.names[d._id] = d.name;
    });
    this.logs = logs;
    this.setData({ months: groupByMonth(logs, this.names), stats: logStats(logs), loaded: true });
    this.renderCalendar();
  },

  renderCalendar() {
    const selected = this.data.selected;
    const dayLogs = selected ? this.logs.filter((l) => dateValue(l.cookedAt) === selected) : [];
    this.setData({
      cal: buildMonth(this.calYear, this.calMonth, this.logs),
      dayLogs: dayLogs.map((l) => toLogCard(l, this.names)),
      dayTitle: selected ? `${dayText(timeOf(selected))} · 做了 ${dayLogs.length} 道菜` : "",
    });
  },

  // ---------- 日历 ----------

  onPrevMonth() {
    this.moveMonth(-1);
  },

  onNextMonth() {
    this.moveMonth(1);
  },

  moveMonth(delta) {
    const d = new Date(this.calYear, this.calMonth + delta, 1);
    this.calYear = d.getFullYear();
    this.calMonth = d.getMonth();
    this.setData({ selected: "" });
    this.renderCalendar();
  },

  async onTapDay(e) {
    const { date, count, future } = e.currentTarget.dataset;
    if (!date || future) return;
    if (count) {
      // 再点一下同一天，回到看全部
      this.setData({ selected: this.data.selected === date ? "" : date });
      this.renderCalendar();
      return;
    }
    const ok = await ui.confirm({ title: `${dayText(timeOf(date))}没有记录`, content: "那天做饭了的话，补记一条？", confirmText: "补记" });
    if (ok) wx.navigateTo({ url: `/pages/log-edit/index?date=${date}` });
  },

  onShowAll() {
    this.setData({ selected: "" });
    this.renderCalendar();
  },

  // ---------- 记录 ----------

  onOpenLog(e) {
    wx.navigateTo({ url: `/pages/log-edit/index?id=${e.currentTarget.dataset.id}` });
  },

  onAddLog() {
    wx.navigateTo({ url: "/pages/log-edit/index" });
  },
});
