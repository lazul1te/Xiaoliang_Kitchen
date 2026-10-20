// 库存：家里常备的东西（调料、米面、干货……）。买菜清单会自动对比，家里有的就不提醒买了。
// 这本小本本里的人共用：谁发现用完了，点一下「用完了」，下次买菜清单里就会出现
const dishService = require("../../services/dish");
const pantryService = require("../../services/pantry");
const ui = require("../../utils/ui");

Page({
  data: {
    inStock: [], // [{ key, name }]
    outOfStock: [],
    presets: [], // 还没加的常用调料
    input: "",
  },

  onShow() {
    this.refresh();
    dishService.refreshIfStale().then((changed) => {
      if (changed) this.refresh();
    });
  },

  refresh() {
    const { inStock, outOfStock } = pantryService.list();
    const have = {};
    inStock.concat(outOfStock).forEach((i) => {
      have[i.name] = true;
    });
    this.setData({ inStock, outOfStock, presets: pantryService.COMMON_SEASONINGS.filter((n) => !have[n]) });
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  // 可以一次写好几样，用空格或逗号隔开
  onAdd() {
    const names = this.data.input.split(/[，,、；;\s]+/).filter(Boolean);
    if (!names.length) {
      ui.toast("写个名字，比如：生抽");
      return;
    }
    const n = pantryService.add(names);
    this.setData({ input: "" });
    ui.toast(n ? `加了 ${n} 样` : "已经都有了");
    this.refresh();
  },

  onAddPreset(e) {
    pantryService.add(e.currentTarget.dataset.name);
    this.refresh();
  },

  onAddAllPresets() {
    const n = pantryService.add(this.data.presets);
    ui.toast(`加了 ${n} 样常用调料`);
    this.refresh();
  },

  onRanOut(e) {
    pantryService.setInStock(e.currentTarget.dataset.key, false);
    this.refresh();
  },

  onRestock(e) {
    pantryService.setInStock(e.currentTarget.dataset.key, true);
    this.refresh();
  },

  async onRemove(e) {
    const { key, name } = e.currentTarget.dataset;
    const ok = await ui.confirm({ title: `从库存里删掉「${name}」？`, content: "删掉以后，买菜清单又会提醒买它。", confirmText: "删掉" });
    if (!ok) return;
    pantryService.remove(key);
    this.refresh();
  },
});
