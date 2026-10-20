// 做饭总结：按月、按年、全部看做菜记录 —— 下厨几次、几道不同的菜、几天在做饭，最常做的菜、谁掌勺、打分最高，
// 每个月下厨几次（按年、全部），这段时间第一次做的菜，好久没做的菜（全部）。统计都在 utils/stats.js。
// 从记录页日历右上角的「总结」进来，看日历上正在看的那个月（?month=2026-09）；从「我的」进来看这个月
const dishService = require("../../services/dish");
const logService = require("../../services/log");
const ui = require("../../utils/ui");
const { summarize, shiftRange, canShift, isCurrent } = require("../../utils/stats");

const KINDS = [
  { key: "month", label: "按月" },
  { key: "year", label: "按年" },
  { key: "all", label: "全部" },
];

// 这段时间一条记录都没有时说什么
function emptyTextOf(range, title, current) {
  if (range.kind === "all") return "还没有做菜记录";
  if (current) return range.kind === "month" ? "这个月还没下厨" : "今年还没下厨";
  return `${title}没有做菜记录`;
}

Page({
  data: {
    loaded: false,
    kinds: KINDS,
    kind: "month", // month / year / all
    s: null, // 统计结果（utils/stats.js 的 summarize）
    canPrev: false,
    canNext: false,
    current: true, // 看的是这个月、今年或者全部
    emptyText: "",
    anim: "", // 换月、换年时内容滑进来（app.wxss 的 slide-*），切按月 / 按年 / 全部时淡出来
  },

  onLoad(options) {
    const now = new Date(Date.now());
    const m = /^(\d{4})-(\d{2})$/.exec((options && options.month) || "");
    this.range = m
      ? { kind: "month", year: Number(m[1]), month: Number(m[2]) - 1 }
      : { kind: "month", year: now.getFullYear(), month: now.getMonth() };
    this.logs = [];
    this.dishes = [];
  },

  onShow() {
    this.load();
    // 家人可能刚记了几道，隔一会儿回来就去云上看看
    dishService.refreshIfStale().then((changed) => {
      if (changed) this.load();
    });
  },

  async onPullDownRefresh() {
    try {
      await dishService.sync();
    } catch (err) {
      ui.showError(err);
    }
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    try {
      [this.logs, this.dishes] = await Promise.all([logService.listLogs(), dishService.listDishes()]);
    } catch (err) {
      ui.toast(ui.errorText(err));
    }
    this.render();
  },

  render(anim) {
    const now = Date.now();
    const range = this.range;
    const s = summarize(this.logs, this.dishes, range, now);
    const current = isCurrent(range, now);
    this.setData({
      loaded: true,
      kind: range.kind,
      s,
      canPrev: canShift(range, -1, this.logs, now),
      canNext: canShift(range, 1, this.logs, now),
      current,
      emptyText: emptyTextOf(range, s.title, current),
      anim: anim || "",
    });
  },

  // 按月 / 按年 / 全部：看的还是那个月、那一年
  onPickKind(e) {
    const kind = e.currentTarget.dataset.kind;
    if (kind === this.range.kind) return;
    this.range = Object.assign({}, this.range, { kind });
    this.render("unfold");
  },

  onPrev() {
    this.shift(-1);
  },

  onNext() {
    this.shift(1);
  },

  // 上一个月（年）、下一个月（年）。新的从左边、右边滑进来；1、2 轮流换，连着翻也每次都有动画
  shift(delta) {
    if (!(delta > 0 ? this.data.canNext : this.data.canPrev)) return;
    this.range = shiftRange(this.range, delta);
    this.flip = !this.flip;
    this.render((delta > 0 ? "slide-next" : "slide-prev") + (this.flip ? "1" : "2"));
  },

  onOpenDish(e) {
    const { id, gone } = e.currentTarget.dataset;
    if (gone) {
      ui.toast("这道菜已经删掉了");
      return;
    }
    wx.navigateTo({ url: `/pages/dish-detail/index?id=${id}` });
  },
});
