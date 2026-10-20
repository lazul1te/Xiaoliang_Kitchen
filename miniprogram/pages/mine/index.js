// 我的：最上面是正在用的小本本（能切换、邀请家人、进设置；你是本主时有人申请会提醒），
// 下面是这本的统计、常用的（想吃清单、库存）放大方块，不常用的（备份与导入、检查云开发）收起来
const dishService = require("../../services/dish");
const bookService = require("../../services/book");
const invite = require("../../utils/invite");
const planService = require("../../services/plan");
const pantryService = require("../../services/pantry");
const wishService = require("../../services/wish");
const diagnose = require("../../services/diagnose");
const ui = require("../../utils/ui");

Page({
  data: {
    stats: { total: 0, mastered: 0, cooked: 0 },
    sampleCount: 0, // 还剩几道示例菜
    wishCount: 0, // 想吃清单里有几个
    outCount: 0, // 库存里几样用完了
    stockCount: 0, // 库存里家里有几样
    book: null, // 正在用的小本本（services/book.js 的 current()）
    requestText: "", // 你是本主的本本里有人申请加入
    footerText: "",
    showBooks: false,
  },

  onShow() {
    planService.updateBadge();
    bookService.updateDot();
    this.refresh();
    dishService.refreshIfStale().then((changed) => {
      if (changed) this.refresh();
      this.showNotices();
    });
  },

  // 申请加入有结果了、被移出了：弹出来说一声
  async showNotices() {
    if (this.noticing) return;
    this.noticing = true;
    const switched = await bookService.showNotices();
    this.noticing = false;
    if (switched) this.refresh();
  },

  // 最上面的名片：正在用的这本；你是本主的本本里有人申请加入，写着去看看
  renderBook() {
    const book = bookService.current();
    const asking = bookService.list().filter((b) => b.requestCount);
    const count = asking.reduce((n, b) => n + b.requestCount, 0);
    this.requestBookId = asking.length ? asking[0]._id : "";
    this.setData(
      {
        book,
        requestText: !count ? "" : asking.length > 1 || asking[0]._id !== book._id ? `${count} 个人申请加入「${asking[0].name}」等本本` : `${count} 个人申请加入这本`,
        footerText: book.family ? `「${book.name}」里的人都能看、都能改` : "「我的小本本」只有你能看",
      },
      () => {
        if (book.family) invite.prepare(this, book);
      }
    );
  },

  async refresh() {
    this.renderBook();
    let dishes;
    try {
      dishes = await dishService.listDishes();
    } catch (err) {
      return; // 读不到就先显示 0，菜单页会提示具体原因
    }
    this.setData({
      stats: {
        total: dishes.length,
        mastered: dishes.filter((d) => d.status === "mastered").length,
        cooked: dishes.reduce((sum, d) => sum + (d.cookCount || 0), 0),
      },
      sampleCount: dishes.filter((d) => d.sample).length,
      wishCount: wishService.list().length,
      outCount: pantryService.list().outOfStock.length,
      stockCount: pantryService.list().inStock.length,
    });
  },

  onOpenWishes() {
    wx.navigateTo({ url: "/pages/wishes/index" });
  },

  onOpenPantry() {
    wx.navigateTo({ url: "/pages/pantry/index" });
  },

  // 底部小字「遇到问题？检查一下云开发」
  onCheckDatabase() {
    return diagnose.run();
  },

  onGoMenu() {
    wx.switchTab({ url: "/pages/menu/index" });
  },

  onGoLogs() {
    wx.switchTab({ url: "/pages/logs/index" });
  },

  onOpenBackup() {
    wx.navigateTo({ url: "/pages/backup/index" });
  },

  onOpenCategories() {
    wx.navigateTo({ url: "/pages/categories/index" });
  },

  // ---------- 小本本 ----------

  onOpenBooks() {
    this.setData({ showBooks: true });
  },

  onCloseBooks() {
    this.setData({ showBooks: false });
  },

  onBookSwitched() {
    this.refresh();
  },

  onOpenSettings() {
    wx.navigateTo({ url: "/pages/book/index" });
  },

  onOpenRequests() {
    wx.navigateTo({ url: `/pages/book/index?id=${this.requestBookId}` });
  },

  // 「邀请家人」按钮：发邀请卡片，对方点开就是加入页面；右上角「...」转发也一样（个人本本就是普通的转发）
  onShareAppMessage() {
    const book = this.data.book;
    if (!book || !book.family) return { title: "拿手菜小本本", path: "/pages/menu/index" };
    return invite.share(this, book);
  },

  async onRemoveSamples() {
    const ok = await ui.confirm({
      title: `删除 ${this.data.sampleCount} 道示例菜？`,
      content: bookService.isShared()
        ? "这本里大家的菜单里都会删掉。你们自己加的菜、改过的示例菜都会留着。"
        : "自己加的菜、改过的示例菜都会留着。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    wx.showLoading({ title: "删除中", mask: true });
    try {
      const count = await dishService.removeSamples();
      wx.hideLoading();
      ui.toast(`已删除 ${count} 道示例菜`);
    } catch (err) {
      wx.hideLoading();
      ui.alert("没删成", ui.errorText(err));
    }
    await this.refresh();
  },
});
