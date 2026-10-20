// 点菜单（第二个 Tab，页面路径还是 pages/today）：下单以后，最上面是这顿的点菜单（发给 TA、存成图片、加菜、改一改），
// 下面是自动合并出来的买菜清单，底部「开始做菜」「做好了，开饭」。
// 点菜、改菜在菜单页（底部的菜篮能看已点的、加减）；下单前要填的在「确认点菜单」页（pages/checkout）。
// 还没下单时这里只提示去下单。买菜清单会对比家里的库存：家里有的不提醒；买到一样勾一样，大家都能看到
const dishService = require("../../services/dish");
const bookService = require("../../services/book");
const planService = require("../../services/plan");
const pantryService = require("../../services/pantry");
const cookSession = require("../../services/cook-session");
const ui = require("../../utils/ui");
const fileUtil = require("../../utils/file");
const ticketUtil = require("../../utils/ticket");
const { buildShoppingList } = require("../../utils/shopping");
const { dateValue } = require("../../utils/log");
const { slowestText, ticketOf, shareTitle } = require("../../utils/order");

const SINK_MS = 450; // 买菜清单勾了一样，先在原地划掉，停这么久再沉到下面（马上换位置眼睛跟不上）
const STAMP_HIT_MS = 520; // 「已下单」的章落下来的那一下（和 index.wxss 的 stamp-in 对上）

// 菜篮里的一道菜（小行，只能看）：缩略图、名字、用时、份数
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
    stage: "empty", // empty 还没点菜 / picking 点了菜还没下单 / ordered 已下单
    items: [], // 菜篮里的菜 [{ _id, name, cover, initial, meta, qty }]
    count: 0, // 总份数
    slowText: "", // 最慢的一道要多久
    ticket: null, // 已下单：点菜单（utils/order.js 的 ticketOf）
    overdue: "", // 点菜单上的日子已经过了：「10月19日的晚饭做了吗？」
    cooking: null, // 一起做到一半：{ done, total }
    shopping: null, // 买菜清单 { buy, unknown, stocked, extras, total, done }
    shared: false, // 正在用的是家庭本本（说法用「家人」，个人本本里不说）
    showShopping: false, // 下单前买菜清单先收起来
    showStocked: false, // 「家里有的」展开没有
    broken: {}, // 加载失败的照片 { 照片地址: true }，显示占位图
    stampIn: false, // 刚下的单：「已下单」的章盖下来（动画）
  },

  onLoad(options) {
    // 点家人发来的点菜单卡片打开：切到发卡片的那本（你也在那本里的话）
    if (options && options.book) bookService.openShared(options.book).then(() => this.refresh());
  },

  onShow() {
    planService.updateBadge();
    bookService.updateDot();
    this.refresh();
    // 家人可能刚点了菜、下了单、勾了清单、改了库存，隔一会儿回来就去云上看看
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

  async refresh() {
    let dishes = [];
    try {
      dishes = await dishService.listDishes();
    } catch (err) {
      ui.toast(ui.errorText(err));
    }
    const plan = planService.getPlan();
    // 按菜单里的顺序排；已经被删掉的菜不显示
    const planned = dishes.filter((d) => plan.items[d._id]).map((dish) => ({ dish, qty: plan.items[dish._id] }));
    const shopping = buildShoppingList(planned, plan.checked, plan.extras, pantryService.getItems());
    const stage = plan.order && planned.length ? "ordered" : planned.length || shopping.extras.length ? "picking" : "empty";
    // 点菜单没了（撤单了、开饭了、家人在别的手机上撤了）：一起做的进度也用不上了
    if (stage !== "ordered" && cookSession.load()) cookSession.clear();
    const ticket = stage === "ordered" ? ticketOf(plan.order, planned) : null;
    const fresh = !!ticket && planService.takeFreshOrder(plan.order.no);
    const overdue = ticket && ticket.date < dateValue(Date.now()) ? `${ticket.dateText.split(" ")[0]}的${ticket.meal}做了吗？` : "";
    this.setData({
      stage,
      items: planned.map(rowOf),
      count: planned.reduce((sum, p) => sum + p.qty, 0),
      slowText: slowestText(planned),
      ticket,
      overdue,
      cooking: stage === "ordered" ? cookSession.progress(plan.items) : null,
      shopping,
      shared: bookService.isShared(),
    });
    if (fresh) this.playStamp();
    if (ticket) this.prepareCard();
  },

  // 刚下的单：「已下单」的章盖下来，落下的那一下手机震一下
  playStamp() {
    this.setData({ stampIn: true });
    setTimeout(() => ui.buzz("medium"), STAMP_HIT_MS);
    setTimeout(() => this.setData({ stampIn: false }), 1000);
  },

  // 去下单：确认点菜单（哪天、哪一顿、口味……）
  onGoCheckout() {
    wx.navigateTo({ url: "/pages/checkout/index" });
  },

  // ---------- 已下单 ----------

  // 加菜：回菜单点，点菜单上标「加」
  onAddMore() {
    wx.switchTab({ url: "/pages/menu/index" });
  },

  // 改一改：在确认点菜单页改哪天、哪一顿、口味、谁点的谁掌勺；撤单也在那里
  onEditOrder() {
    wx.navigateTo({ url: "/pages/checkout/index?edit=1" });
  },

  // 点菜单上的日子过了，没做：撤单。点的菜还在菜篮里，编号不占
  async onCancelOrder() {
    const ok = await ui.confirm({
      title: "撤掉这张点菜单？",
      content: `点的菜还在菜篮里，改好了可以再下单，编号还是这个。${this.data.cooking ? "一起做的进度会清掉。" : ""}`,
      confirmText: "撤单",
      danger: true,
    });
    if (!ok) return;
    planService.cancelOrder();
    cookSession.clear();
    return this.refresh();
  },

  // 一起做：点菜单上的菜一起做（做到一半退出过的接着做）
  onStartCook() {
    if (!planService.getOrder()) {
      ui.toast("先下单，再开始做");
      return;
    }
    wx.navigateTo({ url: "/pages/cook/index?from=basket" });
  },

  onOpenOrders() {
    wx.navigateTo({ url: "/pages/orders/index" });
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
  onSaveImage() {
    if (!this.data.ticket) return Promise.resolve();
    return ticketUtil.shareTicket(this, this.ticketData("已下单"));
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
    const book = `?book=${bookService.currentId()}`; // 对方点开时切到这本
    if (!ticket) return { title: "拿手菜小本本：今天吃什么", path: `/pages/menu/index${book}` };
    const share = { title: shareTitle(ticket), path: `/pages/today/index${book}` };
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

  // 买到了 / 没买到：先在原地打勾、划掉（「已买」跟着变），停一下再重新排，买到的沉到下面
  onToggleItem(e) {
    const key = e.currentTarget.dataset.key;
    planService.toggleChecked(key);
    this.markRow(key);
    clearTimeout(this.sinkTimer); // 连着勾几样：最后一下停够了再一起排
    return new Promise((resolve) => {
      this.sinkTimer = setTimeout(() => resolve(this.refresh()), SINK_MS);
    });
  },

  markRow(key) {
    const shopping = this.data.shopping;
    const patch = {};
    ["buy", "unknown", "extras"].forEach((group) => {
      shopping[group].forEach((item, i) => {
        if (item.key !== key) return;
        patch[`shopping.${group}[${i}].checked`] = !item.checked;
        patch[`shopping.${group}[${i}].pop`] = !item.checked; // 勾上的那一下，勾弹一下
        patch["shopping.done"] = shopping.done + (item.checked ? -1 : 1);
      });
    });
    this.setData(patch);
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
