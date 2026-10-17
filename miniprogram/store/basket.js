// 点菜篮：记下今天想做哪些菜、各几份，格式是 { 菜品id: 份数 }，存在手机本地
const STORAGE_KEY = "basket";
const TODAY_TAB_INDEX = 1; // 「今日」是第 2 个 Tab，角标显示在它上面

function getBasket() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || {};
  } catch (e) {
    return {};
  }
}

function getCount(basket) {
  return Object.keys(basket).reduce((sum, id) => sum + basket[id], 0);
}

function save(basket) {
  wx.setStorageSync(STORAGE_KEY, basket);
  updateBadge(basket);
  return basket;
}

function add(id) {
  const basket = getBasket();
  basket[id] = (basket[id] || 0) + 1;
  return save(basket);
}

function remove(id) {
  const basket = getBasket();
  if (basket[id] > 1) {
    basket[id] -= 1;
  } else {
    delete basket[id];
  }
  return save(basket);
}

function clear() {
  return save({});
}

// 刷新「今日」Tab 上的数字角标。
// 只有当前在 Tab 页时才会生效，在详情页调用会静默失败，所以每个 Tab 页的 onShow 里都会再调一次。
function updateBadge(basket) {
  const count = getCount(basket || getBasket());
  if (count > 0) {
    wx.setTabBarBadge({
      index: TODAY_TAB_INDEX,
      text: count > 99 ? "99+" : String(count),
      fail() {},
    });
  } else {
    wx.removeTabBarBadge({ index: TODAY_TAB_INDEX, fail() {} });
  }
}

module.exports = { getBasket, getCount, add, remove, clear, updateBadge };
