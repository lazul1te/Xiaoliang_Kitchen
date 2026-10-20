// 记录：上面是做饭日历（哪天做了几道菜一眼就能看到），下面是做菜记录。
// 点日历上的某一天，只看那天的记录；点没做饭的日子可以补记一条。
// 开饭时一起记的菜合成一张「一顿饭」的卡片：整桌照片、每道菜的分数，可以再来一单、分享这顿饭
const dishService = require("../../services/dish");
const bookService = require("../../services/book");
const logService = require("../../services/log");
const mealService = require("../../services/meal");
const planService = require("../../services/plan");
const photoService = require("../../services/photo");
const ui = require("../../utils/ui");
const ticketUtil = require("../../utils/ticket");
const { groupByMonth, logStats, buildMonth, dateValue, dayText, toLogCard, timeOf } = require("../../utils/log");
const { entriesOf } = require("../../utils/meal");
const { orderNoText, peopleText, dateText } = require("../../utils/order");

Page({
  data: {
    cal: null, // { title, weeks, monthCount, dishCount, topDishId, topCount }
    calSummary: "", // 本月小结：下厨几次、几道菜、最常做哪道
    selected: "", // 选中的日期 "2026-10-02"，空表示看全部
    dayTitle: "",
    dayLogs: [], // 选中那天的记录（卡片）
    dayEntries: [], // 选中那天：同一顿饭的合成一张卡片（utils/meal.js 的 entriesOf）
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
    bookService.updateDot();
    // 刚开完饭：直接看那一天
    const focus = mealService.takeFocusDate();
    if (focus) {
      const d = new Date(timeOf(focus));
      this.calYear = d.getFullYear();
      this.calMonth = d.getMonth();
      this.setData({ selected: focus });
    }
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
    let meals = [];
    try {
      [logs, dishes, meals] = await Promise.all([logService.listLogs(), dishService.listDishes(), mealService.listMeals()]);
    } catch (err) {
      ui.toast(ui.errorText(err));
    }
    // 菜改过名的话，记录里显示现在的名字
    this.names = {};
    dishes.forEach((d) => {
      this.names[d._id] = d.name;
    });
    this.meals = {};
    meals.forEach((m) => {
      this.meals[m._id] = m;
    });
    this.logs = logs;
    const months = groupByMonth(logs, this.names, this.meals);
    months.forEach((month) =>
      month.days.forEach((day) => {
        day.entries = entriesOf(day.logs, this.meals);
      })
    );
    this.setData({ months, stats: logStats(logs), loaded: true });
    this.renderCalendar();
  },

  renderCalendar() {
    const selected = this.data.selected;
    const dayLogs = selected ? this.logs.filter((l) => dateValue(l.cookedAt) === selected) : [];
    const cal = buildMonth(this.calYear, this.calMonth, this.logs);
    const top = cal.topDishId ? this.names[cal.topDishId] : "";
    const cards = dayLogs.map((l) => toLogCard(l, this.names, this.meals));
    this.setData({
      cal,
      calSummary: cal.monthCount
        ? `这个月下厨 ${cal.monthCount} 次 · 做了 ${cal.dishCount} 道菜` + (top ? ` · 最常做「${top}」` : "")
        : "这个月还没下厨",
      dayLogs: cards,
      dayEntries: entriesOf(cards, this.meals),
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

  // ---------- 一顿饭 ----------

  // 再来一单：这顿的菜按当时的份数放回菜篮（已经删掉的菜跳过）
  onReorder(e) {
    const meal = this.meals[e.currentTarget.dataset.id];
    if (!meal) return;
    const counts = {};
    meal.items.forEach((i) => {
      if (this.names[i.dishId]) counts[i.dishId] = i.qty;
    });
    if (!Object.keys(counts).length) {
      ui.toast("这顿的菜都已经删掉了");
      return;
    }
    planService.addMany(counts);
    wx.switchTab({ url: "/pages/today/index", success: () => ui.toast("放进菜篮了") });
  },

  // 分享这顿饭：画一张盖着「已开饭」的小票，最上面是整桌照片，弹出微信的分享图片菜单
  async onShareMeal(e) {
    const meal = this.meals[e.currentTarget.dataset.id];
    if (!meal || this.drawing) return;
    this.drawing = true;
    wx.showLoading({ title: "生成图片", mask: true });
    let path;
    try {
      const canvas = await ticketUtil.getCanvas(this);
      const photo = meal.photo ? await ticketUtil.loadImage(canvas, await photoService.urlOf(meal.photo)) : null;
      const logs = this.logs.filter((l) => l.mealId === meal._id);
      const qty = {};
      meal.items.forEach((i) => {
        qty[i.dishId] = i.qty;
      });
      path = await ticketUtil.ticketImage(canvas, {
        title: meal.no ? "点菜单" : "这一顿",
        noText: meal.no ? orderNoText(meal.no) : "",
        lines: [`${dateText(meal.date)} · ${meal.meal}`].concat(peopleText(meal) ? [peopleText(meal)] : []),
        items: logs.map((l) => ({
          name: `${this.names[l.dishId] || l.dishName}${qty[l.dishId] > 1 ? ` ×${qty[l.dishId]}` : ""}`,
          right: l.rating ? "★".repeat(l.rating) + "☆".repeat(5 - l.rating) : "",
        })),
        notes: meal.note ? [meal.note] : [],
        stamp: "已开饭",
        photo,
      });
    } catch (err) {
      wx.hideLoading();
      this.drawing = false;
      ui.alert("图片没生成好", ui.errorText(err));
      return;
    }
    wx.hideLoading();
    this.drawing = false;
    if (wx.showShareImageMenu) {
      wx.showShareImageMenu({ path, fail: (err) => ui.apiFail("分享图片", err) });
    } else {
      wx.previewImage({ urls: [path] });
    }
  },

  // ---------- 记录 ----------

  onOpenLog(e) {
    wx.navigateTo({ url: `/pages/log-edit/index?id=${e.currentTarget.dataset.id}` });
  },

  // 记一笔：点开了某一天就记在那天，不然记在今天。同一天可以记好几道
  onAddLog(e) {
    const date = (e && e.currentTarget.dataset.date) || "";
    wx.navigateTo({ url: date ? `/pages/log-edit/index?date=${date}` : "/pages/log-edit/index" });
  },
});
