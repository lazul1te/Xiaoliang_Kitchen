// 切换小本本：从底部弹出的面板，菜单页左上角、「我的」页最上面点开。
// 列出你的本本（正在用的那本标出来，你是本主的那本有人申请时写着几个申请）、还在等本主同意的申请（能撤回），
// 下面是新建家庭本本、输入家庭码加入，还有「打开小程序时进入」哪本。用法：
//   <book-sheet show="{{showBooks}}" bind:close="onCloseBooks" bind:switch="onBookSwitched" />
// 选了另一本就切过去，再发 switch 事件，页面重新读数据
const bookService = require("../../services/book");
const ui = require("../../utils/ui");
const { closeSheet } = require("../../utils/sheet");

const LAST_USED = "上次用的那本";

Component({
  options: {
    styleIsolation: "apply-shared", // 用 app.wxss 里的面板、头像样式
  },

  properties: {
    show: { type: Boolean, value: false },
  },

  data: {
    books: [], // [{ _id, name, sub, initial, family, current, requestCount }]
    pending: [], // 等本主同意的 [{ _id, name, initial }]
    defaultText: LAST_USED,
    picking: false, // 正在选「打开小程序时进入」哪本
    options: [], // [{ id, label, on }]
    closing: false, // 正在收起来（播动画）
  },

  observers: {
    show(show) {
      if (!show) return;
      this.setData({ picking: false });
      this.render();
      bookService.refresh().then(
        () => this.render(),
        () => {}
      ); // 顺便看看有没有新的申请、申请通过了没有
    },
  },

  methods: {
    render() {
      const books = bookService.list();
      const def = books.find((b) => b._id === bookService.defaultBook());
      this.setData({
        books: books.map((b) => ({
          _id: b._id,
          name: b.name,
          sub: b.sub,
          initial: b.initial,
          family: b.family,
          current: b.current,
          requestCount: b.requestCount,
        })),
        pending: bookService.pending().map((p) => ({ _id: p._id, name: p.name, initial: (p.name || "家").slice(0, 1) })),
        defaultText: def ? def.name : LAST_USED,
      });
    },

    noop() {},

    onClose() {
      closeSheet(this, "closing", () => this.triggerEvent("close"));
    },

    // 点了正在用的那本：滑下去收起；换了一本：马上关掉，页面重新读那本的数据
    onPick(e) {
      const id = e.currentTarget.dataset.id;
      if (id === bookService.currentId()) {
        this.onClose();
        return;
      }
      this.triggerEvent("close");
      bookService.switchTo(id);
      this.triggerEvent("switch", { id });
    },

    onNew() {
      this.triggerEvent("close");
      wx.navigateTo({ url: "/pages/book-new/index" });
    },

    onJoin() {
      this.triggerEvent("close");
      wx.navigateTo({ url: "/pages/join/index" });
    },

    async onCancelRequest(e) {
      const { id, name } = e.currentTarget.dataset;
      const ok = await ui.confirm({ title: "撤回申请？", content: `不加入「${name}」了`, confirmText: "撤回" });
      if (!ok) return;
      try {
        await bookService.cancelRequest(id);
      } catch (err) {
        ui.alert("没撤回", ui.errorText(err));
        return;
      }
      this.render();
    },

    onOpenDefault() {
      const def = bookService.defaultBook();
      const books = bookService.list();
      const known = books.some((b) => b._id === def);
      this.setData({
        picking: true,
        options: [{ id: "", label: LAST_USED, on: !known }].concat(books.map((b) => ({ id: b._id, label: b.name, on: b._id === def }))),
      });
    },

    onCloseDefault() {
      this.setData({ picking: false });
    },

    async onSetDefault(e) {
      const id = e.currentTarget.dataset.id;
      try {
        await bookService.setDefault(id);
      } catch (err) {
        ui.alert("没设上", ui.errorText(err));
        return;
      }
      this.render();
      this.setData({ picking: false });
      ui.toast("设好了");
    },
  },
});
