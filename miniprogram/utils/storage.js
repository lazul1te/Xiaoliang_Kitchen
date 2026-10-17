// 手机本地缓存（wx.setStorage）的读写，统一走这里。现在存两样：点菜篮、云上数据的缓存。
// 开发版（开发者工具里、扫预览码打开的）用 dev_ 开头的 key，跟体验版各存各的。
let prefix = null;

function getPrefix() {
  if (prefix === null) {
    let envVersion = "release";
    try {
      envVersion = wx.getAccountInfoSync().miniProgram.envVersion;
    } catch (e) {}
    prefix = envVersion === "develop" ? "dev_" : "";
  }
  return prefix;
}

// 读不到时返回 undefined（wx.getStorageSync 读不到会返回空字符串）
function get(key) {
  try {
    const value = wx.getStorageSync(getPrefix() + key);
    return value === "" ? undefined : value;
  } catch (e) {
    return undefined;
  }
}

// 写失败（比如超过 10MB 上限）会抛错，由调用的地方处理
function set(key, value) {
  wx.setStorageSync(getPrefix() + key, value);
}

function remove(key) {
  try {
    wx.removeStorageSync(getPrefix() + key);
  } catch (e) {}
}

module.exports = { get, set, remove };
