// 今日：两个人一起点的菜，和自动合并出来的买菜清单（买到一样勾一样，两边都能看到）
const dishService = require("../../services/dish");
const planService = require("../../services/plan");
const ui = require("../../utils/ui");
const { toCard } = require("../../utils/dish");
const { buildShoppingList } = require("../../utils/shopping");

Page({
  data: {
    items: [], // 点了的菜（卡片）
    basket: {},
    count: 0, // 总份数
    shopping: null, // 买菜清单 { buy, seasoning, extras, total, done }
    hasPlan: false,
  },

  onShow() {
    planService.updateBadge();
    this.refresh();
    // 对方可能刚点了菜、勾了清单，隔一会儿回来就去云上看看
    dishService.refreshIfStale().then((changed) => {
      if (changed) this.refresh();
    });
  },

  async onPullDownRefresh() {
    try {
      await dishService.sync();
    } catch (err) {
      ui.toast(ui.errorText(err));
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
    const shopping = buildShoppingList(planned, plan.checked, plan.extras);
    this.setData({
      items: planned.map((p) => toCard(p.dish)),
      basket: plan.items,
      count: planned.reduce((sum, p) => sum + p.qty, 0),
      shopping,
      hasPlan: planned.length > 0 || shopping.extras.length > 0,
    });
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
      title: "清空今日菜单？",
      content: "点的菜和买菜清单都会清空，两个人的都会清空。",
      confirmText: "清空",
    });
    if (!ok) return;
    planService.clear();
    return this.refresh();
  },

  // ---------- 买菜清单 ----------

  onToggleItem(e) {
    planService.toggleChecked(e.currentTarget.dataset.key);
    return this.refresh();
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

  onRemoveExtra(e) {
    planService.removeExtra(e.currentTarget.dataset.key);
    return this.refresh();
  },

  // ---------- 跳转 ----------

  onOpenDish(e) {
    wx.navigateTo({ url: `/pages/dish-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  onGoMenu() {
    wx.switchTab({ url: "/pages/menu/index" });
  },
});
