// 烹饪模式：一步一步大字显示，左右滑动或点按钮切换；带计时的步骤可以开计时器，时间到了响铃、震动。
// 做菜时屏幕不会自动熄灭。最后一页「做好了」可以直接去打卡。
const dishService = require("../../services/dish");
const ui = require("../../utils/ui");
const { toDetail } = require("../../utils/dish");
const { playDing } = require("../../utils/sound");

const pad = (n) => (n < 10 ? `0${n}` : String(n));

// 秒数 → "02:00" / "1:05:00"
function clock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const TIMER_ACTIONS = { idle: "开始计时", running: "暂停", paused: "继续", done: "再来一次" };

Page({
  data: {
    dish: null, // { _id, name, ingredientGroups }
    steps: [], // [{ key, text, image, hasTimer, timerText, timerState, timerAction }]
    total: 0, // 一共几步
    current: 0, // 现在在第几页（最后一页是「做好了」）
    stepLabel: "",
    progress: 0, // 进度条百分比
    running: [], // 正在走的计时，显示在上面：[{ index, label }]
    showIngredients: false,
    notFound: false,
  },

  async onLoad(options) {
    this.timers = {}; // 第几步 → { remaining, running, endAt }
    let dish;
    try {
      dish = await dishService.getDish(options.id);
    } catch (err) {
      ui.alert("没读到这道菜", ui.errorText(err));
      return;
    }
    if (!dish) {
      this.setData({ notFound: true });
      return;
    }
    this.dish = dish;
    wx.setNavigationBarTitle({ title: dish.name });
    this.setData({
      dish: { _id: dish._id, name: dish.name, ingredientGroups: toDetail(dish).ingredientGroups },
      steps: dish.steps.map((s, i) => Object.assign({ key: i, text: s.text, image: s.image, hasTimer: s.timer > 0 }, this.timerView(i))),
      total: dish.steps.length,
    });
    this.go(0);
  },

  onShow() {
    wx.setKeepScreenOn({ keepScreenOn: true, fail() {} });
    // 切到后台再回来：按结束时间补算一下，期间到点的计时会马上响
    if (this.hasRunning()) {
      this.tick();
      this.startTicking();
    }
  },

  onHide() {
    wx.setKeepScreenOn({ keepScreenOn: false, fail() {} });
    this.stopTicking();
  },

  onUnload() {
    this.onHide();
    this.guardLeave(false);
  },

  // ---------- 翻页 ----------

  go(index) {
    const total = this.data.total;
    const current = Math.max(0, Math.min(total, index));
    this.setData({
      current,
      stepLabel: current === total ? (total ? "做好啦" : "还没写做法") : `第 ${current + 1} / ${total} 步`,
      progress: total ? Math.round((Math.min(current, total) / total) * 100) : 100,
    });
  },

  onSwipe(e) {
    if (e.detail.current !== this.data.current) this.go(e.detail.current);
  },

  onPrev() {
    this.go(this.data.current - 1);
  },

  onNext() {
    this.go(this.data.current + 1);
  },

  // 点上面正在走的计时，跳到那一步
  onJumpStep(e) {
    this.go(e.currentTarget.dataset.i);
  },

  onToggleIngredients() {
    this.setData({ showIngredients: !this.data.showIngredients });
  },

  noop() {},

  // ---------- 计时 ----------

  timerView(i) {
    const total = this.dish.steps[i].timer || 0;
    if (!total) return {};
    const t = this.timers[i];
    let state = "idle";
    if (t && t.running) state = "running";
    else if (t && t.remaining === 0) state = "done";
    else if (t && t.remaining < total) state = "paused";
    return {
      timerText: clock(t ? t.remaining : total),
      timerState: state,
      timerAction: TIMER_ACTIONS[state],
    };
  },

  renderTimers() {
    const data = {};
    this.dish.steps.forEach((s, i) => {
      if (!s.timer) return;
      const view = this.timerView(i);
      Object.keys(view).forEach((k) => {
        data[`steps[${i}].${k}`] = view[k];
      });
    });
    data.running = Object.keys(this.timers)
      .filter((k) => this.timers[k].running)
      .map((k) => ({ index: Number(k), label: `第 ${Number(k) + 1} 步 ${clock(this.timers[k].remaining)}` }));
    this.setData(data);
    this.guardLeave(this.hasRunning());
  },

  hasRunning() {
    return Object.keys(this.timers || {}).some((k) => this.timers[k].running);
  },

  // 开始 / 暂停 / 继续 / 再来一次
  onTimerMain(e) {
    const i = e.currentTarget.dataset.i;
    const total = this.dish.steps[i].timer;
    const t = this.timers[i] || (this.timers[i] = { remaining: total, running: false, endAt: 0 });
    if (t.running) {
      t.remaining = Math.max(0, Math.ceil((t.endAt - Date.now()) / 1000));
      t.running = false;
    } else {
      if (t.remaining === 0) t.remaining = total;
      t.endAt = Date.now() + t.remaining * 1000;
      t.running = true;
      this.startTicking();
    }
    this.renderTimers();
  },

  onTimerReset(e) {
    delete this.timers[e.currentTarget.dataset.i];
    this.renderTimers();
  },

  startTicking() {
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), 500);
  },

  stopTicking() {
    clearInterval(this.ticker);
    this.ticker = null;
  },

  tick() {
    const now = Date.now();
    Object.keys(this.timers).forEach((k) => {
      const t = this.timers[k];
      if (!t.running) return;
      t.remaining = Math.max(0, Math.ceil((t.endAt - now) / 1000));
      if (t.remaining === 0) {
        t.running = false;
        this.ring(Number(k));
      }
    });
    if (!this.hasRunning()) this.stopTicking();
    this.renderTimers();
  },

  // 时间到：响铃 + 震动 + 弹窗
  ring(i) {
    wx.vibrateLong({ fail() {} });
    playDing();
    ui.alert("⏰ 时间到了", `第 ${i + 1} 步：${this.dish.steps[i].text.slice(0, 40)}`);
  },

  // 还有计时在走的时候，点返回会先问一下
  guardLeave(on) {
    if (on === !!this.guarding) return;
    this.guarding = on;
    if (on && wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({ message: "还有计时在走，确定退出吗？", fail() {} });
    } else if (!on && wx.disableAlertBeforeUnload) {
      wx.disableAlertBeforeUnload({ fail() {} });
    }
  },

  // ---------- 做好了 ----------

  onFinish() {
    this.stopTicking();
    this.timers = {};
    this.guardLeave(false);
    wx.redirectTo({ url: `/pages/log-edit/index?dishId=${this.dish._id}` });
  },

  onEditDish() {
    wx.redirectTo({ url: `/pages/dish-edit/index?id=${this.dish._id}` });
  },

  onBack() {
    wx.navigateBack();
  },
});
