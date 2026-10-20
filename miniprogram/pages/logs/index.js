// 记录：上面是做饭日历（哪天做了几道菜一眼就能看到），下面是做菜记录。
// 日历默认收起，只显示一周；点「展开整月」看整月，展开时左右滑换月。
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
const { entriesOf, mealTicket } = require("../../utils/meal");

const SWIPE_PX = 50; // 日历上横着滑这么远才算换月
const STAMP_HIT_MS = 650; // 「已开饭」的章落下来的那一下（app.wxss 的 .meal-stamp：0.3 秒后开始、0.5 秒的 70%）

Page({
  data: {
    cal: null, // { title, weeks, monthCount, dishCount, topDishId, topCount }
    calOpen: false, // 日历展开了没有：收起时只显示一周
    weeks: [], // 日历上显示的几周：展开是整月，收起是选中的那天（没选就是今天）那一周
    calAnim: "", // 换月、展开时日历的动画
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
    // 刚开完饭：直接看那一天，给这一顿盖个「已开饭」的章
    const fresh = mealService.takeFreshMeal();
    if (fresh) {
      this.freshMeal = fresh;
      setTimeout(() => ui.buzz("medium"), STAMP_HIT_MS);
    }
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

  onHide() {
    this.freshMeal = ""; // 章只盖这一回
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
    const dayEntries = entriesOf(cards, this.meals);
    dayEntries.forEach((entry) => {
      if (entry.type === "meal" && entry.meal._id === this.freshMeal) entry.meal.fresh = true;
    });
    this.setData({
      cal,
      weeks: this.data.calOpen ? cal.weeks : [cal.weeks[this.focusWeek(cal)]],
      calSummary: cal.monthCount
        ? `这个月下厨 ${cal.monthCount} 次 · 做了 ${cal.dishCount} 道菜` + (top ? ` · 最常做「${top}」` : "")
        : "这个月还没下厨",
      dayLogs: cards,
      dayEntries,
      dayTitle: selected ? `${dayText(timeOf(selected))} · 做了 ${dayLogs.length} 道菜` : "",
    });
  },

  // 收起时显示哪一周：选中的那天所在的那周，没选就是今天那周（都不在这个月就显示第一周）
  focusWeek(cal) {
    const focus = this.data.selected || dateValue(Date.now());
    const i = cal.weeks.findIndex((w) => w.days.some((d) => d.date === focus));
    return i >= 0 ? i : 0;
  },

  // ---------- 日历 ----------

  // 展开整月 / 收起成一周。收起时回到选中的那天（没选就是今天）所在的月份
  onToggleCalendar() {
    const calOpen = !this.data.calOpen;
    if (!calOpen) {
      const d = new Date(timeOf(this.data.selected || dateValue(Date.now())));
      this.calYear = d.getFullYear();
      this.calMonth = d.getMonth();
    }
    this.setData({ calOpen, calAnim: calOpen ? "unfold" : "" });
    this.renderCalendar();
  },

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
    // 新的一个月从右边（下个月）或者左边（上个月）滑进来；1、2 轮流换，连着换月也每次都有动画
    this.flip = !this.flip;
    this.setData({ selected: "", calAnim: (delta > 0 ? "next" : "prev") + (this.flip ? "1" : "2") });
    this.renderCalendar();
  },

  onCalTouchStart(e) {
    const t = e.touches[0];
    this.touchStart = { x: t.clientX, y: t.clientY };
  },

  // 展开时左右滑换月：往左滑看下个月，往右滑看上个月（斜着滑、滑得短都不算）
  onCalTouchEnd(e) {
    const start = this.touchStart;
    this.touchStart = null;
    if (!start || !this.data.calOpen) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    this.moveMonth(dx < 0 ? 1 : -1);
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
  async onReorder(e) {
    if (!(await mealService.reorder(e.currentTarget.dataset.id))) {
      ui.toast("这顿的菜都已经删掉了");
      return;
    }
    // 已经下了单：就是给这单加菜；还没下单：去确认点菜单
    if (planService.getOrder()) wx.switchTab({ url: "/pages/today/index", success: () => ui.toast("加进点菜单了") });
    else wx.navigateTo({ url: "/pages/checkout/index", success: () => ui.toast("放进菜篮了") });
  },

  // 分享这顿饭：画一张盖着「已开饭」的小票，最上面是整桌照片，弹出微信的分享图片菜单
  async onShareMeal(e) {
    const meal = this.meals[e.currentTarget.dataset.id];
    if (!meal) return;
    const logs = this.logs.filter((l) => l.mealId === meal._id);
    const photo = meal.photo ? await photoService.urlOf(meal.photo) : "";
    await ticketUtil.shareTicket(this, mealTicket(meal, logs, this.names), photo);
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
