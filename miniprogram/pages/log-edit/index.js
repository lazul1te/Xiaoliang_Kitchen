// 打卡：记一次做菜（成品照、哪天做的、好吃程度、心得、谁掌勺）。也用来修改、删除已有的记录
const dishService = require("../../services/dish");
const logService = require("../../services/log");
const planService = require("../../services/plan");
const imageService = require("../../services/image");
const ui = require("../../utils/ui");
const { dateValue, dateToTime } = require("../../utils/log");

Page({
  data: {
    form: null, // { _id, dishId, date, photo, rating, note, cook }
    isEdit: false,
    dishLocked: false, // 从某道菜进来的，不用再选菜
    dishNames: [],
    dishIndex: 0,
    dishName: "",
    today: "",
    stars: [1, 2, 3, 4, 5],
    ratingLabels: ["点星星打个分", "不太行", "一般", "还不错", "好吃", "超好吃"],
    showCoverOption: false, // 「用这张照片当这道菜的成品照」
    useAsCover: false,
    showPlanOption: false, // 「从菜篮里拿掉这道菜」
    removeFromPlan: false,
  },

  async onLoad(options) {
    let log = null;
    try {
      this.dishes = await dishService.listDishes();
      if (options.id) log = await logService.getLog(options.id);
    } catch (err) {
      await ui.alert("没读到数据", ui.errorText(err));
      wx.navigateBack();
      return;
    }
    if (options.id && !log) {
      await ui.alert("这条记录找不到了", "可能已经被删掉了");
      wx.navigateBack();
      return;
    }
    const form = log
      ? { _id: log._id, dishId: log.dishId, date: dateValue(log.cookedAt), photo: log.photo, rating: log.rating, note: log.note, cook: log.cook }
      : { _id: "", dishId: options.dishId || "", date: this.startDate(options.date), photo: "", rating: 0, note: "", cook: logService.getCookName() };
    // 修改记录时日期没动，就保留原来的时间
    this.originalDate = form.date;
    this.originalCookedAt = log ? log.cookedAt : 0;
    wx.setNavigationBarTitle({ title: log ? "修改记录" : "打卡" });
    this.setData({
      form,
      isEdit: !!log,
      dishLocked: !log && !!options.dishId,
      today: dateValue(Date.now()),
    });
    this.refreshDish();
  },

  // 从日历上点某一天来补记的，日期就用那天（不能晚于今天）
  startDate(date) {
    const today = dateValue(Date.now());
    return /^\d{4}-\d{2}-\d{2}$/.test(date || "") && date <= today ? date : today;
  },

  refreshDish() {
    const index = this.dishes.findIndex((d) => d._id === this.data.form.dishId);
    const dish = this.dishes[index];
    const inPlan = !this.data.isEdit && !!dish && !!planService.getBasket()[dish._id];
    this.setData({
      dishNames: this.dishes.map((d) => d.name),
      dishIndex: Math.max(0, index),
      dishName: dish ? dish.name : this.data.form.dishId ? "这道菜已经删掉了" : "",
      showPlanOption: inPlan,
      removeFromPlan: inPlan,
    });
    this.refreshCoverOption();
  },

  // 新拍的照片才能顺便当菜的成品照；这道菜还没有成品照时默认勾上
  refreshCoverOption() {
    const dish = this.dishes.find((d) => d._id === this.data.form.dishId);
    const photo = this.data.form.photo;
    const show = !!dish && !!photo && !imageService.isCloudFile(photo);
    this.setData({ showCoverOption: show, useAsCover: show && !dish.cover });
  },

  // ---------- 没保存就离开时提醒一下 ----------

  markDirty() {
    if (this.dirty) return;
    this.dirty = true;
    if (wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: "还没保存，确定要离开吗？", fail() {} });
  },

  leave(go) {
    const wasDirty = this.dirty;
    this.dirty = false;
    if (wasDirty && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload({ complete: () => go() });
    else go();
  },

  // ---------- 表单 ----------

  onDishChange(e) {
    const dish = this.dishes[Number(e.detail.value)];
    if (!dish) return;
    this.setData({ "form.dishId": dish._id });
    this.refreshDish();
    this.markDirty();
  },

  onDateChange(e) {
    this.setData({ "form.date": e.detail.value });
    this.markDirty();
  },

  async onChoosePhoto() {
    const path = await imageService.choose();
    if (!path) return;
    this.setData({ "form.photo": path });
    this.refreshCoverOption();
    this.markDirty();
  },

  onRemovePhoto() {
    this.setData({ "form.photo": "" });
    this.refreshCoverOption();
    this.markDirty();
  },

  // 再点一下同一颗星，就是不打分
  onStarTap(e) {
    const value = e.currentTarget.dataset.value;
    this.setData({ "form.rating": this.data.form.rating === value ? 0 : value });
    this.markDirty();
  },

  // 心得、掌勺共用：data-field 写的是 form 里的字段名
  onInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
    this.markDirty();
  },

  onToggleCover() {
    this.setData({ useAsCover: !this.data.useAsCover });
  },

  onTogglePlan() {
    this.setData({ removeFromPlan: !this.data.removeFromPlan });
  },

  // ---------- 保存 / 删除 ----------

  async onSave() {
    if (this.saving) return;
    const f = this.data.form;
    if (!f.dishId) {
      ui.toast("选一道菜");
      return;
    }
    this.saving = true;
    wx.showLoading({ title: "保存中", mask: true });
    let count = 0;
    try {
      const cookedAt = this.data.isEdit && f.date === this.originalDate ? this.originalCookedAt : dateToTime(f.date);
      const log = await logService.saveLog(
        { _id: f._id, dishId: f.dishId, cookedAt, photo: f.photo, rating: f.rating, note: f.note, cook: f.cook },
        {
          useAsCover: this.data.showCoverOption && this.data.useAsCover,
          removeFromPlan: this.data.showPlanOption && this.data.removeFromPlan,
        }
      );
      const dish = await dishService.getDish(log.dishId);
      count = dish ? dish.cookCount : 0;
      wx.hideLoading();
    } catch (err) {
      wx.hideLoading();
      this.saving = false;
      ui.alert("保存失败", ui.errorText(err));
      return;
    }
    const message = this.data.isEdit ? "已保存" : count ? `打卡成功！做过 ${count} 次了` : "打卡成功！";
    this.leave(() => wx.navigateBack({ success: () => ui.toast(message) }));
  },

  async onDelete() {
    const ok = await ui.confirm({
      title: "删除这条记录？",
      content: "这道菜的「做过几次」会减 1，照片也会一起删掉。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    wx.showLoading({ title: "删除中", mask: true });
    try {
      await logService.removeLog(this.data.form._id);
    } catch (err) {
      wx.hideLoading();
      ui.alert("删除失败", ui.errorText(err));
      return;
    }
    wx.hideLoading();
    this.leave(() => wx.navigateBack({ success: () => ui.toast("已删除") }));
  },
});
