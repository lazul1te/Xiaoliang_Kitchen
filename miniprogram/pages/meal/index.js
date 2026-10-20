// 开饭啦：这顿做了哪些菜（没做的取消勾选，留在菜篮下次做）、整桌照片、每道菜打个分、掌勺、心得，一次记下来。
// 先下单再开饭：从菜篮「做好了，开饭」、一起做（?from=cook，点过「做好了」的默认勾上）、忘了开饭的提醒（?date=那天）进来。
// 每道做了的菜各记一条做菜记录，日期默认是点菜单上那天；记好以后点菜单的编号就用掉了，一起做的进度清掉
const dishService = require("../../services/dish");
const bookService = require("../../services/book");
const planService = require("../../services/plan");
const mealService = require("../../services/meal");
const logService = require("../../services/log");
const imageService = require("../../services/image");
const cookSession = require("../../services/cook-session");
const storage = require("../../utils/storage");
const ui = require("../../utils/ui");
const { dateValue } = require("../../utils/log");
const { MEALS, dateText, orderNoText, recentNames } = require("../../utils/order");

const COOK_NAME_KEY = "cook_name"; // 这台手机上次写的掌勺（打卡页、菜篮也用）

Page({
  data: {
    ready: false,
    dishes: [], // 菜篮里的菜 [{ dishId, name, qty, checked, rating }]
    madeCount: 0, // 勾上了几道
    photo: "", // 整桌照片（手机上的临时文件）
    date: "",
    today: "",
    yesterday: "",
    dateLabel: "",
    meal: "",
    meals: MEALS,
    cook: "",
    names: [], // 以前写过的名字，点一下就行
    note: "",
    orderText: "", // 「点菜单 No.012」
    stars: [1, 2, 3, 4, 5],
  },

  async onLoad(options) {
    let dishes;
    let logs = [];
    try {
      dishes = await dishService.listDishes();
      logs = await logService.listLogs().catch(() => []);
    } catch (err) {
      await ui.alert("没读到数据", ui.errorText(err));
      wx.navigateBack();
      return;
    }
    const plan = planService.getPlan();
    const planned = dishes.filter((d) => plan.items[d._id]);
    if (!planned.length) {
      await ui.alert("菜篮是空的", "先去菜单点几道菜，做好了再来记");
      wx.navigateBack();
      return;
    }
    const order = plan.order;
    if (!order) {
      // 点菜单撤掉了（可能是家人在别的手机上撤的）
      await ui.alert("还没下单", "先在菜篮里下单，做好了再来开饭");
      wx.navigateBack();
      return;
    }
    const now = Date.now();
    const today = dateValue(now);
    // 日期：忘了开饭时是点菜单那天；点的是以后的日子但今天就做了，记在今天
    const want = options.date || order.date;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(want) && want <= today ? want : today;
    const cook = order.cook || storage.get(COOK_NAME_KEY) || "";
    // 从一起做过来：点过「做好了」的勾上，没点的先不勾（一道都没点就全勾上）
    const session = options.from === "cook" ? cookSession.load() : null;
    const doneIds = session ? planned.filter((d) => session.done[d._id]).map((d) => d._id) : [];
    const checked = (id) => !doneIds.length || doneIds.indexOf(id) >= 0;
    this.mealId = mealService.newMealId(); // 重试时用同一个，不会记两遍
    this.order = order;
    this.setData({
      ready: true,
      dishes: planned.map((d) => ({ dishId: d._id, name: d.name, qty: plan.items[d._id], checked: checked(d._id), rating: 0 })),
      date,
      today,
      yesterday: dateValue(now - 24 * 3600 * 1000),
      dateLabel: dateText(date),
      meal: order.meal,
      cook,
      names: recentNames([cook, storage.get(COOK_NAME_KEY), order.orderedBy].concat(bookService.memberNames(), logs.map((l) => l.cook))),
      orderText: `点菜单 ${orderNoText(order.no)}`,
    });
    this.countMade();
  },

  countMade() {
    this.setData({ madeCount: this.data.dishes.filter((d) => d.checked).length });
  },

  // ---------- 表单 ----------

  async onChoosePhoto() {
    const path = await imageService.choose();
    if (path) this.setData({ photo: path });
  },

  onRemovePhoto() {
    this.setData({ photo: "" });
  },

  onToggleDish(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ [`dishes[${i}].checked`]: !this.data.dishes[i].checked });
    this.countMade();
  },

  // 再点一下同一颗星，就是不打分
  onStar(e) {
    const { i, value } = e.currentTarget.dataset;
    this.setData({ [`dishes[${i}].rating`]: this.data.dishes[i].rating === value ? 0 : value });
  },

  onQuickDate(e) {
    const date = e.currentTarget.dataset.date;
    this.setData({ date, dateLabel: dateText(date) });
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value, dateLabel: dateText(e.detail.value) });
  },

  onPickMeal(e) {
    this.setData({ meal: e.currentTarget.dataset.meal });
  },

  // 再点一下同一个名字就是不填
  onPickCook(e) {
    const name = e.currentTarget.dataset.name;
    this.setData({ cook: this.data.cook === name ? "" : name });
  },

  async onAddCook() {
    const name = await ui.prompt({ title: "谁掌勺", placeholder: "写个名字" });
    if (!name) return;
    if (name.length > 10) {
      ui.toast("最多 10 个字");
      return;
    }
    this.setData({ cook: name, names: recentNames([name].concat(this.data.names)) });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  // ---------- 记下来 ----------

  async onSave() {
    if (this.saving) return;
    const made = this.data.dishes.filter((d) => d.checked);
    if (!made.length) {
      ui.toast("勾上这顿做了的菜");
      return;
    }
    this.saving = true;
    wx.showLoading({ title: "正在记下来", mask: true });
    const { date, meal, cook, note, photo } = this.data;
    try {
      await mealService.finish({
        mealId: this.mealId,
        date,
        meal,
        cook,
        note,
        photo,
        order: this.order,
        dishes: made.map((d) => ({ dishId: d.dishId, qty: d.qty, rating: d.rating })),
      });
    } catch (err) {
      wx.hideLoading();
      this.saving = false;
      ui.alert("没记上", ui.errorText(err));
      return;
    }
    wx.hideLoading();
    cookSession.clear(); // 这顿记好了，一起做的进度不用了
    if (cook) {
      try {
        storage.set(COOK_NAME_KEY, cook);
      } catch (err) {}
    }
    // 去记录页看这一天
    wx.switchTab({ url: "/pages/logs/index", success: () => ui.toast(`记好了！这顿 ${made.length} 道菜`) });
  },
});
