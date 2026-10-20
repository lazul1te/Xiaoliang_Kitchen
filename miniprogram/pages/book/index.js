// 小本本设置：改名字、我在这本里叫什么；家庭本本还有家庭码（复制、邀请家人，本主能换一个）、
// 加入申请（本主同意了才算加入）、成员（本主能移出别人）、退出这本（不用谁同意；最后一个人退出，这本就删掉了）。
// 从「我的」进来是正在用的那本；?id= 指定哪本，?created=1 是刚建好
const bookService = require("../../services/book");
const invite = require("../../utils/invite");
const ui = require("../../utils/ui");

const pad = (n) => (n < 10 ? `0${n}` : String(n));

function timeText(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

Page({
  data: {
    book: null, // services/book.js 的 get()
    gone: false, // 已经不在这本里了
    created: false,
    isCurrent: true,
    codeChars: [], // 家庭码一个字一格 [{ i, ch }]
    requests: [], // 等本主同意的申请（只有本主看得到）
    members: [],
  },

  onLoad(options) {
    this.bookId = options.id || bookService.currentId();
    this.setData({ created: options.created === "1" });
  },

  onShow() {
    this.render();
    // 看看有没有新的申请、成员和名字变了没有
    bookService.refresh().then(
      () => this.render(),
      () => {}
    );
  },

  render() {
    const book = bookService.get(this.bookId);
    if (!book) {
      this.setData({ book: null, gone: true });
      return;
    }
    this.setData(
      {
        book,
        gone: false,
        isCurrent: book._id === bookService.currentId(),
        codeChars: book.code.split("").map((ch, i) => ({ i, ch })),
        requests: book.requests.map((r) => Object.assign(r, { timeText: timeText(r.at) })),
        members: book.members,
      },
      () => {
        if (book.family) invite.prepare(this, book);
      }
    );
  },

  // 改动都走这里：转圈、出错弹窗、做完重新显示
  async run(title, task, done) {
    if (this.busy) return false;
    this.busy = true;
    wx.showLoading({ title, mask: true });
    let ok = true;
    try {
      await task();
      wx.hideLoading();
      if (done) ui.toast(done);
    } catch (err) {
      ok = false;
      wx.hideLoading();
      ui.alert("没弄好", ui.errorText(err));
    }
    this.busy = false;
    this.render();
    return ok;
  },

  // ---------- 名字 ----------

  async onRename() {
    const name = await ui.prompt({ title: "小本本的名字", placeholder: "比如：我们家的小本本", value: this.data.book.name });
    if (!name || name === this.data.book.name) return;
    await this.run("正在保存", () => bookService.rename(this.bookId, name), "改好了");
  },

  async onMyName() {
    const name = await ui.prompt({ title: "我在这本里叫", placeholder: "写个名字，家人认得出来", value: this.data.book.myName });
    if (name === null || name === this.data.book.myName) return;
    await this.run("正在保存", () => bookService.setMyName(this.bookId, name), "改好了");
  },

  onSwitchHere() {
    bookService.switchTo(this.bookId);
    wx.switchTab({ url: "/pages/menu/index" });
  },

  onNewBook() {
    wx.navigateTo({ url: "/pages/book-new/index" });
  },

  // ---------- 家庭码、邀请 ----------

  onCopyCode() {
    wx.setClipboardData({
      data: this.data.book.code,
      success: () => ui.toast("家庭码复制好了"),
      fail: (err) => ui.apiFail("复制", err),
    });
  },

  async onNewCode() {
    const ok = await ui.confirm({
      title: "换一个家庭码？",
      content: "旧的家庭码马上就不能用了，已经发出去的邀请卡片也会失效。已经在这本里的人不受影响。",
      confirmText: "换一个",
    });
    if (ok) await this.run("正在换", () => bookService.newCode(this.bookId), "换好了");
  },

  // 「邀请家人」按钮、右上角「...」转发：发邀请卡片，对方点开就是加入页面
  onShareAppMessage() {
    const book = this.data.book;
    if (!book || !book.family) return { title: "拿手菜小本本", path: "/pages/menu/index" };
    return invite.share(this, book);
  },

  // ---------- 加入申请（本主） ----------

  async onApprove(e) {
    await this.run("正在同意", () => bookService.approve(this.bookId, e.currentTarget.dataset.id), "同意了，TA 打开小程序就能看到这本");
  },

  async onReject(e) {
    const ok = await ui.confirm({ title: "不同意？", content: `「${e.currentTarget.dataset.name}」不能加入这本，TA 会收到通知`, confirmText: "不同意" });
    if (ok) await this.run("正在处理", () => bookService.reject(this.bookId, e.currentTarget.dataset.id));
  },

  // ---------- 成员 ----------

  async onRemoveMember(e) {
    const ok = await ui.confirm({
      title: `把「${e.currentTarget.dataset.name}」移出这本？`,
      content: "TA 就看不到这本了，TA 记的东西会留在这本里。想回来要重新申请。",
      confirmText: "移出",
      danger: true,
    });
    if (ok) await this.run("正在移出", () => bookService.removeMember(this.bookId, e.currentTarget.dataset.id), "移出了");
  },

  // 退出不用谁同意。最后一个人退出，这本连同里面的东西一起删掉（先提醒导出备份）
  async onLeave() {
    const book = this.data.book;
    const last = book.members.length <= 1;
    const ok = await ui.confirm(
      last
        ? {
            title: "删掉这本？",
            content: `你是「${book.name}」里最后一个人，退出以后这本连同里面的菜谱、记录、照片都会删掉，找不回来。想留一份的话，先切到这本，在「我的 → 备份与导入」里导出。`,
            confirmText: "删掉并退出",
            cancelText: "先不了",
            danger: true,
          }
        : {
            title: `退出「${book.name}」？`,
            content: `退出以后就看不到这本了，你记的东西会留在这本里。想回来要重新申请。${book.owner ? "你是本主，退出以后最早加入的人接着当本主。" : ""}`,
            confirmText: "退出",
            danger: true,
          }
    );
    if (!ok) return;
    const left = await this.run(last ? "正在删除" : "正在退出", () => bookService.leave(book._id));
    if (!left) return;
    wx.switchTab({ url: "/pages/menu/index", success: () => ui.toast(last ? "这本删掉了" : "退出了") });
  },
});
