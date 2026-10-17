// 菜篮：两个人一起点的菜，和自动合并出来的买菜清单。
// 买菜清单会对比家里的库存：家里有的不提醒；买到一样勾一样，两边都能看到
const dishService = require("../../services/dish");
const planService = require("../../services/plan");
const pantryService = require("../../services/pantry");
const ui = require("../../utils/ui");
const { toCard } = require("../../utils/dish");
const { buildShoppingList } = require("../../utils/shopping");

Page({
  data: {
    items: [], // 菜篮里的菜（卡片）
    basket: {},
    count: 0, // 总份数
    shopping: null, // 买菜清单 { buy, unknown, stocked, extras, total, done }
    hasPlan: false,
    showStocked: false, // 「家里有的」展开没有
    broken: {}, // 加载失败的照片 { 照片地址: true }，显示占位图
  },

  onShow() {
    planService.updateBadge();
    this.refresh();
    // 对方可能刚点了菜、勾了清单、改了库存，隔一会儿回来就去云上看看
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
      title: "清空菜篮？",
      content: "点的菜和买菜清单都会清空，两个人的都会清空。库存不受影响。",
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
