// 确认点菜单：在菜单页点「去下单」进来（像外卖的「去结算」）。选哪天、哪一顿、口味、备注、谁点的、谁掌勺；
// 点的菜在这里只能看，要加减回菜单（点底部的菜篮）。点「确认下单」生成带编号的点菜单，回到「点菜单」页。
// ?edit=1 是「改一改」：改下单时填的这些，编号和点的菜不变，最下面能撤单。
// ?start=菜品id：从菜谱点「开始做」来的，下好单直接开始做这道菜
const dishService = require("../../services/dish");
const bookService = require("../../services/book");
const planService = require("../../services/plan");
const logService = require("../../services/log");
const cookSession = require("../../services/cook-session");
const storage = require("../../utils/storage");
const ui = require("../../utils/ui");
const { dateValue, timeOf } = require("../../utils/log");
const { MEALS, FLAVORS, mealByTime, dateText, slowestText, orderNoText, recentNames } = require("../../utils/order");

const ORDER_NAME_KEY = "order_name"; // 这台手机上次写的点菜人
const COOK_NAME_KEY = "cook_name"; // 这台手机上次写的掌勺（打卡页、开饭页也用）
const FLAVOR_KEY = "custom_flavors"; // 自己加过的口味，下次直接点

// 点的一道菜（只能看）：缩略图、名字、用时、份数
function rowOf({ dish, qty }) {
  return {
    _id: dish._id,
    name: dish.name,
    cover: dish.coverThumb || dish.cover,
    initial: dish.name.slice(0, 1),
    meta: dish.duration > 0 ? `${dish.duration} 分钟` : "",
    qty,
  };
}

Page({
  data: {
    ready: false,
    editing: false, // 改一改
    orderNo: "", // 改一改时：「No.006」
    starting: false, // 下好单直接开始做
    items: [], // 点的菜 [{ _id, name, cover, initial, meta, qty }]
    count: 0, // 总份数
    slowText: "", // 最慢的一道要多久
    form: null, // { date, meal, flavors, note, orderedBy, cook }
    today: "",
    tomorrow: "",
    dateLabel: "", // 选了别的日子时显示「10月25日 周日」
    meals: MEALS,
    flavorChips: [], // [{ name, on }]
    addingFlavor: false, // 正在写自己加的口味（「＋ 口味」变成了输入框）
    names: [], // 以前写过的名字、这本里大家的名字，点一下就行
    broken: {}, // 加载失败的照片
  },

  async onLoad(options) {
    const editing = options.edit === "1";
    this.startId = options.start || "";
    const order = planService.getOrder();
    if (editing && !order) {
      await ui.alert("这张点菜单已经撤掉了", "");
      wx.navigateBack();
      return;
    }
    if (!editing && order) {
      // 家人已经下好单了
      wx.switchTab({ url: "/pages/today/index", success: () => ui.toast("已经下好单了") });
      return;
    }
    const now = Date.now();
    const form = editing
      ? { date: order.date, meal: order.meal, flavors: order.flavors, note: order.note, orderedBy: order.orderedBy, cook: order.cook }
      : { date: dateValue(now), meal: mealByTime(now), flavors: [], note: "", orderedBy: storage.get(ORDER_NAME_KEY) || "", cook: storage.get(COOK_NAME_KEY) || "" };
    const today = dateValue(now);
    if (editing) wx.setNavigationBarTitle({ title: "改点菜单" });
    this.setData({
      editing,
      orderNo: editing ? orderNoText(order.no) : "",
      starting: !!this.startId,
      today,
      tomorrow: dateValue(timeOf(today) + 36 * 3600 * 1000),
      form,
      dateLabel: dateText(form.date),
      flavorChips: this.flavorChips(form.flavors),
    });
    await this.load();
  },

  async load() {
    let dishes = [];
    let logs = [];
    try {
      [dishes, logs] = await Promise.all([dishService.listDishes(), logService.listLogs()]);
    } catch (err) {
      ui.toast(ui.errorText(err));
    }
    const basket = planService.getBasket();
    const planned = dishes.filter((d) => basket[d._id]).map((dish) => ({ dish, qty: basket[dish._id] }));
    const form = this.data.form;
    this.setData({
      ready: true,
      items: planned.map(rowOf),
      count: planned.reduce((sum, p) => sum + p.qty, 0),
      slowText: slowestText(planned),
      names: recentNames(
        [form.orderedBy, form.cook, storage.get(ORDER_NAME_KEY), storage.get(COOK_NAME_KEY)].concat(bookService.memberNames(), logs.map((l) => l.cook))
      ),
    });
  },

  flavorChips(selected) {
    const custom = storage.get(FLAVOR_KEY) || [];
    return recentNames(FLAVORS.concat(custom, selected), 20).map((name) => ({ name, on: selected.indexOf(name) >= 0 }));
  },

  // ---------- 哪天、哪一顿 ----------

  onPickDate(e) {
    const date = e.currentTarget.dataset.date;
    this.setData({ "form.date": date, dateLabel: dateText(date) });
  },

  onDateChange(e) {
    this.setData({ "form.date": e.detail.value, dateLabel: dateText(e.detail.value) });
  },

  onPickMeal(e) {
    this.setData({ "form.meal": e.currentTarget.dataset.meal });
  },

  // ---------- 口味备注 ----------

  onToggleFlavor(e) {
    const name = e.currentTarget.dataset.name;
    const flavors = this.data.form.flavors.slice();
    const i = flavors.indexOf(name);
    if (i >= 0) flavors.splice(i, 1);
    else flavors.push(name);
    this.setData({ "form.flavors": flavors, flavorChips: this.flavorChips(flavors) });
  },

  // 自己加一个口味：「＋ 口味」变成输入框，直接在这里写
  onAddFlavor() {
    this.setData({ addingFlavor: true });
  },

  // 写好了（点了「完成」，或者点了别处）：选上，下次也会出现在常用里。什么都没写就收起来
  onFlavorDone(e) {
    if (!this.data.addingFlavor) return; // 「完成」以后还会来一次 blur
    this.setData({ addingFlavor: false });
    const name = (e.detail.value || "").trim().slice(0, 10);
    if (name) this.addFlavor(name);
  },

  addFlavor(name) {
    const custom = recentNames([name].concat(storage.get(FLAVOR_KEY) || []), 6).filter((n) => FLAVORS.indexOf(n) < 0);
    try {
      storage.set(FLAVOR_KEY, custom);
    } catch (err) {}
    const flavors = this.data.form.flavors.indexOf(name) >= 0 ? this.data.form.flavors : this.data.form.flavors.concat(name);
    this.setData({ "form.flavors": flavors, flavorChips: this.flavorChips(flavors) });
  },

  onNoteInput(e) {
    this.setData({ "form.note": e.detail.value });
  },

  // ---------- 谁点的、谁掌勺 ----------

  // data-field 是 orderedBy 或 cook；再点一下同一个名字就是不填
  onPickName(e) {
    const { field, name } = e.currentTarget.dataset;
    this.setData({ [`form.${field}`]: this.data.form[field] === name ? "" : name });
  },

  async onAddName(e) {
    const field = e.currentTarget.dataset.field;
    const name = await ui.prompt({ title: field === "cook" ? "谁掌勺" : "谁点的", placeholder: "写个名字" });
    if (!name) return;
    if (name.length > 10) {
      ui.toast("最多 10 个字");
      return;
    }
    this.setData({ [`form.${field}`]: name, names: recentNames([name].concat(this.data.names)) });
  },

  // ---------- 确认 ----------

  // 「确认下单」或者改一改的「改好了」
  onSubmit() {
    return this.data.editing ? this.saveEdit() : this.placeOrder();
  },

  async placeOrder() {
    if (this.busy) return;
    if (!this.data.items.length) {
      ui.toast("先去菜单点几道菜");
      return;
    }
    const form = this.data.form;
    this.busy = true;
    try {
      if (form.orderedBy) storage.set(ORDER_NAME_KEY, form.orderedBy);
      if (form.cook) storage.set(COOK_NAME_KEY, form.cook);
    } catch (err) {} // 记不住名字不影响下单
    wx.showLoading({ title: "正在下单", mask: true });
    try {
      await planService.placeOrder(form);
    } catch (err) {
      wx.hideLoading();
      this.busy = false;
      ui.alert("没下成", ui.errorText(err));
      return;
    }
    wx.hideLoading();
    this.busy = false;
    if (this.startId && planService.getBasket()[this.startId]) {
      // 从菜谱点「开始做」来的：下好单直接开始做那道菜
      wx.redirectTo({ url: `/pages/cook/index?from=basket&dish=${this.startId}` });
      return;
    }
    wx.switchTab({ url: "/pages/today/index" }); // 那边盖个「已下单」的章
  },

  saveEdit() {
    try {
      planService.updateOrder(this.data.form);
    } catch (err) {
      ui.alert("没改成", ui.errorText(err));
      return;
    }
    wx.navigateBack({ success: () => ui.toast("改好了") });
  },

  // 撤单（只在改一改里）：点的菜还在菜篮里；编号不占，再下单还是这个号。一起做的进度清掉
  async onCancelOrder() {
    const cooking = !!cookSession.load();
    const ok = await ui.confirm({
      title: "撤掉这张点菜单？",
      content: `点的菜还在菜篮里，改好了可以再下单，编号还是这个。${cooking ? "一起做的进度会清掉。" : ""}`,
      confirmText: "撤单",
      danger: true,
    });
    if (!ok) return;
    planService.cancelOrder();
    cookSession.clear();
    wx.navigateBack({ success: () => ui.toast("撤掉了") });
  },

  // ---------- 跳转 ----------

  // 点的菜在这里不改：回菜单，点底部的菜篮加减
  onBackToMenu() {
    wx.switchTab({ url: "/pages/menu/index" });
  },

  onOpenDish(e) {
    wx.navigateTo({ url: `/pages/dish-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  // 照片加载不出来：换成占位图，并提示一次去哪里查
  onCoverError(e) {
    this.setData({ broken: Object.assign({}, this.data.broken, { [e.currentTarget.dataset.src]: true }) });
    ui.photoHint();
  },
});
