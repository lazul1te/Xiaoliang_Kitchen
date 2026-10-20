// 新增 / 编辑菜品：成品照、基本信息、标签、原料（主料/辅料/调料）、分步做法（可配图、可设计时）、小贴士
const dishService = require("../../services/dish");
const bookService = require("../../services/book");
const categoryService = require("../../services/category");
const imageService = require("../../services/image");
const wishService = require("../../services/wish");
const ui = require("../../utils/ui");
const { closeSheet } = require("../../utils/sheet");
const { formatSeconds, splitAmount, parseDuration } = require("../../utils/dish");

const STATUS_OPTIONS = [
  { value: "wish", text: "想学" },
  { value: "learning", text: "练习中" },
  { value: "mastered", text: "拿手菜" },
];
const DIFFICULTY_LABELS = ["", "很简单", "简单", "中等", "有点难", "很难"];
const PRESET_TAGS = ["快手", "下饭", "宴客", "素菜", "清淡", "辣", "早餐"];
const GROUPS = [
  { type: "main", label: "主料", placeholder: "比如：鸡蛋" },
  { type: "side", label: "辅料", placeholder: "比如：葱" },
  { type: "seasoning", label: "调料", placeholder: "比如：盐" },
];
// 计时面板里的常用时长（秒）
const TIMER_PRESETS = [30, 60, 120, 180, 300, 480, 600, 900, 1200, 1800, 2700, 3600].map((value) => ({
  value,
  text: value < 60 ? `${value}秒` : value < 3600 ? `${value / 60}分钟` : `${value / 3600}小时`,
}));

// 列表里每一行要有个不变的 key，删行、调顺序时输入框才不会串
let keySeed = 0;
const nextKey = () => (keySeed += 1);

const unique = (list) => list.filter((x, i) => x && list.indexOf(x) === i);

// 原料一行：名称 + 用量（数字和单位写在一格里，比如「2个」，保存时再拆开）
function emptyIngredient() {
  return { key: nextKey(), name: "", qty: "" };
}

// 表单里的一步，多带两个显示用的字段：计时文字、计时选择器停在哪
function formStep(step) {
  const timer = step.timer || 0;
  return {
    key: step.key || nextKey(),
    text: step.text || "",
    image: step.image || "",
    timer,
    timerText: timer > 0 ? formatSeconds(timer) : "",
  };
}

// 菜品 → 表单
function toForm(dish) {
  return {
    _id: dish._id,
    name: dish.name,
    categoryId: dish.categoryId,
    cover: dish.cover,
    coverThumb: dish.coverThumb,
    status: dish.status,
    difficulty: dish.difficulty,
    duration: dish.duration ? String(dish.duration) : "",
    servings: dish.servings ? String(dish.servings) : "",
    tags: dish.tags.slice(),
    tips: dish.tips,
    groups: GROUPS.map((g) => ({
      type: g.type,
      label: g.label,
      placeholder: g.placeholder,
      items: dish.ingredients
        .filter((i) => i.type === g.type)
        .map((i) => ({ key: nextKey(), name: i.name, qty: `${i.amount}${i.unit}` })),
    })),
    steps: dish.steps.map(formStep),
  };
}

function newForm(categoryId, categories) {
  const valid = categories.some((c) => c._id === categoryId);
  return {
    _id: "",
    name: "",
    categoryId: valid ? categoryId : categories.length ? categories[0]._id : "",
    cover: "",
    coverThumb: "",
    status: "learning",
    difficulty: 2,
    duration: "",
    servings: "2",
    tags: [],
    tips: "",
    groups: GROUPS.map((g) => ({ type: g.type, label: g.label, placeholder: g.placeholder, items: [emptyIngredient()] })),
    steps: [formStep({})],
  };
}

// 表单 → 菜品。空行、多余的空格由 services 统一整理
function fromForm(form) {
  const ingredients = [];
  form.groups.forEach((group) => {
    group.items.forEach((item) => {
      const { amount, unit } = splitAmount(item.qty);
      ingredients.push({ name: item.name, amount, unit, type: group.type });
    });
  });
  return {
    _id: form._id,
    name: form.name,
    categoryId: form.categoryId,
    cover: form.cover,
    coverThumb: form.coverThumb,
    status: form.status,
    difficulty: form.difficulty,
    duration: form.duration,
    servings: form.servings,
    tags: form.tags,
    tips: form.tips,
    ingredients,
    steps: form.steps.map((s) => ({ text: s.text, image: s.image, timer: s.timer })),
  };
}

Page({
  data: {
    form: null,
    isEdit: false,
    categories: [], // [{ _id, name }]，点一下选上
    statusOptions: STATUS_OPTIONS,
    stars: [1, 2, 3, 4, 5],
    difficultyLabels: DIFFICULTY_LABELS,
    tagChips: [], // [{ name, on }]
    timerPresets: TIMER_PRESETS,
    timerStep: -1, // 正在给第几步选计时，-1 表示没打开
    timerClosing: false, // 选计时的面板正在收起来（播动画）
    timerCurrent: 0,
  },

  async onLoad(options) {
    let categories;
    let dishes;
    try {
      [categories, dishes] = await Promise.all([categoryService.listCategories(), dishService.listDishes()]);
    } catch (err) {
      await ui.alert("没读到数据", ui.errorText(err));
      wx.navigateBack();
      return;
    }
    const dish = options.id ? dishes.find((d) => d._id === options.id) : null;
    if (options.id && !dish) {
      await ui.alert("这道菜找不到了", "可能已经被删掉了");
      wx.navigateBack();
      return;
    }
    this.categories = categories;
    // 打开时这道菜的修改时间：保存时拿它判断这期间对方有没有改过
    this.baseUpdatedAt = dish ? dish.updatedAt : undefined;
    // 用来提醒「已经有一道同名的菜」
    this.otherNames = dishes.filter((d) => !dish || d._id !== dish._id).map((d) => d.name);
    // 标签选项：常用标签 + 其他菜用过的标签
    this.tagNames = unique(PRESET_TAGS.concat(...dishes.map((d) => d.tags)));
    wx.setNavigationBarTitle({ title: dish ? "编辑菜谱" : "新增菜品" });
    const form = dish ? toForm(dish) : newForm(options.categoryId, categories);
    // 从想吃清单「开始学」：带上菜名、照片和备注，熟练度先标「想学」；存好以后从清单里拿掉
    const wish = !dish && options.wish ? wishService.get(options.wish) : null;
    if (wish) {
      this.wishKey = wish.key;
      this.wishPhoto = wish.photo;
      Object.assign(form, { name: wish.name, cover: wish.photo, coverThumb: wish.photoThumb, tips: wish.note, status: "wish" });
    }
    this.setData({ form, isEdit: !!dish });
    this.refreshCategory();
    this.refreshTags();
  },

  // ---------- 没保存就离开时提醒一下 ----------

  markDirty() {
    if (this.dirty) return;
    this.dirty = true;
    if (wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: "改动还没保存，确定要离开吗？" });
  },

  // 保存或删除成功后离开：先关掉提醒，再跳转
  leave(go) {
    const wasDirty = this.dirty;
    this.dirty = false;
    if (wasDirty && wx.disableAlertBeforeUnload) {
      wx.disableAlertBeforeUnload({ complete: () => go() });
    } else {
      go();
    }
  },

  // ---------- 成品照 ----------

  async onChooseCover() {
    const path = await imageService.choose();
    if (!path) return;
    this.setData({ "form.cover": path });
    this.markDirty();
  },

  onRemoveCover() {
    this.setData({ "form.cover": "" });
    this.markDirty();
  },

  // ---------- 基本信息 ----------

  // 菜名、耗时、份量、小贴士共用：data-field 写的是 form 里的字段名
  onInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
    this.markDirty();
  },

  refreshCategory() {
    this.setData({ categories: this.categories.map((c) => ({ _id: c._id, name: c.name })) });
  },

  onCategoryTap(e) {
    this.setData({ "form.categoryId": e.currentTarget.dataset.id });
    this.markDirty();
  },

  onNewCategory() {
    return this.createCategory();
  },

  async createCategory() {
    const name = await ui.prompt({ title: "新建分类", placeholder: "比如：早餐" });
    if (name === null) {
      this.refreshCategory();
      return;
    }
    wx.showLoading({ title: "正在新建", mask: true });
    try {
      const category = await categoryService.addCategory(name);
      this.categories = await categoryService.listCategories();
      wx.hideLoading();
      this.setData({ "form.categoryId": category._id });
      this.markDirty();
    } catch (err) {
      wx.hideLoading();
      ui.toast(ui.errorText(err));
    }
    this.refreshCategory();
  },

  onStatusTap(e) {
    this.setData({ "form.status": e.currentTarget.dataset.value });
    this.markDirty();
  },

  onStarTap(e) {
    this.setData({ "form.difficulty": e.currentTarget.dataset.value });
    this.markDirty();
  },

  // ---------- 标签 ----------

  refreshTags() {
    const tags = this.data.form.tags;
    this.setData({ tagChips: this.tagNames.map((name) => ({ name, on: tags.indexOf(name) >= 0 })) });
  },

  onTagTap(e) {
    const tag = e.currentTarget.dataset.tag;
    const tags = this.data.form.tags.slice();
    const i = tags.indexOf(tag);
    if (i >= 0) tags.splice(i, 1);
    else tags.push(tag);
    this.setData({ "form.tags": tags });
    this.refreshTags();
    this.markDirty();
  },

  async onAddTag() {
    const tag = await ui.prompt({ title: "自定义标签", placeholder: "比如：孩子爱吃" });
    if (!tag) return;
    if (tag.length > 6) {
      ui.toast("标签最多 6 个字");
      return;
    }
    if (this.tagNames.indexOf(tag) < 0) this.tagNames.push(tag);
    if (this.data.form.tags.indexOf(tag) < 0) this.setData({ "form.tags": this.data.form.tags.concat(tag) });
    this.refreshTags();
    this.markDirty();
  },

  // ---------- 原料 ----------

  onIngInput(e) {
    const { g, i, field } = e.currentTarget.dataset;
    this.setData({ [`form.groups[${g}].items[${i}].${field}`]: e.detail.value });
    this.markDirty();
  },

  onAddIng(e) {
    const g = e.currentTarget.dataset.g;
    this.setData({ [`form.groups[${g}].items`]: this.data.form.groups[g].items.concat(emptyIngredient()) });
  },

  onRemoveIng(e) {
    const { g, i } = e.currentTarget.dataset;
    const items = this.data.form.groups[g].items.slice();
    items.splice(i, 1);
    this.setData({ [`form.groups[${g}].items`]: items });
    this.markDirty();
  },

  // ---------- 做法 ----------

  onStepInput(e) {
    this.setData({ [`form.steps[${e.currentTarget.dataset.i}].text`]: e.detail.value });
    this.markDirty();
  },

  onAddStep() {
    this.setData({ "form.steps": this.data.form.steps.concat(formStep({})) });
  },

  async onRemoveStep(e) {
    const i = e.currentTarget.dataset.i;
    const step = this.data.form.steps[i];
    if (step.text.trim() || step.image) {
      const ok = await ui.confirm({ title: `删除第 ${i + 1} 步？`, confirmText: "删除", danger: true });
      if (!ok) return;
    }
    const steps = this.data.form.steps.slice();
    steps.splice(i, 1);
    this.setData({ "form.steps": steps });
    this.markDirty();
  },

  // data-dir：-1 上移，1 下移
  onMoveStep(e) {
    const { i, dir } = e.currentTarget.dataset;
    const j = i + dir;
    const steps = this.data.form.steps.slice();
    if (j < 0 || j >= steps.length) return;
    const moved = steps[i];
    steps[i] = steps[j];
    steps[j] = moved;
    this.setData({ "form.steps": steps });
    this.markDirty();
  },

  async onStepImage(e) {
    const i = e.currentTarget.dataset.i;
    const path = await imageService.choose();
    if (!path) return;
    this.setData({ [`form.steps[${i}].image`]: path });
    this.markDirty();
  },

  onRemoveStepImage(e) {
    this.setData({ [`form.steps[${e.currentTarget.dataset.i}].image`]: "" });
    this.markDirty();
  },

  setStepTimer(i, timer) {
    const step = Object.assign({}, this.data.form.steps[i], { timer });
    this.setData({ [`form.steps[${i}]`]: formStep(step) });
    this.markDirty();
  },

  onClearTimer(e) {
    this.setStepTimer(e.currentTarget.dataset.i, 0);
  },

  // 计时面板：常用时长点一下；别的时长写「25分钟」「1分30秒」
  onOpenTimer(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ timerStep: i, timerCurrent: this.data.form.steps[i].timer });
  },

  onCloseTimer() {
    closeSheet(this, "timerClosing", () => this.setData({ timerStep: -1 }));
  },

  onPickTimer(e) {
    this.setStepTimer(this.data.timerStep, Number(e.currentTarget.dataset.value));
    this.onCloseTimer();
  },

  async onCustomTimer() {
    const i = this.data.timerStep;
    const text = await ui.prompt({ title: "计时多久", placeholder: "比如：25分钟、1分30秒、90秒" });
    if (text === null) return;
    const seconds = parseDuration(text);
    if (seconds <= 0 || seconds > 6 * 3600) {
      ui.toast("没看懂，写成「25分钟」「1分30秒」这样");
      return;
    }
    this.setStepTimer(i, seconds);
    this.onCloseTimer();
  },

  onNoTimer() {
    this.setStepTimer(this.data.timerStep, 0);
    this.onCloseTimer();
  },

  noop() {},

  // ---------- 保存 / 删除 ----------

  async onSave() {
    if (this.saving) return;
    const form = this.data.form;
    const name = form.name.trim();
    if (!name) {
      ui.toast("先给这道菜起个名字");
      return;
    }
    if (!form.categoryId) {
      ui.toast("选一个分类");
      return;
    }
    if (this.otherNames.indexOf(name) >= 0) {
      const ok = await ui.confirm({
        title: `已经有一道「${name}」了`,
        content: "还要再存一道同名的菜吗？",
        confirmText: "保存",
      });
      if (!ok) return;
    }
    this.saving = true;
    let dish = await this.submit({ baseUpdatedAt: this.baseUpdatedAt });
    if (dish === "CONFLICT") {
      const ok = await ui.confirm({
        title: "这道菜刚被改过",
        content: bookService.isShared()
          ? "可能是家人刚刚也改了这道菜。要用你现在填的内容覆盖吗？"
          : "可能在另一台手机上改过这道菜。要用你现在填的内容覆盖吗？",
        confirmText: "覆盖",
        danger: true,
      });
      dish = ok ? await this.submit({ force: true }) : null;
    }
    this.saving = false;
    if (!dish) return;
    // 照片菜谱接着用的话就别删；换掉了才删
    if (this.wishKey) wishService.remove(this.wishKey, { keepPhoto: !!this.wishPhoto && dish.cover === this.wishPhoto });
    const done = () => ui.toast("已保存");
    this.leave(() => {
      if (this.data.isEdit) wx.navigateBack({ success: done });
      else wx.redirectTo({ url: `/pages/dish-detail/index?id=${dish._id}`, success: done });
    });
  },

  // 提交到云上：成功返回菜品；别人刚改过返回 "CONFLICT"；其他失败弹窗说明，返回 null
  async submit(options) {
    wx.showLoading({ title: "保存中", mask: true });
    try {
      const dish = await dishService.saveDish(fromForm(this.data.form), options);
      wx.hideLoading();
      return dish;
    } catch (err) {
      wx.hideLoading();
      if (err.code === "CONFLICT") return "CONFLICT";
      ui.alert("保存失败", ui.errorText(err));
      return null;
    }
  },

  async onDelete() {
    const ok = await ui.confirm({
      title: `删除「${this.data.form.name}」？`,
      content: bookService.isShared() ? "删除后这本里大家的菜单里都没有了，照片也会一起删掉，找不回来。" : "删除后照片也会一起删掉，找不回来。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    wx.showLoading({ title: "删除中", mask: true });
    try {
      await dishService.removeDish(this.data.form._id);
    } catch (err) {
      wx.hideLoading();
      ui.alert("删除失败", ui.errorText(err));
      return;
    }
    wx.hideLoading();
    // 从详情页进来的，详情页也一起退掉
    const pages = getCurrentPages();
    const prev = pages[pages.length - 2];
    const delta = prev && prev.route === "pages/dish-detail/index" ? 2 : 1;
    this.leave(() => wx.navigateBack({ delta, success: () => ui.toast("已删除") }));
  },
});
