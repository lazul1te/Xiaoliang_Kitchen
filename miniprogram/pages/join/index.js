// 加入家庭本本：输入家庭码（点邀请卡片进来时已经填好），先看到是哪一本、有几个人，写上自己在这本里叫什么，申请加入。
// 本主同意了才算加入（同意以后打开小程序会收到通知）；还没同意之前可以撤回
const bookService = require("../../services/book");
const storage = require("../../utils/storage");
const ui = require("../../utils/ui");

const CODE_LENGTH = 6;
const CODE_CHARS = /^[2-9A-HJKMNP-Z]*$/; // 家庭码里没有 0、O、1、I、L

const cleanCode = (v) =>
  String(v || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .slice(0, CODE_LENGTH);

// 自己在别的本本里写过的名字，或者这台手机上次写的掌勺、点菜人
function defaultName() {
  const named = bookService.list().find((b) => b.myName);
  return (named && named.myName) || storage.get("cook_name") || storage.get("order_name") || "";
}

Page({
  data: {
    code: "",
    checking: false,
    error: "",
    found: null, // { bookId, name, initial, sub, status }
    status: "", // "" 还没申请 / pending 等本主同意 / member 已经在里面了
    myName: "",
    sending: false,
  },

  onLoad(options) {
    const code = cleanCode(options.code);
    this.setData({ code, myName: defaultName() });
    if (code.length === CODE_LENGTH) this.check(code);
  },

  // 输入框里的字换成大写、去掉空格（返回的字符串会替换输入框的内容）
  onCodeInput(e) {
    const code = cleanCode(e.detail.value);
    this.setData({ code, error: "" });
    if (code.length < CODE_LENGTH) {
      this.checked = "";
      this.setData({ found: null, status: "" });
    } else if (code !== this.checked) {
      this.check(code);
    }
    return code;
  },

  async check(code) {
    this.checked = code;
    if (!CODE_CHARS.test(code)) {
      this.setData({ error: "家庭码里没有 0、O、1、I、L，再看看是不是认错了", found: null });
      return;
    }
    this.setData({ checking: true, error: "", found: null });
    let found;
    try {
      found = await bookService.peek(code);
    } catch (err) {
      if (this.data.code === code) this.setData({ checking: false, error: ui.errorText(err) });
      return;
    }
    if (this.data.code !== code) return; // 已经改了家庭码
    const owner = found.ownerName ? ` · 本主 ${found.ownerName}` : "";
    this.setData({
      checking: false,
      status: found.status,
      found: {
        bookId: found.bookId,
        name: found.name,
        initial: /^我们/.test(found.name) || !found.name ? "家" : found.name.slice(0, 1),
        sub: `${found.memberCount} 位成员 · ${found.dishCount} 道菜${owner}`,
      },
    });
  },

  onNameInput(e) {
    this.setData({ myName: e.detail.value });
  },

  async onRequest() {
    if (this.data.sending || !this.data.found) return;
    const name = this.data.myName.trim();
    if (!name) {
      ui.toast("写个名字，本主才知道是谁");
      return;
    }
    this.setData({ sending: true });
    let status;
    try {
      status = await bookService.requestJoin(this.data.code, name);
    } catch (err) {
      this.setData({ sending: false });
      ui.alert("没申请上", ui.errorText(err));
      return;
    }
    this.setData({ sending: false, status });
  },

  async onCancel() {
    const ok = await ui.confirm({ title: "撤回申请？", content: `不加入「${this.data.found.name}」了`, confirmText: "撤回" });
    if (!ok) return;
    try {
      await bookService.cancelRequest(this.data.found.bookId);
    } catch (err) {
      ui.alert("没撤回", ui.errorText(err));
      return;
    }
    this.setData({ status: "" });
  },

  onSwitch() {
    bookService.switchTo(this.data.found.bookId);
    wx.switchTab({ url: "/pages/menu/index" });
  },

  onGoMenu() {
    wx.switchTab({ url: "/pages/menu/index" });
  },
});
