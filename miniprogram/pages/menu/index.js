// 菜单：点单式首页（左分类、右菜品、底部点菜栏）。左上角是正在用的小本本，点开能切换、新建、加入
const dishService = require("../../services/dish");
const bookService = require("../../services/book");
const diagnose = require("../../services/diagnose");
const categoryService = require("../../services/category");
const planService = require("../../services/plan");
const ui = require("../../utils/ui");
const { closeSheet } = require("../../utils/sheet");
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
    bump: 0, // 加了一份菜篮弹一下：1、2 轮流换（换了 class 动画才会重播）
    basketByCat: {}, // 每个分类点了几份，显示在左侧分类上
    ordered: false, // 已经下了单（这时再点 + 就是加菜）
    showCart: false, // 菜篮（点底部点菜栏左边弹出来）
    cartClosing: false, // 菜篮正在收起来（播动画）
    cartItems: [], // 菜篮里的菜 [{ _id, name, cover, initial, qty, added }]
    broken: {}, // 加载失败的照片 { 照片地址: true }，显示占位图
    book: { initial: "", shortName: "", family: false }, // 左上角：正在用的小本本
    showBooks: false, // 切换小本本的面板
    welcomeHint: "", // 本本是空的时候，欢迎页最下面那句
  },

  async onLoad(options) {
    // 点家人发来的卡片打开：切到发卡片的那本（你也在那本里的话）
    if (options && options.book) await bookService.openShared(options.book);
    await this.reload();
  },

  // 先显示手机上存着的，再等云上的最新数据回来刷新一次（打开小程序、换了一本时）
  async reload() {
    await this.loadData();
    try {
      await dishService.refresh();
    } catch (err) {
      // 正在用的这本已经不在了（被移出了、删掉了）：已经回到个人本本，重新读一遍，再说一声
      if (err.code === "NOT_MEMBER" && !this.lostReload) {
        this.lostReload = true;
        await this.reload();
        this.lostReload = false;
        return;
      }
      if (this.data.status === "ready") ui.toast(err.code === "NO_API" ? "云函数 api 还没部署，先显示上次的菜谱" : "网络不太好，先显示上次的菜谱");
      return;
    }
    if (this.dataVersion !== dishService.getVersion()) await this.loadData();
    this.showBookNews();
  },

  // 第一次打开新版本时说一声旧数据去哪了；申请加入有结果了、被移出了，弹出来说一声
  async showBookNews() {
    if (this.showingNews) return;
    this.showingNews = true;
    const welcome = bookService.takeWelcome();
    if (welcome) {
      const who = welcome.memberCount > 2 ? `你们 ${welcome.memberCount} 个人都` : welcome.memberCount === 2 ? "你和 TA 都" : "你";
      const ok = await ui.confirm({
        title: "小本本来啦",
        content: `你们之前记的菜、做菜记录、菜篮和库存，都放进了「${welcome.name}」，${who}已经在里面。\n\n你还有一本只有自己能看的「我的小本本」，点菜单左上角的名字就能切换。`,
        confirmText: "知道了",
        cancelText: "改个名字",
      });
      if (!ok) wx.navigateTo({ url: `/pages/book/index?id=${welcome.bookId}` });
    }
    const switched = await bookService.showNotices();
    this.showingNews = false;
    if (switched) this.reload();
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
    bookService.updateDot();
    // 家人可能刚在自己手机上改过，隔一会儿回到菜单就去云上看看（顺便看看申请有没有结果）
    if (this.dataVersion !== undefined) {
      dishService.refreshIfStale().then((changed) => {
        if (changed) this.loadData();
        this.showBookNews();
      });
    }
  },

  // 下拉右侧列表：马上去云上取最新的
  async onPullRefresh() {
    this.setData({ refreshing: true, broken: {} }); // 加载失败的照片也重新试一次
    try {
      await dishService.sync();
    } catch (err) {
      ui.showError(err);
    }
    await this.loadData();
    this.setData({ refreshing: false });
    this.showBookNews();
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
    const book = bookService.current();
    this.setData({ book: { initial: book.initial, shortName: book.shortName, family: book.family } });
    if (!categories.length && !dishes.length) {
      this.setData({
        status: "welcome",
        categories: [],
        sections: [],
        welcomeHint: book.family
          ? `「${book.name}」里还没有菜。家人记过的菜不在这儿？点左上角看看是不是在别的小本本里`
          : "这是只有你能看的「我的小本本」。想和家人一起记，点左上角新建或者加入家庭本本",
      });
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

  // ---------- 切换小本本 ----------

  onOpenBooks() {
    this.setData({ showBooks: true });
  },

  onCloseBooks() {
    this.setData({ showBooks: false });
  },

  // 在面板里选了另一本：先显示手机上存着的那本，再去云上同步
  onBookSwitched() {
    this.setData({ status: "loading", keyword: "", searching: false, searchResults: [], broken: {} });
    planService.updateBadge();
    return this.reload();
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
    this.bumpBasket();
  },

  onMinus(e) {
    this.applyBasket(planService.remove(e.currentTarget.dataset.id));
  },

  // ---------- 菜篮（底部点菜栏左边） ----------

  // 菜篮里的菜，按菜单里的顺序；下单以后又点的标「加」
  cartItemsOf(basket) {
    const order = planService.getOrder();
    return (this.allDishes || [])
      .filter((d) => basket[d._id])
      .map((d) => ({
        _id: d._id,
        name: d.name,
        cover: d.coverThumb || d.cover,
        initial: d.name.slice(0, 1),
        qty: basket[d._id],
        added: !!order && basket[d._id] > (order.items[d._id] || 0),
      }));
  },

  onOpenCart() {
    if (!this.data.basketCount) {
      ui.toast("还没点菜，点菜名旁边的 +");
      return;
    }
    this.setData({ showCart: true, cartItems: this.cartItemsOf(this.data.basket) });
  },

  onCloseCart() {
    closeSheet(this, "cartClosing", () => this.setData({ showCart: false }));
  },

  noop() {},

  onCartPlus(e) {
    this.applyBasket(planService.add(e.currentTarget.dataset.id));
    ui.buzz();
  },

  // 加了一份：底部的菜篮弹一下，手机轻轻震一下
  bumpBasket() {
    this.setData({ bump: this.data.bump === 1 ? 2 : 1 });
    ui.buzz();
  },

  onCartMinus(e) {
    this.applyBasket(planService.remove(e.currentTarget.dataset.id));
  },

  async onClearCart() {
    const ordered = !!planService.getOrder();
    const ok = await ui.confirm({
      title: "清空菜篮？",
      content: `点的菜都拿掉${ordered ? "，点菜单也撤掉" : ""}，买菜清单的勾选也清掉。${bookService.isShared() ? "这本里大家的都会清空。" : ""}库存不受影响。`,
      confirmText: "清空",
      danger: true,
    });
    if (!ok) return;
    this.applyBasket(planService.clear());
  },

  applyBasket(basket) {
    const basketByCat = {};
    (this.allDishes || []).forEach((d) => {
      if (basket[d._id]) {
        basketByCat[d.categoryId] = (basketByCat[d.categoryId] || 0) + basket[d._id];
      }
    });
    const basketCount = planService.getCount(basket);
    this.setData({ basket, basketCount, basketByCat, ordered: !!planService.getOrder() });
    // 菜篮开着：跟着变；都拿掉了就收起来
    if (this.data.showCart) {
      if (basketCount) this.setData({ cartItems: this.cartItemsOf(basket) });
      else this.onCloseCart();
    }
  },

  // 去下单（确认点菜单）；已经下了单就去看点菜单
  onGoToday() {
    if (!this.data.basketCount) return;
    this.setData({ showCart: false });
    if (this.data.ordered) wx.switchTab({ url: "/pages/today/index" });
    else wx.navigateTo({ url: "/pages/checkout/index" });
  },

  // ---------- 跳转 ----------

  onOpenDish(e) {
    wx.navigateTo({ url: `/pages/dish-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  // 照片加载不出来（多半是云存储权限）：换成占位图，并提示一次去哪里查
  onCoverError(e) {
    this.setData({ broken: Object.assign({}, this.data.broken, { [e.currentTarget.dataset.src]: true }) });
    ui.photoHint();
  },

  // 搜不到的菜：记到想吃清单，菜名带过去
  onWishFromSearch() {
    wx.navigateTo({ url: `/pages/wish-edit/index?name=${encodeURIComponent(this.data.keyword.trim())}` });
  },

  // 读不到菜谱时：看看是哪个集合、哪项设置的问题
  onDiagnose() {
    return diagnose.run();
  },

  // 右上角「...」→ 转发（体验版只有体验成员能打开）
  onShareAppMessage() {
    return { title: bookService.isShared() ? "拿手菜小本本：我们家的菜谱" : "拿手菜小本本", path: `/pages/menu/index?book=${bookService.currentId()}` };
  },

  // 新菜默认放进当前高亮的分类；从某个空分类里点「添加」就放进那个分类
  onAddDish(e) {
    const id = (e && e.currentTarget.dataset.id) || this.data.activeId;
    const query = id && id !== UNCATEGORIZED ? `?categoryId=${id}` : "";
    wx.navigateTo({ url: `/pages/dish-edit/index${query}` });
  },
});
