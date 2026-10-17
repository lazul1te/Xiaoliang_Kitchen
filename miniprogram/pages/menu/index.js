// 菜单：点单式首页（左分类、右菜品、底部点菜栏）
const dishService = require("../../services/dish");
const basketStore = require("../../store/basket");
const { toCard, matchKeyword } = require("../../utils/dish");

Page({
  data: {
    categories: [],
    sections: [], // 右侧每个分类一段：{ _id, name, dishes: [卡片] }
    activeId: "", // 左侧高亮的分类
    scrollIntoView: "", // 右侧要滚动到的那一段
    keyword: "",
    searching: false,
    searchResults: [],
    basket: {}, // 点菜篮 { 菜品id: 份数 }
    basketCount: 0,
    basketByCat: {}, // 每个分类点了几份，显示在左侧分类上
  },

  async onLoad() {
    const [categories, dishes] = await Promise.all([
      dishService.listCategories(),
      dishService.listDishes(),
    ]);
    // 搜索要用到原料，完整数据存在这里；不放进 data，因为页面不直接显示它
    this.allDishes = dishes;
    const sections = categories.map((c) => ({
      _id: c._id,
      name: c.name,
      dishes: dishes.filter((d) => d.categoryId === c._id).map(toCard),
    }));
    this.setData(
      { categories, sections, activeId: categories.length ? categories[0]._id : "" },
      () => this.measureSections()
    );
    this.applyBasket(basketStore.getBasket());
  },

  onShow() {
    // 从详情页或「今日」回来时，点菜篮可能变了
    if (this.allDishes) this.applyBasket(basketStore.getBasket());
    basketStore.updateBadge();
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
      searchResults: kw ? this.allDishes.filter((d) => matchKeyword(d, kw)).map(toCard) : [],
    });
  },

  onClearSearch() {
    this.setData({ keyword: "", searching: false, searchResults: [] });
  },

  // ---------- 点菜 ----------

  onPlus(e) {
    this.applyBasket(basketStore.add(e.currentTarget.dataset.id));
  },

  onMinus(e) {
    this.applyBasket(basketStore.remove(e.currentTarget.dataset.id));
  },

  applyBasket(basket) {
    const basketByCat = {};
    (this.allDishes || []).forEach((d) => {
      if (basket[d._id]) {
        basketByCat[d.categoryId] = (basketByCat[d.categoryId] || 0) + basket[d._id];
      }
    });
    this.setData({ basket, basketCount: basketStore.getCount(basket), basketByCat });
  },

  onGoToday() {
    if (!this.data.basketCount) return;
    wx.switchTab({ url: "/pages/today/index" });
  },

  // ---------- 跳转 ----------

  onOpenDish(e) {
    wx.navigateTo({ url: `/pages/dish-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  onAddDish() {
    wx.showToast({ title: "新增菜品下一步就做", icon: "none" });
  },
});
