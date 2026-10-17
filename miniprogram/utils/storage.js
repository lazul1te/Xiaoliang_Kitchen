// 本地缓存（wx.setStorage）和本地文件夹的读写，统一走这里。
// 开发版（开发者工具里、扫预览码打开的）用 dev_ 开头的 key 和文件夹，
// 跟体验版里真正记下的菜谱分开，测试时怎么折腾都碰不到正式数据。
let prefix = null;
const readyDirs = {};

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

// 一次读多个 key，比一个一个读快
function getMany(keys) {
  if (!keys.length) return [];
  if (wx.batchGetStorageSync) {
    try {
      return wx
        .batchGetStorageSync(keys.map((k) => getPrefix() + k))
        .map((v) => (v === "" || v === null ? undefined : v));
    } catch (e) {}
  }
  return keys.map(get);
}

// entries: [{ key, value }]。写失败（比如超过 10MB 上限）会抛错，由调用的地方处理
function setMany(entries) {
  const list = entries.map((e) => ({ key: getPrefix() + e.key, value: e.value }));
  if (wx.batchSetStorageSync) {
    wx.batchSetStorageSync(list);
  } else {
    list.forEach((e) => wx.setStorageSync(e.key, e.value));
  }
}

function set(key, value) {
  setMany([{ key, value }]);
}

function remove(key) {
  try {
    wx.removeStorageSync(getPrefix() + key);
  } catch (e) {}
}

// 小程序自己的文件夹（放照片、备份文件），没有就建一个，返回完整路径
function fileDir(name) {
  const dir = `${wx.env.USER_DATA_PATH}/${getPrefix()}${name}`;
  if (!readyDirs[dir]) {
    const fs = wx.getFileSystemManager();
    try {
      fs.accessSync(dir);
    } catch (e) {
      fs.mkdirSync(dir, true);
    }
    readyDirs[dir] = true;
  }
  return dir;
}

module.exports = { get, getMany, set, setMany, remove, fileDir };
