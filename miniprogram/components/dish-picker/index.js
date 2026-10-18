// 选一道菜：从底部弹出的面板。最上面是菜篮里的、最近做过的，下面按分类排；也可以搜菜名、原料、标签。
// 菜多了以后比滚轮好找。用法：
//   <dish-picker show="{{showDishPicker}}" selected="{{dishId}}" bind:select="onDishPicked" bind:close="onCloseDishPicker" />
// select 事件的 detail 是 { id, name }
const dishService = require("../../services/dish");
const categoryService = require("../../services/category");
const logService = require("../../services/log");
const planService = require("../../services/plan");
const { matchKeyword } = require("../../utils/dish");

const RECENT = 5; // 「最近做过」最多几道
const UNCATEGORIZED = "未分类";

Component({
  options: {
    styleIsolation: "apply-shared", // 用 app.wxss 里的面板、选项样式
  },

  properties: {
    show: { type: Boolean, value: false },
    selected: { type: String, value: "" },
  },

  data: {
    keyword: "",
    sections: [], // [{ key, title, items: [{ _id, name }] }]
    results: [],
  },

  observers: {
    show(show) {
      if (show) this.load();
    },
  },

  methods: {
    async load() {
      let dishes = [];
      let categories = [];
      let logs = [];
      try {
        [dishes, categories, logs] = await Promise.all([
          dishService.listDishes(),
          categoryService.listCategories(),
          logService.listLogs().catch(() => []),
        ]);
      } catch (err) {
        // 读不到就显示空的，页面上会提示
      }
      this.dishes = dishes;
      const row = (d) => ({ _id: d._id, name: d.name });
      const byId = {};
      dishes.forEach((d) => {
        byId[d._id] = d;
      });
      const sections = [];
      const basket = planService.getBasket();
      const inBasket = dishes.filter((d) => basket[d._id]);
      if (inBasket.length) sections.push({ key: "basket", title: "菜篮里的", items: inBasket.map(row) });
      const recent = [];
      logs.forEach((l) => {
        if (byId[l.dishId] && recent.indexOf(l.dishId) < 0 && !basket[l.dishId]) recent.push(l.dishId);
      });
      if (recent.length) sections.push({ key: "recent", title: "最近做过", items: recent.slice(0, RECENT).map((id) => row(byId[id])) });
      const known = {};
      categories.forEach((c) => {
        known[c._id] = true;
        const items = dishes.filter((d) => d.categoryId === c._id);
        if (items.length) sections.push({ key: c._id, title: c.name, items: items.map(row) });
      });
      const others = dishes.filter((d) => !known[d.categoryId]);
      if (others.length) sections.push({ key: "others", title: UNCATEGORIZED, items: others.map(row) });
      this.setData({ keyword: "", results: [], sections });
    },

    onInput(e) {
      const keyword = e.detail.value.trim();
      const results = keyword ? (this.dishes || []).filter((d) => matchKeyword(d, keyword)).map((d) => ({ _id: d._id, name: d.name })) : [];
      this.setData({ keyword, results });
    },

    onClear() {
      this.setData({ keyword: "", results: [] });
    },

    onPick(e) {
      const { id, name } = e.currentTarget.dataset;
      this.triggerEvent("select", { id, name });
    },

    onClose() {
      this.triggerEvent("close");
    },

    noop() {},
  },
});
