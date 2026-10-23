// 点菜单记录：最上面是正在进行的那一单（点一下回菜篮），下面是开过饭的点菜单，新的在前，按月分组。
// 撤掉的单不记（编号也不占）。每单跟记录页的「一顿饭」卡片一样：能再来一单、分享这顿饭，点菜名看那条做菜记录；
// 以前没下单就开饭的那几顿没有编号，在「记录」页里
const dishService = require("../../services/dish");
const logService = require("../../services/log");
const mealService = require("../../services/meal");
const planService = require("../../services/plan");
const photoService = require("../../services/photo");
const ui = require("../../utils/ui");
const ticketUtil = require("../../utils/ticket");
const { toLogCard } = require("../../utils/log");
const { mealCard, mealTicket } = require("../../utils/meal");
const { dateText, ticketOf } = require("../../utils/order");

const SHOW_DISHES = 3; // 正在进行的那单最多列几道菜的名字

// 日期新的在前，同一天后记的在前
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt);

Page({
  data: {
    loaded: false,
    current: null, // 正在进行的那一单 { noText, title, dishesText, peopleText }
    months: [], // [{ title: "2026年10月", cards: [一顿饭的卡片] }]
    count: 0, // 开过饭的点菜单一共几单
    unnumbered: 0, // 以前没下单就开饭的几顿（在「记录」页里）
  },

  onShow() {
    this.load();
    // 家人可能刚开过饭，隔一会儿回来就去云上看看
    dishService.refreshIfStale().then((changed) => {
      if (changed) this.load();
    });
  },

  async onPullDownRefresh() {
    try {
      await dishService.sync();
    } catch (err) {
      ui.showError(err);
    }
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    let dishes = [];
    let logs = [];
    let meals = [];
    try {
      [dishes, logs, meals] = await Promise.all([dishService.listDishes(), logService.listLogs(), mealService.listMeals()]);
    } catch (err) {
      ui.toast(ui.errorText(err));
    }
    this.names = {};
    dishes.forEach((d) => {
      this.names[d._id] = d.name;
    });
    this.meals = {};
    meals.forEach((m) => {
      this.meals[m._id] = m;
    });
    this.logs = logs;
    // 每一顿的做菜记录（卡片）
    const byMeal = {};
    logs.forEach((l) => {
      if (!l.mealId || !this.meals[l.mealId]) return;
      (byMeal[l.mealId] = byMeal[l.mealId] || []).push(toLogCard(l, this.names, this.meals));
    });
    const months = [];
    meals
      .filter((m) => m.no > 0)
      .sort(byDateDesc)
      .forEach((m) => {
        const [y, mo] = m.date.split("-");
        const title = `${y}年${Number(mo)}月`;
        let month = months[months.length - 1];
        if (!month || month.title !== title) {
          month = { title, cards: [] };
          months.push(month);
        }
        month.cards.push(Object.assign(mealCard(m, byMeal[m._id] || []), { title: `${dateText(m.date)} · ${m.meal}`, date: m.date }));
      });
    this.setData({
      loaded: true,
      current: this.currentOrder(dishes),
      months,
      count: months.reduce((n, m) => n + m.cards.length, 0),
      unnumbered: meals.filter((m) => !m.no).length,
    });
  },

  // 正在进行的那一单（还没开饭）
  currentOrder(dishes) {
    const order = planService.getOrder();
    if (!order) return null;
    const basket = planService.getBasket();
    const t = ticketOf(order, dishes.filter((d) => basket[d._id]).map((dish) => ({ dish, qty: basket[dish._id] })));
    const names = t.items.map((i) => i.name);
    const more = names.length > SHOW_DISHES ? ` 等 ${names.length} 道` : "";
    return {
      noText: t.noText,
      title: `${t.dateText} · ${t.meal}`,
      dishesText: names.slice(0, SHOW_DISHES).join("、") + more,
      peopleText: t.peopleText,
    };
  },

  onOpenCurrent() {
    wx.switchTab({ url: "/pages/today/index" });
  },

  onGoMenu() {
    wx.switchTab({ url: "/pages/menu/index" });
  },

  // ---------- 一顿饭的卡片（templates/meal-card.wxml） ----------

  // 改一改这一顿：整桌照片、哪天、哪一顿、掌勺、心得、每道菜的分数
  onEditMeal(e) {
    wx.navigateTo({ url: `/pages/meal/index?id=${e.currentTarget.dataset.id}` });
  },

  onOpenLog(e) {
    wx.navigateTo({ url: `/pages/log-edit/index?id=${e.currentTarget.dataset.id}` });
  },

  // 再来一单：这顿的菜按当时的份数放回菜篮
  async onReorder(e) {
    if (!(await mealService.reorder(e.currentTarget.dataset.id))) {
      ui.toast("这顿的菜都已经删掉了");
      return;
    }
    // 已经下了单：就是给这单加菜；还没下单：去确认点菜单
    if (planService.getOrder()) wx.switchTab({ url: "/pages/today/index", success: () => ui.toast("加进点菜单了") });
    else wx.navigateTo({ url: "/pages/checkout/index", success: () => ui.toast("放进菜篮了") });
  },

  // 分享这顿饭：盖着「已开饭」的小票，最上面是整桌照片
  async onShareMeal(e) {
    const meal = this.meals[e.currentTarget.dataset.id];
    if (!meal) return;
    const logs = this.logs.filter((l) => l.mealId === meal._id);
    const photo = meal.photo ? await photoService.urlOf(meal.photo) : "";
    await ticketUtil.shareTicket(this, mealTicket(meal, logs, this.names), photo);
  },

  // 在记录里看：去记录页，选中那天
  onOpenDay(e) {
    mealService.setFocusDate(e.currentTarget.dataset.date);
    wx.switchTab({ url: "/pages/logs/index" });
  },
});
