// 新建家庭本本：起个名字、写上自己在这本里叫什么，可以把「我的小本本」里的菜复制一份过去（分类按名字对上，照片也复制）。
// 建好以后切到这本，打开小本本设置页：把家庭码告诉家人，或者发邀请卡片，TA 申请以后在那里点同意
const bookService = require("../../services/book");
const storage = require("../../utils/storage");
const ui = require("../../utils/ui");

const MAX_FAMILY = 5; // 一个人最多加几本家庭本本（云函数里也会查）
const NAMES = ["我们家的小本本", "家庭小本本", "一家人的小本本"];

Page({
  data: {
    name: "",
    myName: "",
    copy: false, // 把个人本本里的菜复制过去
    personalCount: 0, // 个人本本里有几道菜
    full: false, // 已经加了 5 本家庭本本
    busy: false,
  },

  onLoad() {
    const books = bookService.list();
    const taken = books.map((b) => b.name);
    const named = books.find((b) => b.myName);
    this.setData({
      name: NAMES.find((n) => taken.indexOf(n) < 0) || "",
      myName: (named && named.myName) || storage.get("cook_name") || storage.get("order_name") || "",
      full: books.filter((b) => b.family).length >= MAX_FAMILY,
    });
    bookService.dishCount(bookService.personalId()).then(
      (n) => this.setData({ personalCount: n }),
      () => {}
    );
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value });
  },

  onMyNameInput(e) {
    this.setData({ myName: e.detail.value });
  },

  onToggleCopy() {
    this.setData({ copy: !this.data.copy });
  },

  async onCreate() {
    if (this.data.busy) return;
    if (this.data.full) {
      ui.alert("加不了了", `最多加 ${MAX_FAMILY} 本家庭本本，先在「小本本设置」里退出一本`);
      return;
    }
    const name = this.data.name.trim();
    if (!name) {
      ui.toast("给小本本起个名字");
      return;
    }
    this.setData({ busy: true });
    wx.showLoading({ title: "正在建", mask: true });
    let bookId;
    try {
      bookId = await bookService.create(name, this.data.myName.trim());
    } catch (err) {
      wx.hideLoading();
      this.setData({ busy: false });
      ui.alert("没建好", ui.errorText(err));
      return;
    }
    let copyError = "";
    if (this.data.copy && this.data.personalCount) {
      try {
        await bookService.copyDishes(bookService.personalId(), bookId, null, (done, total) =>
          wx.showLoading({ title: `正在复制菜 ${done}/${total}`, mask: true })
        );
      } catch (err) {
        copyError = ui.errorText(err);
      }
    }
    wx.hideLoading();
    bookService.switchTo(bookId);
    if (copyError) await ui.alert("菜没复制完", `${copyError}\n\n小本本已经建好了，没复制过去的菜，可以以后在菜的详情页里一道道复制。`);
    wx.redirectTo({ url: `/pages/book/index?id=${bookId}&created=1` });
  },
});
