// 菜品详情：原料、分步做法、小贴士、做菜记录；底部可以加入菜篮、编辑、开始做；最下面能复制到另一本小本本
const dishService = require("../../services/dish");
const bookService = require("../../services/book");
const logService = require("../../services/log");
const mealService = require("../../services/meal");
const planService = require("../../services/plan");
const ui = require("../../utils/ui");
const { toDetail } = require("../../utils/dish");
const { toLogCard } = require("../../utils/log");
const { orderNoText } = require("../../utils/order");

const RECENT_LOGS = 5; // 详情页最多显示几条做菜记录

Page({
  data: {
    dish: null,
    qty: 0, // 菜篮里这道菜的份数
    logs: [], // 最近几次做菜记录（卡片）
    logCount: 0,
    notFound: false,
    heroBroken: false, // 成品照加载失败，显示占位图
    canCopy: false, // 还有别的小本本，能复制过去
  },

  onLoad(options) {
    this.dishId = options.id;
    // 点家人发来的卡片打开：先切到发卡片的那本（你也在那本里的话）
    if (options.book) bookService.openShared(options.book).then(() => this.load());
    else this.load();
  },

  onShow() {
    // 编辑完、打完卡回到这里，重新读一遍
    if (this.dataVersion !== undefined && this.dataVersion !== dishService.getVersion()) this.load();
    else if (this.data.dish) this.refreshQty();
    // 隔一会儿回来，看看对方有没有改过这道菜
    if (this.dataVersion !== undefined) {
      dishService.refreshIfStale().then((changed) => {
        if (changed) this.load();
      });
    }
  },

  async load() {
    let dish;
    let logs = [];
    const meals = {}; // 开饭时一起记的：记录自己没照片，就用那顿饭的整桌照片
    try {
      dish = await dishService.getDish(this.dishId);
      logs = (await logService.listLogs()).filter((l) => l.dishId === this.dishId);
      (await mealService.listMeals()).forEach((m) => {
        meals[m._id] = m;
      });
    } catch (err) {
      ui.alert("没读到这道菜", ui.errorText(err));
      return;
    }
    this.dataVersion = dishService.getVersion();
    if (!dish) {
      this.setData({ dish: null, notFound: true });
      return;
    }
    wx.setNavigationBarTitle({ title: dish.name });
    this.setData({
      dish: toDetail(dish),
      logs: logs.slice(0, RECENT_LOGS).map((l) => toLogCard(l, null, meals)),
      logCount: logs.length,
      notFound: false,
      heroBroken: false,
      canCopy: bookService.list().length > 1,
    });
    this.refreshQty();
  },

  refreshQty() {
    this.setData({ qty: planService.getBasket()[this.data.dish._id] || 0 });
  },

  onPlus() {
    const isFirst = this.data.qty === 0;
    planService.add(this.data.dish._id);
    this.refreshQty();
    if (isFirst) wx.showToast({ title: "已加入菜篮", icon: "none" });
  },

  onMinus() {
    planService.remove(this.data.dish._id);
    this.refreshQty();
  },

  onEdit() {
    wx.navigateTo({ url: `/pages/dish-edit/index?id=${this.dishId}` });
  },

  onHeroError() {
    this.setData({ heroBroken: true });
    ui.photoHint();
  },

  // 开始做：先下单再开始做。
  // 已经下了单：这道菜不在点菜单上就问一下要不要加菜，然后打开做菜页，直接到这道菜；
  // 还没下单：放进菜篮，去确认点菜单，下好单直接开始做
  async onStartCook() {
    const id = this.dishId;
    const order = planService.getOrder();
    if (order) {
      if (!planService.getBasket()[id]) {
        const ok = await ui.confirm({
          title: "加菜一起做？",
          content: `把「${this.data.dish.name}」加进点菜单 ${orderNoText(order.no)}，跟这顿的菜一起做`,
          confirmText: "加菜",
        });
        if (!ok) return;
        planService.add(id);
        this.refreshQty();
      }
      wx.navigateTo({ url: `/pages/cook/index?from=basket&dish=${id}` });
      return;
    }
    if (!planService.getBasket()[id]) {
      planService.add(id);
      this.refreshQty();
    }
    wx.navigateTo({ url: `/pages/checkout/index?start=${id}` });
  },

  // ---------- 做菜记录 ----------

  onAddLog() {
    wx.navigateTo({ url: `/pages/log-edit/index?dishId=${this.dishId}` });
  },

  onOpenLog(e) {
    wx.navigateTo({ url: `/pages/log-edit/index?id=${e.currentTarget.dataset.id}` });
  },

  onAllLogs() {
    wx.switchTab({ url: "/pages/logs/index" });
  },

  // 复制到另一本小本本：菜谱和照片复制一份（分类按名字对上），做菜记录不复制；那本里已经有同名的就不复制
  async onCopyToBook() {
    const others = bookService.list().filter((b) => !b.current);
    if (!others.length) return;
    const dish = this.data.dish;
    let target = others[0];
    if (others.length > 1) {
      const i = await ui.actionSheet(others.map((b) => b.name));
      if (i < 0) return;
      target = others[i];
    } else {
      const ok = await ui.confirm({
        title: `复制到「${target.name}」？`,
        content: "菜谱和照片复制一份过去，做菜记录不复制。以后两边各改各的。",
        confirmText: "复制",
      });
      if (!ok) return;
    }
    wx.showLoading({ title: "正在复制", mask: true });
    let result;
    try {
      result = await bookService.copyDishes(bookService.currentId(), target._id, [this.dishId]);
    } catch (err) {
      wx.hideLoading();
      ui.alert("没复制成", ui.errorText(err));
      return;
    }
    wx.hideLoading();
    if (result.copied) ui.toast(`复制到「${target.name}」了`);
    else ui.alert("没有复制", `「${target.name}」里已经有「${dish.name}」了`);
  },

  // 右上角「...」→ 转发：把这道菜发给家人（体验版只有体验成员能打开；对方点开时切到这本）
  onShareAppMessage() {
    const dish = this.data.dish;
    return {
      title: dish ? `${dish.name}｜拿手菜小本本` : "拿手菜小本本",
      path: `/pages/dish-detail/index?id=${this.dishId}&book=${bookService.currentId()}`,
    };
  },
});
