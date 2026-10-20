// 做菜（一起做）：先下单再开始做，做的就是点菜单上的菜（?from=basket；&dish=菜品id 直接打开那道菜）。
// 一步一步大字显示，左右滑动或点按钮切换；带计时的步骤可以开计时器，时间到了响铃、震动。做菜时屏幕不会自动熄灭。
// 上面按菜切换，第一页是备菜（要提前做的、建议顺序、备菜清单）；计时器各走各的，切到别的菜也不停；
// 进度存在这台手机上（services/cook-session.js），退出了回来能接着做；每道菜做完点「这道做好了」，都做好了去开饭页一次记下来。
const dishService = require("../../services/dish");
const planService = require("../../services/plan");
const cookSession = require("../../services/cook-session");
const ui = require("../../utils/ui");
const { playDing } = require("../../utils/sound");
const { shortName, cookOrder, waitSteps, prepGroups, ingredientGroups } = require("../../utils/cook");

const PREP = "prep"; // 「备菜」标签
const pad = (n) => (n < 10 ? `0${n}` : String(n));

// 秒数 → "02:00" / "1:05:00"
function clock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// 计时器的 key：「菜品id:第几步」
const keyOf = (id, i) => `${id}:${i}`;
function parseKey(key) {
  const at = key.lastIndexOf(":");
  return [key.slice(0, at), Number(key.slice(at + 1))];
}

const TIMER_ACTIONS = { idle: "开始计时", running: "暂停", paused: "继续", done: "再来一次" };

Page({
  data: {
    tab: "", // 正在看的：PREP 备菜，或者菜品 id
    tabs: [], // 上面的标签 [{ key, label, sub, done }]
    // 备菜
    waits: [], // 要提前做的步骤（腌、泡……）
    sequence: [], // 建议顺序
    sequenceTip: "",
    prep: [], // 备菜清单（utils/cook.js 的 prepGroups，带 checked）
    startText: "", // 备菜页下面的按钮
    // 正在做的这道菜
    dish: null, // { _id, name, qty, ingredientGroups }
    steps: [], // [{ key, text, image, hasTimer, timerText, timerState, timerAction }]
    total: 0, // 一共几步
    current: 0, // 现在在第几页（最后一页是「做好啦」）
    swiperKey: "", // 换了菜就换一个，滑动区重新建，直接停在那道菜做到的那一步
    stepLabel: "",
    progress: 0, // 进度条百分比
    dishDone: false, // 这道菜点过「做好了」
    nextText: "", // 「下一道：番茄鸡蛋汤」
    running: [], // 正在走的计时，显示在上面：[{ key, label }]
    showIngredients: false,
    notFound: false,
    emptyText: "",
    emptyDesc: "",
  },

  async onLoad(options) {
    this.entries = {}; // 菜品id → { dish, qty }
    this.ids = []; // 做哪几道，按先后
    this.timers = {}; // 「菜品id:第几步」→ { remaining, running, endAt }
    this.pos = {}; // 菜品id → 做到第几页
    this.done = {}; // 菜品id → 做好了
    this.prepChecked = {}; // 原料key → 备好了
    await this.loadBasket(options.dish);
  },

  // 点菜单上的菜，用时长的先做；做到一半退出过的，接着上次的进度。focus：直接打开这道菜
  async loadBasket(focus) {
    let dishes;
    try {
      dishes = await dishService.listDishes();
    } catch (err) {
      ui.alert("没读到菜谱", ui.errorText(err));
      return;
    }
    if (!planService.getOrder()) {
      this.setData({ notFound: true, emptyText: "还没下单", emptyDesc: "先在菜篮里下单，再开始做" });
      return;
    }
    const basket = planService.getBasket();
    const planned = cookOrder(dishes.filter((d) => basket[d._id]).map((dish) => ({ dish, qty: basket[dish._id] })));
    if (!planned.length) {
      this.setData({ notFound: true, emptyText: "点菜单上没有菜", emptyDesc: "先去菜单点几道菜" });
      return;
    }
    planned.forEach((p) => {
      this.entries[p.dish._id] = p;
    });
    const ids = planned.map((p) => p.dish._id);
    const session = cookSession.load();
    let tab = PREP;
    if (session) {
      // 上次的先后不变，后来加进菜篮的排在后面；已经不在菜篮里的菜不管了
      const has = (id) => !!this.entries[id];
      this.ids = session.dishIds.filter(has).concat(ids.filter((id) => session.dishIds.indexOf(id) < 0));
      Object.keys(session.pos).filter(has).forEach((id) => (this.pos[id] = session.pos[id]));
      Object.keys(session.done).filter(has).forEach((id) => (this.done[id] = true));
      Object.keys(session.prep).filter((k) => has(parseKey(k)[0])).forEach((k) => (this.prepChecked[k] = true));
      Object.keys(session.timers).filter((k) => has(parseKey(k)[0])).forEach((k) => (this.timers[k] = session.timers[k]));
      this.startedAt = session.startedAt;
      if (has(session.tab)) tab = session.tab;
    } else {
      this.ids = ids;
      this.startedAt = Date.now();
    }
    if (focus && this.entries[focus]) tab = focus;
    const ordered = this.ids.map((id) => this.entries[id]);
    const timed = ordered.filter((p) => p.dish.duration > 0);
    this.prepKeys = [].concat(...prepGroups(ordered).map((g) => g.items.map((i) => i.key)));
    wx.setNavigationBarTitle({ title: `一起做 · ${this.ids.length} 道菜` });
    this.setData({
      waits: waitSteps(ordered),
      sequence: ordered.map(({ dish }) => ({ _id: dish._id, name: dish.name, durationText: dish.duration > 0 ? `${dish.duration} 分钟` : "没写用时" })),
      sequenceTip: timed.length >= 2 ? `快手菜等${shortName(timed[0].dish.name)}快好了再下锅，差不多能一起出锅` : "",
    });
    if (tab === PREP) this.showPrep();
    else this.showDish(tab);
    // 离开期间到点的计时，马上提醒
    this.tick();
    if (this.hasRunning()) this.startTicking();
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

  // 做菜的进度存到手机上，退出了回来接着做
  persist() {
    if (!this.ids.length) return;
    cookSession.save({
      dishIds: this.ids,
      tab: this.data.tab || PREP,
      pos: this.pos,
      done: this.done,
      prep: this.prepChecked,
      timers: this.timers,
      startedAt: this.startedAt,
    });
  },

  // ---------- 上面的标签：备菜 / 每道菜 ----------

  prepAllDone() {
    const keys = this.prepKeys || [];
    return keys.length > 0 && keys.every((k) => this.prepChecked[k]);
  },

  renderTabs() {
    const prepDone = this.prepAllDone();
    const tabs = [{ key: PREP, label: "备菜", sub: prepDone ? "✓" : "", done: prepDone }].concat(
      this.ids.map((id) => {
        const { dish } = this.entries[id];
        const done = !!this.done[id];
        const at = Math.min(this.pos[id] || 0, dish.steps.length);
        return { key: id, label: shortName(dish.name), sub: done ? "✓" : `${at}/${dish.steps.length}`, done };
      })
    );
    this.setData({ tabs });
  },

  onTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key === PREP) this.showPrep();
    else this.showDish(key);
    this.persist();
  },

  // 下一道没做好的菜（不算 except）
  nextDish(except) {
    return this.ids.find((id) => id !== except && !this.done[id]);
  },

  showPrep() {
    const next = this.nextDish();
    const prep = prepGroups(this.ids.map((id) => this.entries[id])).map((g) =>
      Object.assign(g, { items: g.items.map((i) => Object.assign(i, { checked: !!this.prepChecked[i.key] })) })
    );
    this.setData({
      tab: PREP,
      prep,
      startText: next ? `开始做：${shortName(this.entries[next].dish.name)}` : "都做好了，开饭",
      showIngredients: false,
    });
    this.renderTabs();
  },

  showDish(id) {
    const { dish, qty } = this.entries[id];
    const next = this.nextDish(id);
    this.setData(
      Object.assign(
        {
          tab: id,
          swiperKey: id,
          dish: { _id: dish._id, name: dish.name, qty, ingredientGroups: ingredientGroups(dish, qty) },
          steps: dish.steps.map((s, i) => Object.assign({ key: i, text: s.text, image: s.image, hasTimer: s.timer > 0 }, this.timerView(id, i))),
          total: dish.steps.length,
          dishDone: !!this.done[id],
          nextText: next ? `下一道：${this.entries[next].dish.name}` : "这是最后一道了，做好就开饭",
          showIngredients: false,
        },
        this.pageOf(this.pos[id] || 0, dish.steps.length)
      )
    );
    this.renderTabs();
  },

  // ---------- 翻页 ----------

  // 第几页的显示（最后一页是「做好啦」）
  pageOf(index, total) {
    const current = Math.max(0, Math.min(total, index));
    let stepLabel = `第 ${current + 1} / ${total} 步`;
    if (current === total) stepLabel = !total ? "还没写做法" : "最后一步做完了";
    return { current, stepLabel, progress: total ? Math.round((current / total) * 100) : 100 };
  },

  go(index) {
    const page = this.pageOf(index, this.data.total);
    this.setData(page);
    const id = this.data.tab;
    if (id && id !== PREP) this.pos[id] = page.current;
    this.renderTabs();
    this.persist();
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

  // 跳到某道菜的某一步（点上面正在走的计时、点备菜页「先做这些」）
  jumpTo(id, i) {
    this.pos[id] = i;
    if (this.data.tab === id) this.go(i);
    else this.showDish(id);
    this.persist();
  },

  onJumpStep(e) {
    const [id, i] = parseKey(e.currentTarget.dataset.key);
    this.jumpTo(id, i);
  },

  onJumpWait(e) {
    const { id, i } = e.currentTarget.dataset;
    this.jumpTo(id, i);
  },

  onToggleIngredients() {
    this.setData({ showIngredients: !this.data.showIngredients });
  },

  noop() {},

  // ---------- 备菜 ----------

  onTogglePrep(e) {
    const key = e.currentTarget.dataset.key;
    if (this.prepChecked[key]) delete this.prepChecked[key];
    else this.prepChecked[key] = true;
    this.showPrep();
    this.persist();
  },

  // 备菜页下面的按钮：开始做下一道没做好的；都做好了就开饭
  onStartCooking() {
    const next = this.nextDish();
    if (!next) {
      this.onServe();
      return;
    }
    this.showDish(next);
    this.persist();
  },

  // ---------- 计时 ----------

  timerView(id, i) {
    const total = this.entries[id].dish.steps[i].timer || 0;
    if (!total) return {};
    const t = this.timers[keyOf(id, i)];
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
    const id = this.data.tab;
    if (id && id !== PREP) {
      this.entries[id].dish.steps.forEach((s, i) => {
        if (!s.timer) return;
        const view = this.timerView(id, i);
        Object.keys(view).forEach((k) => {
          data[`steps[${i}].${k}`] = view[k];
        });
      });
    }
    data.running = Object.keys(this.timers)
      .filter((k) => this.timers[k].running)
      .map((k) => {
        const [dishId, i] = parseKey(k);
        return { key: k, label: `${shortName(this.entries[dishId].dish.name)} · 第 ${i + 1} 步 ${clock(this.timers[k].remaining)}` };
      });
    this.setData(data);
    this.guardLeave(this.hasRunning());
    this.persist();
  },

  hasRunning() {
    return Object.keys(this.timers || {}).some((k) => this.timers[k].running);
  },

  // 开始 / 暂停 / 继续 / 再来一次（data-i 是这道菜的第几步）
  onTimerMain(e) {
    const id = this.data.tab;
    const i = e.currentTarget.dataset.i;
    const total = this.entries[id].dish.steps[i].timer;
    const key = keyOf(id, i);
    const t = this.timers[key] || (this.timers[key] = { remaining: total, running: false, endAt: 0 });
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
    delete this.timers[keyOf(this.data.tab, e.currentTarget.dataset.i)];
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
    const rang = [];
    Object.keys(this.timers).forEach((k) => {
      const t = this.timers[k];
      if (!t.running) return;
      t.remaining = Math.max(0, Math.ceil((t.endAt - now) / 1000));
      if (t.remaining === 0) {
        t.running = false;
        rang.push(k);
      }
    });
    if (!this.hasRunning()) this.stopTicking();
    this.renderTimers();
    if (rang.length) this.ring(rang);
  },

  // 时间到：响铃 + 震动 + 弹窗，写明是哪道菜，点「去看看」跳过去
  ring(keys) {
    wx.vibrateLong({ fail() {} });
    playDing();
    const items = keys.map((k) => {
      const [id, i] = parseKey(k);
      const dish = this.entries[id].dish;
      return { id, i, name: shortName(dish.name), text: dish.steps[i].text.slice(0, 40) };
    });
    const content =
      items.length === 1
        ? `${items[0].name} · 第 ${items[0].i + 1} 步：${items[0].text}`
        : items.map((x) => `${x.name} · 第 ${x.i + 1} 步`).join("\n");
    ui.confirm({ title: "⏰ 时间到了", content, confirmText: "去看看", cancelText: "知道了" }).then((go) => {
      if (go) this.jumpTo(items[0].id, items[0].i);
    });
  },

  // 还有计时在走的时候，点返回会先问一下
  guardLeave(on) {
    if (on === !!this.guarding) return;
    this.guarding = on;
    if (on && wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({ message: "还有计时在走，确定退出吗？进度会留着，回来接着做", fail() {} });
    } else if (!on && wx.disableAlertBeforeUnload) {
      wx.disableAlertBeforeUnload({ fail() {} });
    }
  },

  // ---------- 做好了 ----------

  // 这道做好了，切到下一道；都做好了就开饭
  onDishDone() {
    const id = this.data.tab;
    this.done[id] = true;
    this.pos[id] = this.entries[id].dish.steps.length;
    const next = this.nextDish();
    this.persist();
    if (!next) {
      this.showDish(id);
      this.onServe();
      return;
    }
    this.showDish(next);
    ui.toast(`下一道：${shortName(this.entries[next].dish.name)}`);
  },

  // 点错了：这道还没好
  onDishUndo() {
    delete this.done[this.data.tab];
    this.showDish(this.data.tab);
    this.persist();
  },

  // 开饭：去开饭页把这顿记下来（做好了的默认勾上）。计时和进度都留着，返回还能接着做
  onServe() {
    this.persist();
    wx.navigateTo({ url: "/pages/meal/index?from=cook" });
  },

  // 还没下单：回菜篮
  onGoBasket() {
    wx.switchTab({ url: "/pages/today/index" });
  },
});
