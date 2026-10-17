// 分类和菜品的数据读取都放在这里，页面不直接碰数据源。
// 现在（M1）读的是 mock/data.js 里的假数据；M2 改成云数据库时只改这个文件，页面代码不用动。
const mock = require("../mock/data");

// 每次返回一份拷贝，免得页面改了数据把假数据本身也改掉
const clone = (data) => JSON.parse(JSON.stringify(data));

function listCategories() {
  const list = mock.categories.slice().sort((a, b) => a.sort - b.sort);
  return Promise.resolve(clone(list));
}

function listDishes() {
  return Promise.resolve(clone(mock.dishes));
}

function getDish(id) {
  const dish = mock.dishes.find((d) => d._id === id);
  return Promise.resolve(dish ? clone(dish) : null);
}

module.exports = { listCategories, listDishes, getDish };
