// 菜品详情：原料、分步做法、小贴士、做菜记录；底部可以加入菜篮、编辑、开始做
const dishService = require("../../services/dish");
const logService = require("../../services/log");
const mealService = require("../../services/meal");
const planService = require("../../services/plan");
const ui = require("../../utils/ui");
const { toDetail } = require("../../utils/dish");
const { toLogCard } = require("../../utils/log");

const RECENT_LOGS = 5; // 详情页最多显示几条做菜记录

Page({
  data: {
    dish: null,
    qty: 0, // 菜篮里这道菜的份数
    logs: [], // 最近几次做菜记录（卡片）
    logCount: 0,
    notFound: false,
    heroBroken: false, // 成品照加载失败，显示占位图
  },

  onLoad(options) {
    this.dishId = options.id;
    this.load();
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

  onStartCook() {
    wx.navigateTo({ url: `/pages/cook/index?id=${this.dishId}` });
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

  // 右上角「...」→ 转发：把这道菜发给对方（体验版只有体验成员能打开）
  onShareAppMessage() {
    const dish = this.data.dish;
    return {
      title: dish ? `${dish.name}｜拿手菜小本本` : "拿手菜小本本",
      path: `/pages/dish-detail/index?id=${this.dishId}`,
    };
  },
});
