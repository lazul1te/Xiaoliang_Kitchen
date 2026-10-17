// 菜单：点单式首页（左分类、右菜品、底部点菜栏）
const dishService = require("../../services/dish");
const categoryService = require("../../services/category");
const planService = require("../../services/plan");
const ui = require("../../utils/ui");
const { toCard, matchKeyword } = require("../../utils/dish");

const UNCATEGORIZED = "_none"; // 找不到分类的菜（比如分类被删了）临时放在这一段

Page({
  data: {
    status: "loading", // loading 读取中 / welcome 第一次用 / error 读取失败 / ready 正常显示
    errorText: "",
    refreshing: false, // 右侧列表下拉刷新中
    categories: [],
    sections: [], // 右侧每个分类一段：{ _id, name, dishes: [卡片] }
    activeId: "", // 左侧高亮的分类
    scrollIntoView: "", // 右侧要滚动到的那一段
    keyword: "",
    searching: false,
    searchResults: [],
    basket: {}, // 菜篮 { 菜品id: 份数 }
    basketCount: 0,
    basketByCat: {}, // 每个分类点了几份，显示在左侧分类上
  },

  async onLoad() {
    await this.loadData();
    // 有本地缓存时先显示的是缓存，等云上的最新数据回来再刷新一次
    try {
      await dishService.refresh();
    } catch (err) {
      if (this.data.status === "ready") ui.toast("网络不太好，先显示上次的菜谱");
      return;
    }
    if (this.dataVersion !== dishService.getVersion()) this.loadData();
  },

  onShow() {
    if (this.dataVersion !== undefined && this.dataVersion !== dishService.getVersion()) {
      // 新增、编辑、删除了菜品，或者改了分类，重新读一遍
      this.loadData();
    } else if (this.allDishes) {
      // 从详情页或「菜篮」回来时，菜篮可能变了
      this.applyBasket(planService.getBasket());
    }
    planService.updateBadge();
    // 对方可能刚在自己手机上改过，隔一会儿回到菜单就去云上看看
    if (this.dataVersion !== undefined) {
      dishService.refreshIfStale().then((changed) => {
        if (changed) this.loadData();
      });
    }
  },

  // 下拉右侧列表：马上去云上取最新的
  async onPullRefresh() {
    this.setData({ refreshing: true });
    try {
      await dishService.sync();
    } catch (err) {
      ui.showError(err);
    }
    await this.loadData();
    this.setData({ refreshing: false });
  },

  async loadData() {
    let categories;
    let dishes;
    try {
      [categories, dishes] = await Promise.all([categoryService.listCategories(), dishService.listDishes()]);
    } catch (err) {
      this.setData({ status: "error", errorText: ui.errorText(err) });
      return;
    }
    this.dataVersion = dishService.getVersion();
    // 搜索要用到原料，完整数据存在这里；不放进 data，因为页面不直接显示它
    this.allDishes = dishes;
    if (!categories.length && !dishes.length) {
      this.setData({ status: "welcome", categories: [], sections: [] });
      this.applyBasket(planService.getBasket());
      return;
    }
    const known = {};
    const sections = categories.map((c) => {
      known[c._id] = true;
      return { _id: c._id, name: c.name, dishes: dishes.filter((d) => d.categoryId === c._id).map(toCard) };
    });
    const orphans = dishes.filter((d) => !known[d.categoryId]);
    if (orphans.length) sections.push({ _id: UNCATEGORIZED, name: "未分类", dishes: orphans.map(toCard) });
    const ids = sections.map((s) => s._id);
    const activeId = ids.indexOf(this.data.activeId) >= 0 ? this.data.activeId : ids[0];
    this.sectionTops = null;
    this.setData(
      { status: "ready", categories: sections.map((s) => ({ _id: s._id, name: s.name })), sections, activeId },
      () => this.measureSections()
    );
    this.applyBasket(planService.getBasket());
    if (this.data.keyword.trim()) this.onSearchInput({ detail: { value: this.data.keyword } });
  },

  onRetry() {
    this.setData({ status: "loading" });
    dishService.refresh().then(
      () => this.loadData(),
      (err) => this.setData({ status: "error", errorText: ui.errorText(err) })
    );
  },

  // ---------- 第一次使用 ----------

  onImportSamples() {
    return this.runSetup("正在放示例菜", () => dishService.importSamples());
  },

  onStartEmpty() {
    return this.runSetup("正在准备", () => categoryService.ensureCategories(categoryService.DEFAULT_NAMES));
  },

  async runSetup(title, task) {
    if (this.busy) return;
    this.busy = true;
    wx.showLoading({ title, mask: true });
    try {
      await task();
      wx.hideLoading();
      await this.loadData();
    } catch (err) {
      wx.hideLoading();
      ui.alert("没弄好", ui.errorText(err));
    }
    this.busy = false;
  },

  // ---------- 左右联动 ----------

  // 记下每个分类段在右侧列表里的位置，滚动时据此判断该高亮哪个分类
  measureSections() {
    const query = this.createSelectorQuery();
    query.select(".dish-list").boundingClientRect();
    query.selectAll(".section").boundingClientRect();
    query.exec(([listRect, sectionRects]) => {
      if (!listRect || !sectionRects || !sectionRects.length) return;
      const scrollTop = this.scrollTop || 0;
      this.sectionTops = sectionRects.map((r) => r.top - listRect.top + scrollTop);
    });
  },

  onTapCategory(e) {
    const id = e.currentTarget.dataset.id;
    // 右侧滚动动画期间先不根据滚动改高亮，免得左边来回跳
    this.tapLock = true;
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => {
      this.tapLock = false;
    }, 600);
    // 先清空再设置，这样连续点同一个分类也能滚过去
    this.setData({ activeId: id, scrollIntoView: "" }, () => {
      this.setData({ scrollIntoView: `sec-${id}` });
    });
  },

  onDishScroll(e) {
    this.scrollTop = e.detail.scrollTop;
    if (this.tapLock || !this.data.sections.length) return;
    if (!this.sectionTops) {
      this.measureSections();
      return;
    }
    const y = e.detail.scrollTop + 20;
    let index = 0;
    this.sectionTops.forEach((top, i) => {
      if (top <= y) index = i;
    });
    this.setActive(this.data.sections[index]._id);
  },

  // 最后几个分类可能滚不到顶部，滚到底时直接高亮最后一个
  onDishScrollToLower() {
    const sections = this.data.sections;
    if (this.tapLock || !sections.length) return;
    this.setActive(sections[sections.length - 1]._id);
  },

  setActive(id) {
    if (id !== this.data.activeId) this.setData({ activeId: id });
  },

  // ---------- 搜索 ----------

  onSearchInput(e) {
    const keyword = e.detail.value;
    const kw = keyword.trim();
    this.setData({
      keyword,
      searching: !!kw,
      searchResults: kw ? (this.allDishes || []).filter((d) => matchKeyword(d, kw)).map(toCard) : [],
    });
  },

  onClearSearch() {
    this.setData({ keyword: "", searching: false, searchResults: [] });
  },

  // ---------- 点菜 ----------

  onPlus(e) {
    this.applyBasket(planService.add(e.currentTarget.dataset.id));
  },

  onMinus(e) {
    this.applyBasket(planService.remove(e.currentTarget.dataset.id));
  },

  applyBasket(basket) {
    const basketByCat = {};
    (this.allDishes || []).forEach((d) => {
      if (basket[d._id]) {
        basketByCat[d.categoryId] = (basketByCat[d.categoryId] || 0) + basket[d._id];
      }
    });
    this.setData({ basket, basketCount: planService.getCount(basket), basketByCat });
  },

  onGoToday() {
    if (!this.data.basketCount) return;
    wx.switchTab({ url: "/pages/today/index" });
  },

  // ---------- 跳转 ----------

  onOpenDish(e) {
    wx.navigateTo({ url: `/pages/dish-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  onOpenWishes() {
    wx.navigateTo({ url: "/pages/wishes/index" });
  },

  // 右上角「...」→ 转发给对方（体验版只有体验成员能打开）
  onShareAppMessage() {
    return { title: "拿手菜小本本：我们俩的菜谱", path: "/pages/menu/index" };
  },

  // 新菜默认放进当前高亮的分类；从某个空分类里点「添加」就放进那个分类
  onAddDish(e) {
    const id = (e && e.currentTarget.dataset.id) || this.data.activeId;
    const query = id && id !== UNCATEGORIZED ? `?categoryId=${id}` : "";
    wx.navigateTo({ url: `/pages/dish-edit/index${query}` });
  },
});
