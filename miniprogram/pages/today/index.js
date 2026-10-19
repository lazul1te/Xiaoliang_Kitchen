// 菜篮：两个人一起点的菜、点菜单，和自动合并出来的买菜清单。
// 下单前是「确认点菜单」（哪一顿、口味、谁点的、谁掌勺），下单以后最上面是点菜单，可以发给对方、存成图片。
// 买菜清单会对比家里的库存：家里有的不提醒；买到一样勾一样，两边都能看到
const dishService = require("../../services/dish");
const planService = require("../../services/plan");
const pantryService = require("../../services/pantry");
const logService = require("../../services/log");
const cookSession = require("../../services/cook-session");
const storage = require("../../utils/storage");
const ui = require("../../utils/ui");
const fileUtil = require("../../utils/file");
const ticketUtil = require("../../utils/ticket");
const { buildShoppingList } = require("../../utils/shopping");
const { dateValue, timeOf } = require("../../utils/log");
const { MEALS, FLAVORS, mealByTime, dateText, slowestText, ticketOf, shareTitle, recentNames } = require("../../utils/order");

const ORDER_NAME_KEY = "order_name"; // 这台手机上次写的点菜人
const COOK_NAME_KEY = "cook_name"; // 这台手机上次写的掌勺（打卡页也用）
const FLAVOR_KEY = "custom_flavors"; // 自己加过的口味，下次直接点

// 菜篮里的一道菜（小行）：缩略图、名字、用时
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

// 小票、图片里的菜：份数写在右边，下单以后又点的标个「加」
function ticketItems(ticket) {
  return ticket.items.map((i) => ({ name: i.name, right: `×${i.qty}`, tag: i.added ? "加" : "" }));
}

Page({
  data: {
    stage: "empty", // empty 菜篮是空的 / picking 还没下单 / ordered 已下单
    items: [], // 菜篮里的菜 [{ _id, name, cover, initial, meta, qty }]
    basket: {},
    count: 0, // 总份数
    slowText: "", // 最慢的一道要多久
    form: null, // 确认点菜单 { date, meal, flavors, note, orderedBy, cook }
    today: "",
    tomorrow: "",
    dateLabel: "", // 选了别的日子时显示「10月25日 周日」
    meals: MEALS,
    flavorChips: [], // [{ name, on }]
    names: [], // 以前写过的名字，点一下就行
    ticket: null, // 已下单：点菜单（utils/order.js 的 ticketOf）
    overdue: "", // 点菜单上的日子已经过了：「10月19日的晚饭做了吗？」
    cooking: null, // 一起做到一半：{ done, total }
    shopping: null, // 买菜清单 { buy, unknown, stocked, extras, total, done }
    hasPlan: false,
    showShopping: false, // 下单前买菜清单先收起来
    showStocked: false, // 「家里有的」展开没有
    broken: {}, // 加载失败的照片 { 照片地址: true }，显示占位图
  },

  onLoad() {
    this.initForm();
  },

  onShow() {
    planService.updateBadge();
    this.refresh();
    // 对方可能刚点了菜、下了单、勾了清单、改了库存，隔一会儿回来就去云上看看
    dishService.refreshIfStale().then((changed) => {
      if (changed) this.refresh();
    });
  },

  async onPullDownRefresh() {
    this.setData({ broken: {} }); // 加载失败的照片也重新试一次
    try {
      await dishService.sync();
    } catch (err) {
      ui.showError(err);
    }
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  // 确认点菜单的默认值：今天、按时间猜哪一顿、这台手机上次写的名字
  initForm() {
    if (this.data.form) return;
    const now = Date.now();
    this.setData({
      today: dateValue(now),
      tomorrow: dateValue(timeOf(dateValue(now)) + 36 * 3600 * 1000),
      form: {
        date: dateValue(now),
        meal: mealByTime(now),
        flavors: [],
        note: "",
        orderedBy: storage.get(ORDER_NAME_KEY) || "",
        cook: storage.get(COOK_NAME_KEY) || "",
      },
    });
  },

  async refresh() {
    this.initForm();
    // 页面一直开着过了零点：今天、明天往后挪，已经过去的日子换成今天
    const today = dateValue(Date.now());
    if (today !== this.data.today) {
      this.setData({ today, tomorrow: dateValue(timeOf(today) + 36 * 3600 * 1000) });
      if (this.data.form.date < today) this.setData({ "form.date": today });
    }
    let dishes = [];
    let logs = [];
    try {
      dishes = await dishService.listDishes();
      logs = await logService.listLogs();
    } catch (err) {
      ui.toast(ui.errorText(err));
    }
    const plan = planService.getPlan();
    // 按菜单里的顺序排；已经被删掉的菜不显示
    const planned = dishes.filter((d) => plan.items[d._id]).map((dish) => ({ dish, qty: plan.items[dish._id] }));
    const shopping = buildShoppingList(planned, plan.checked, plan.extras, pantryService.getItems());
    const stage = plan.order && planned.length ? "ordered" : planned.length || shopping.extras.length ? "picking" : "empty";
    const ticket = stage === "ordered" ? ticketOf(plan.order, planned) : null;
    const overdue = ticket && ticket.date < this.data.today ? `${ticket.dateText.split(" ")[0]}的${ticket.meal}做了吗？` : "";
    const form = this.data.form;
    this.setData({
      stage,
      items: planned.map(rowOf),
      basket: plan.items,
      count: planned.reduce((sum, p) => sum + p.qty, 0),
      slowText: slowestText(planned),
      ticket,
      overdue,
      cooking: cookSession.progress(plan.items),
      shopping,
      hasPlan: stage !== "empty",
      flavorChips: this.flavorChips(form.flavors),
      names: recentNames([form.orderedBy, form.cook, storage.get(ORDER_NAME_KEY), storage.get(COOK_NAME_KEY)].concat(logs.map((l) => l.cook))),
      dateLabel: dateText(form.date),
    });
    if (ticket) this.prepareCard();
  },

  flavorChips(selected) {
    const custom = storage.get(FLAVOR_KEY) || [];
    return recentNames(FLAVORS.concat(custom, selected), 20).map((name) => ({ name, on: selected.indexOf(name) >= 0 }));
  },

  onPlus(e) {
    planService.add(e.currentTarget.dataset.id);
    return this.refresh();
  },

  onMinus(e) {
    planService.remove(e.currentTarget.dataset.id);
    return this.refresh();
  },

  async onClear() {
    const ok = await ui.confirm({
      title: "清空菜篮？",
      content: "点的菜、点菜单和买菜清单都会清空，两个人的都会清空。库存不受影响。",
      confirmText: "清空",
    });
    if (!ok) return;
    planService.clear();
    return this.refresh();
  },

  // ---------- 确认点菜单 ----------

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

  onToggleFlavor(e) {
    const name = e.currentTarget.dataset.name;
    const flavors = this.data.form.flavors.slice();
    const i = flavors.indexOf(name);
    if (i >= 0) flavors.splice(i, 1);
    else flavors.push(name);
    this.setData({ "form.flavors": flavors, flavorChips: this.flavorChips(flavors) });
  },

  // 自己加一个口味：选上，下次也会出现在常用里
  async onAddFlavor() {
    const name = await ui.prompt({ title: "加个口味", placeholder: "比如：多放醋、不要葱" });
    if (!name) return;
    if (name.length > 10) {
      ui.toast("最多 10 个字");
      return;
    }
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

  // 谁点的 / 谁掌勺：data-field 是 orderedBy 或 cook；再点一下同一个名字就是不填
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

  async onPlaceOrder() {
    if (this.ordering) return;
    if (!this.data.items.length) {
      ui.toast("先去菜单点几道菜");
      return;
    }
    const form = this.data.form;
    this.ordering = true;
    try {
      if (form.orderedBy) storage.set(ORDER_NAME_KEY, form.orderedBy);
      if (form.cook) storage.set(COOK_NAME_KEY, form.cook);
    } catch (err) {} // 记不住名字不影响下单
    try {
      await planService.placeOrder(form);
    } catch (err) {
      this.ordering = false;
      ui.alert("没下成", ui.errorText(err));
      return;
    }
    this.ordering = false;
    // 下一单重新填口味和备注
    this.setData({ "form.flavors": [], "form.note": "" });
    await this.refresh();
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    ui.toast("下单啦");
  },

  // ---------- 已下单 ----------

  onAddMore() {
    wx.switchTab({ url: "/pages/menu/index" });
  },

  async onCancelOrder() {
    const ok = await ui.confirm({
      title: "撤销这张点菜单？",
      content: "点的菜还在菜篮里，改好了可以再下单。",
      confirmText: "撤单",
    });
    if (!ok) return;
    planService.cancelOrder();
    return this.refresh();
  },

  // 一起做：菜篮里的菜一起做（做到一半退出过的接着做）
  onStartCook() {
    wx.navigateTo({ url: "/pages/cook/index?from=basket" });
  },

  async onDropCooking() {
    const ok = await ui.confirm({
      title: "不接着做了？",
      content: "做到哪一步、计时这些进度会清掉，菜还在菜篮里。",
      confirmText: "不做了",
    });
    if (!ok) return;
    cookSession.clear();
    return this.refresh();
  },

  // 做好了：去开饭页，一次把这顿的菜都记下来
  onFinishMeal() {
    wx.navigateTo({ url: "/pages/meal/index" });
  },

  // 忘了开饭：按点菜单上那天记
  onOverdueDone() {
    wx.navigateTo({ url: `/pages/meal/index?date=${this.data.ticket.date}` });
  },

  // 小票、卡片要画的内容
  ticketData(stampText) {
    const t = this.data.ticket;
    const notes = [`共 ${t.count} 道菜 ${t.portions} 份`];
    if (t.slowText) notes.push(t.slowText);
    if (t.flavorsText) notes.push(`口味：${t.flavorsText}`);
    if (t.note) notes.push(`备注：${t.note}`);
    return {
      title: "点菜单",
      cardTitle: `点菜单 ${t.noText} · ${t.meal}`,
      noText: t.noText,
      lines: [`${t.dateText} · ${t.meal}`].concat(t.peopleText ? [t.peopleText] : []),
      items: ticketItems(t),
      notes,
      stamp: stampText,
    };
  },

  // 存成图片：画一张小票，弹出微信的分享图片菜单（发给朋友、收藏、保存到手机）
  async onSaveImage() {
    if (!this.data.ticket || this.drawing) return;
    this.drawing = true;
    wx.showLoading({ title: "生成图片", mask: true });
    let path;
    try {
      path = await ticketUtil.ticketImage(await ticketUtil.getCanvas(this), this.ticketData("已下单"));
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
      wx.previewImage({ urls: [path] }); // 微信版本太旧：打开大图，长按可以发送、保存
    }
  },

  // 小程序卡片的封面先画好（点菜单变了才重画），点「发给 TA」时直接用
  prepareCard() {
    const data = this.ticketData("已下单");
    const key = JSON.stringify(data);
    if (key === this.cardKey) return this.cardPromise;
    this.cardKey = key;
    this.cardImage = "";
    this.cardPromise = ticketUtil
      .getCanvas(this)
      .then((canvas) => ticketUtil.cardImage(canvas, data))
      .then((path) => {
        if (this.cardKey === key) this.cardImage = path;
        return path;
      })
      .catch(() => "");
    return this.cardPromise;
  },

  // 「发给 TA」按钮、右上角「...」转发：下了单就发点菜单，没下单发菜单页
  onShareAppMessage() {
    const ticket = this.data.ticket;
    if (!ticket) return { title: "拿手菜小本本：今天吃什么", path: "/pages/menu/index" };
    const share = { title: shareTitle(ticket), path: "/pages/today/index" };
    if (this.cardImage) return Object.assign({ imageUrl: this.cardImage }, share);
    // 封面还没画好：先用默认的，画好了换上（微信最多等 3 秒）
    return Object.assign({}, share, {
      promise: this.prepareCard().then((imageUrl) => (imageUrl ? Object.assign({ imageUrl }, share) : share)),
    });
  },

  // ---------- 买菜清单 ----------

  onToggleShopping() {
    this.setData({ showShopping: !this.data.showShopping });
  },

  onToggleItem(e) {
    planService.toggleChecked(e.currentTarget.dataset.key);
    return this.refresh();
  },

  // 家里有：加进库存（用完了的就标回「有」），以后不再提醒
  onHaveIt(e) {
    pantryService.add(e.currentTarget.dataset.name);
    return this.refresh();
  },

  // 这一组调料家里都有
  onHaveAll() {
    const names = this.data.shopping.unknown.map((i) => i.name);
    const n = pantryService.add(names);
    ui.toast(`${n} 样加进库存了`);
    return this.refresh();
  },

  // 家里有的某样用完了：标成「用完了」，回到要买的里面
  onRanOut(e) {
    pantryService.setInStock(e.currentTarget.dataset.key, false);
    return this.refresh();
  },

  onToggleStocked() {
    this.setData({ showStocked: !this.data.showStocked });
  },

  onOpenPantry() {
    wx.navigateTo({ url: "/pages/pantry/index" });
  },

  async onAddExtra() {
    const name = await ui.prompt({ title: "还要买什么", placeholder: "比如：牛奶、纸巾" });
    if (!name) return;
    if (name.length > 20) {
      ui.toast("最多 20 个字");
      return;
    }
    planService.addExtra(name);
    return this.refresh();
  },

  // 复制没买的东西，发到微信里给对方或者自己看
  onCopyList() {
    const { shopping, items } = this.data;
    const line = (i) => `· ${i.name}${i.amountText ? " " + i.amountText : ""}`;
    const groups = [
      ["", shopping.buy.filter((i) => !i.checked)],
      ["调料（家里有没有看一眼）", shopping.unknown.filter((i) => !i.checked)],
      ["另外要买", shopping.extras.filter((i) => !i.checked)],
    ].filter(([, list]) => list.length);
    if (!groups.length) {
      ui.toast("都买齐了");
      return;
    }
    const head = `买菜清单（${items.map((d) => d.name).join("、")}）`;
    const body = groups.map(([title, list]) => (title ? `${title}：\n` : "") + list.map(line).join("\n")).join("\n\n");
    fileUtil.copyText(`${head}\n${body}`);
  },

  onRemoveExtra(e) {
    planService.removeExtra(e.currentTarget.dataset.key);
    return this.refresh();
  },

  // 照片加载不出来：换成占位图，并提示一次去哪里查
  onCoverError(e) {
    this.setData({ broken: Object.assign({}, this.data.broken, { [e.currentTarget.dataset.src]: true }) });
    ui.photoHint();
  },

  // ---------- 跳转 ----------

  onOpenDish(e) {
    wx.navigateTo({ url: `/pages/dish-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  onGoMenu() {
    wx.switchTab({ url: "/pages/menu/index" });
  },
});
