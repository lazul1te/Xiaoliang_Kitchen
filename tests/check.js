// 测试：npm test（或 node tests/check.js），不用装依赖，要 Node.js 20 以上
// 1) 静态检查：app.json/页面文件/Tab 图标、WXML 标签配对、事件处理函数是否存在、WXSS 括号和 CSS 变量
// 2) 冒烟测试：用假的 wx / wx.cloud（内存里的云数据库）/ Page 把各页面的流程跑一遍。
//    模拟两台手机（我、对方）共用一个云数据库，以及几种集合权限设错的情况。
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(process.argv[2] || path.join(__dirname, "..", "miniprogram"));
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log("FAIL", msg);
};
const ok = (msg) => console.log("ok  ", msg);
const rel = (f) => path.relative(root, f);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
// 从底部弹出的面板收起时先播 0.18 秒的动画（utils/sheet.js），播完才真的关掉
const sheetClosed = () => new Promise((r) => setTimeout(r, 220));
// 照片组件会把同一屏的照片攒一小会儿再一起换链接（setTimeout），要等它跑完
const settle = async () => {
  await flush();
  await new Promise((r) => setTimeout(r, 40));
  await flush();
};

// 可以快进的时钟（测试「隔一会儿回来就同步」）
let timeOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + timeOffset;

// ---------------- 假的云开发 ----------------
// 小程序现在都通过云函数 api 读写数据库（云函数是管理员身份，不受集合权限限制）。
// 小程序自己直接读数据库，只剩「检查一下云开发」用来看权限收紧了没有。permission 模拟集合权限：
//   shared  自定义安全规则「能打开小程序的人都能读写」（旧版本用的，大家都换成新版本以前不能改）
//   locked  所有用户不可读写（大家都换成新版本以后改成这个）
let permission = "shared";
let currentUser = "me"; // 当前是哪台手机
const devices = { me: {}, partner: {}, third: {} }; // 每台手机自己的本地缓存
const dev = () => devices[currentUser];
const cloudDB = {}; // 集合名 → 记录数组；没有这个 key = 集合不存在
const cloudFiles = {}; // fileID → { owner, path, content }
let idSeq = 0;
let offline = false;
let cloudInits = 0;

function cloudError(msg, errCode) {
  const e = new Error(msg);
  e.errMsg = msg;
  if (errCode) e.errCode = errCode;
  return e;
}
const permissionDenied = () => cloudError("collection.get:fail -502003 database permission denied", -502003);
const collectionMissing = (name) =>
  cloudError(`collection.count:fail -502005 database collection not exists. [ResourceNotFound] Db or Table not exist: ${name}`, -502005);

// 记录里的一个字段，支持 "members.xxx" 这种点路径
const getPath = (row, pathStr) => pathStr.split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), row);

// 查询条件：字段等于某个值（数组字段是包含这个值）、_.exists(true/false)、_.or([条件, ...])
function matches(row, cond) {
  if (!cond) return true;
  if (cond.__op === "or") return cond.value.some((c) => matches(row, c));
  return Object.keys(cond).every((k) => {
    const want = cond[k];
    const v = getPath(row, k);
    if (want && want.__op === "exists") return want.value ? v !== undefined : v === undefined;
    if (want && typeof want === "object") throw new Error(`假数据库不认识的查询条件：${JSON.stringify(want)}`);
    return Array.isArray(v) ? v.includes(want) : v === want;
  });
}

function sortRows(list, orders) {
  return list.slice().sort((a, b) => {
    for (const [f, d] of orders) {
      if (a[f] < b[f]) return d === "asc" ? -1 : 1;
      if (a[f] > b[f]) return d === "asc" ? 1 : -1;
    }
    return 0;
  });
}

// update 的一个字段：支持 "items.abc" 这种点路径，以及 _.set / _.inc / _.remove
function applyUpdate(row, pathStr, v) {
  const keys = pathStr.split(".");
  let cur = row;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (v && v.__op === "set") cur[last] = clone(v.value);
  else if (v && v.__op === "inc") cur[last] = (cur[last] || 0) + v.value;
  else if (v && v.__op === "remove") delete cur[last];
  else if (v && typeof v === "object") cur[last] = Object.assign(cur[last] || {}, clone(v)); // 普通对象按字段合并
  else cur[last] = clone(v);
}

function applyData(row, data) {
  Object.keys(data).forEach((k) => {
    const v = data[k];
    if (k === "_id" || k === "_openid") throw new Error("update() 不能改 _id / _openid");
    if (Array.isArray(v)) throw new Error(`update() 的数组字段 ${k} 要用 _.set() 包起来`);
    applyUpdate(row, k, v);
  });
}

// ---- 小程序端直接读数据库：只有「检查一下云开发」用，看权限收紧了没有 ----
function clientCollection(name) {
  const q = {
    limit: () => q,
    get: async () => {
      if (!cloudInits) throw new Error("请先调用 wx.cloud.init() 完成初始化后再调用其他云 API");
      if (offline) throw cloudError("request:fail timeout");
      if (!cloudDB[name]) throw collectionMissing(name);
      if (permission === "locked") throw permissionDenied();
      return { data: clone(cloudDB[name].slice(0, 20)) };
    },
  };
  return q;
}

// ---- 云函数端（管理员身份）：读写不受集合权限限制，add 不会自动加 _openid，一次最多读 1000 条 ----
let serverCanCreate = true; // 云函数能不能自己建集合（db.createCollection）
function serverRows(name) {
  if (!cloudDB[name]) throw collectionMissing(name);
  return cloudDB[name];
}

function serverQuery(name, opts) {
  const next = (patch) => serverQuery(name, Object.assign({}, opts, patch));
  const found = () => sortRows(serverRows(name).filter((r) => matches(r, opts.where)), opts.orders);
  return {
    where: (cond) => next({ where: cond }),
    field: (f) => next({ field: f }),
    orderBy: (f, d) => next({ orders: opts.orders.concat([[f, d]]) }),
    skip: (n) => next({ skip: n }),
    limit: (n) => next({ limit: Math.min(n, 1000) }),
    get: async () => {
      let list = found().slice(opts.skip, opts.skip + opts.limit);
      if (opts.field) {
        list = list.map((r) => {
          const o = { _id: r._id };
          Object.keys(opts.field).forEach((k) => {
            if (opts.field[k] && k in r) o[k] = r[k];
          });
          return o;
        });
      }
      return { data: clone(list) };
    },
    count: async () => ({ total: found().length }),
    update: async ({ data }) => {
      const list = found();
      list.forEach((r) => applyData(r, data));
      return { stats: { updated: list.length } };
    },
    remove: async () => {
      const rows = serverRows(name);
      const list = found();
      list.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return { stats: { removed: list.length } };
    },
  };
}

function serverCollection(name) {
  const findRow = (id) => serverRows(name).find((r) => r._id === id);
  return Object.assign(serverQuery(name, { skip: 0, limit: 100, orders: [] }), {
    add: async ({ data }) => {
      if ("_openid" in data) throw new Error("云函数 add() 的 data 里不该有 _openid");
      if ("_id" in data && !data._id) throw new Error("add() 的 _id 不能是空的");
      const rows = serverRows(name);
      if (data._id && rows.some((r) => r._id === data._id)) {
        throw cloudError("collection.add:fail -502001 database request fail. E11000 duplicate key error, dup key: { _id }");
      }
      const _id = data._id || `id${++idSeq}`;
      rows.push(Object.assign(clone(data), { _id }));
      return { _id };
    },
    doc: (id) => ({
      update: async ({ data }) => {
        const row = findRow(id);
        if (!row) return { stats: { updated: 0 } };
        applyData(row, data);
        return { stats: { updated: 1 } };
      },
      remove: async () => {
        const rows = serverRows(name);
        const row = findRow(id);
        if (!row) return { stats: { removed: 0 } };
        rows.splice(rows.indexOf(row), 1);
        return { stats: { removed: 1 } };
      },
    }),
  });
}

// ---------------- 假的 wx、Page、App ----------------
const calls = [];
const modalAnswers = []; // 依次弹出的 showModal 怎么回答：{ confirm, content }
const sheetAnswers = []; // 依次弹出的 showActionSheet 点第几个（没有就是取消）
let chooseCount = 0;
let chooseMediaFail = null;
let pageStack = [];

global.wx = {
  cloud: {
    init: (opts) => {
      cloudInits++;
      calls.push(["cloud.init", opts]);
    },
    database: () => {
      if (!cloudInits) throw new Error("请先调用 wx.cloud.init()");
      return { collection: clientCollection };
    },
    uploadFile: async ({ cloudPath, filePath }) => {
      if (!cloudInits) throw new Error("请先调用 wx.cloud.init()");
      if (!filePath || /^cloud:/.test(filePath)) throw new Error(`uploadFile 收到了不对的路径 ${filePath}`);
      const fileID = `cloud://test-env.1234/${cloudPath}`;
      cloudFiles[fileID] = { owner: currentUser, path: filePath };
      return { fileID };
    },
    // 云存储默认权限：所有人可读、只有上传的人能删
    deleteFile: async ({ fileList }) => ({
      fileList: fileList.map((f) => {
        if (cloudFiles[f] && cloudFiles[f].owner === currentUser) {
          delete cloudFiles[f];
          return { fileID: f, status: 0 };
        }
        return { fileID: f, status: -1 };
      }),
    }),
  },
  getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
  getStorageSync: (k) => (k in dev() ? clone(dev()[k]) : ""),
  setStorageSync: (k, v) => {
    dev()[k] = clone(v);
  },
  removeStorageSync: (k) => {
    delete dev()[k];
  },
  setTabBarBadge: (o) => calls.push(["badge", o.text]),
  removeTabBarBadge: () => calls.push(["badge", null]),
  showTabBarRedDot: (o) => calls.push(["redDot", o.index, true]),
  hideTabBarRedDot: (o) => calls.push(["redDot", o.index, false]),
  showToast: (o) => calls.push(["toast", o.title]),
  showLoading: (o) => calls.push(["loading", o.title]),
  hideLoading: () => calls.push(["hideLoading"]),
  navigateTo: (o) => {
    calls.push(["navigateTo", o.url]);
    if (o.success) o.success();
  },
  redirectTo: (o) => {
    calls.push(["redirectTo", o.url]);
    if (o.success) o.success();
  },
  navigateBack: (o = {}) => {
    calls.push(["navigateBack", o.delta || 1]);
    if (o.success) o.success();
  },
  switchTab: (o) => {
    calls.push(["switchTab", o.url]);
    if (o.success) o.success();
  },
  setNavigationBarTitle: (o) => calls.push(["title", o.title]),
  enableAlertBeforeUnload: () => calls.push(["alertOn"]),
  disableAlertBeforeUnload: (o) => {
    calls.push(["alertOff"]);
    if (o && o.complete) o.complete();
  },
  showModal: (o) => {
    // 跟真的一样：按钮的字超过 4 个，微信不弹窗
    ["confirmText", "cancelText"].forEach((k) => assert.ok(!o[k] || o[k].length <= 4, `showModal 的 ${k}「${o[k]}」超过 4 个字，真机上弹不出来`));
    const answer = modalAnswers.length ? modalAnswers.shift() : { confirm: true };
    calls.push(["modal", o.title, o.content || ""]);
    const res = { confirm: !!answer.confirm, cancel: !answer.confirm, content: answer.content || "" };
    if (o.success) o.success(res);
    if (o.complete) o.complete(res);
  },
  showActionSheet: (o) => {
    calls.push(["actionSheet", o.itemList]);
    if (sheetAnswers.length) o.success({ tapIndex: sheetAnswers.shift() });
    else o.fail({ errMsg: "showActionSheet:fail cancel" });
  },
  chooseMedia: (o) => {
    if (chooseMediaFail) {
      const err = chooseMediaFail;
      chooseMediaFail = null;
      o.fail(err);
      return;
    }
    chooseCount++;
    o.success({ tempFiles: [{ tempFilePath: `http://tmp/photo${chooseCount}.jpg`, size: 1000 }] });
  },
  compressImage: (o) => o.success({ tempFilePath: `${o.src.replace(/\.jpg$/, "")}-w${o.compressedWidth}.jpg` }),
};
// 手机上的文件（导出、导入、提示音用）
const files = {};
let nextMessageFile = null; // 下一次 chooseMessageFile 选中的文件 { path, name }
let clipboardText = ""; // 剪贴板
let clipboardFail = null; // 复制 / 粘贴失败（比如隐私指引里没声明剪切板）
let platformName = "ios"; // 手机 ios / android，电脑版微信 windows / mac
Object.assign(global.wx, {
  env: { USER_DATA_PATH: "http://usr" },
  getFileSystemManager: () => ({
    accessSync: (p) => {
      if (!(p in files)) throw new Error(`access:fail no such file ${p}`);
    },
    writeFileSync: (p, data) => {
      files[p] = String(data);
    },
    readFileSync: (p, encoding) => {
      if (!(p in files)) throw new Error(`readFile:fail no such file ${p}`);
      return encoding === "base64" ? Buffer.from(files[p]).toString("base64") : files[p];
    },
    statSync: (p) => ({ size: Buffer.byteLength(files[p] || "") }),
    unlinkSync: (p) => {
      delete files[p];
    },
  }),
  chooseMessageFile: (o) => {
    const file = nextMessageFile;
    if (!file) {
      o.fail({ errMsg: "chooseMessageFile:fail cancel" });
      return;
    }
    o.success({ tempFiles: [file] });
  },
  setKeepScreenOn: (o) => calls.push(["keepScreenOn", o.keepScreenOn]),
  vibrateLong: () => calls.push(["vibrate"]),
  vibrateShort: (o) => calls.push(["buzz", o.type]),
  setInnerAudioOption: () => {},
  createInnerAudioContext: () => ({
    src: "",
    play() {
      calls.push(["sound", this.src]);
    },
    stop() {},
    destroy() {},
  }),
  setClipboardData: (o) => {
    if (clipboardFail) {
      if (o.fail) o.fail(clipboardFail);
      return;
    }
    clipboardText = o.data;
    calls.push(["clipboard", o.data]);
    if (o.success) o.success();
  },
  getClipboardData: (o) => {
    if (clipboardFail) {
      if (o.fail) o.fail(clipboardFail);
      return;
    }
    o.success({ data: clipboardText });
  },
  saveFileToDisk: (o) => {
    calls.push(["saveToDisk", o.filePath]);
    if (o.success) o.success();
  },
  getDeviceInfo: () => ({ platform: platformName }),
  shareFileMessage: (o) => {
    calls.push(["shareFile", o.fileName, o.filePath]);
    if (o.success) o.success();
  },
  pageScrollTo: (o) => calls.push(["scrollTo", o.scrollTop]),
  // 画布导出成图片：把画上去的字存进假的图片文件，测试里能检查图片上写了什么
  canvasToTempFilePath: (o) => {
    const tempFilePath = `http://tmp/canvas${++canvasSeq}.png`;
    files[tempFilePath] = o.canvas.texts.join("\n");
    calls.push(["canvasImage", tempFilePath, o.canvas.width, o.canvas.height]);
    o.success({ tempFilePath });
  },
  showShareImageMenu: (o) => {
    calls.push(["shareImage", o.path]);
    if (o.success) o.success();
  },
  previewImage: (o) => calls.push(["previewImage", o.urls]),
});

// 假的 <canvas type="2d">：记下 fillText 写了哪些字；改宽高会清空（跟真的画布一样）
let canvasSeq = 0;
function fakeCanvas() {
  const texts = [];
  let width = 300;
  let height = 150;
  const ctx = {
    font: "10px sans-serif",
    measureText(t) {
      const size = Number((/(\d+(?:\.\d+)?)px/.exec(this.font) || [0, 10])[1]);
      // 汉字一个字一个字号宽，字母数字大约一半
      return { width: [...String(t)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55) * size, 0) };
    },
    fillText(t) {
      texts.push(String(t));
    },
  };
  ["fillRect", "beginPath", "moveTo", "lineTo", "arc", "closePath", "fill", "stroke", "save", "restore", "translate", "rotate", "scale", "setTransform", "setLineDash", "clip", "drawImage"].forEach((m) => {
    ctx[m] = () => {};
  });
  const canvas = {
    texts,
    getContext: () => ctx,
    // 照片：能显示的地址就加载成功
    createImage: () => {
      const img = { width: 800, height: 600, onload: null, onerror: null };
      let src = "";
      Object.defineProperty(img, "src", {
        get: () => src,
        set: (v) => {
          src = v;
          setTimeout(() => (imageLoads(v) ? img.onload && img.onload() : img.onerror && img.onerror()), 0);
        },
      });
      return img;
    },
  };
  Object.defineProperty(canvas, "width", { get: () => width, set: (v) => { width = v; texts.length = 0; } });
  Object.defineProperty(canvas, "height", { get: () => height, set: (v) => { height = v; texts.length = 0; } });
  return canvas;
}
// 免费环境的云存储权限是「仅创建者可读写」，而且改不了：小程序里只读得到自己传的照片
let storagePermission = "creatorOnly";
const clientCanRead = (fileID) =>
  !!cloudFiles[fileID] && (storagePermission !== "creatorOnly" || cloudFiles[fileID].owner === currentUser);
global.wx.cloud.downloadFile = async ({ fileID }) => {
  if (!cloudFiles[fileID]) throw cloudError(`downloadFile:fail file not exist ${fileID}`);
  if (!clientCanRead(fileID)) throw cloudError(`downloadFile:fail STORAGE_EXCEED_AUTHORITY ${fileID}`);
  const tempFilePath = `http://tmp/dl-${fileID.split("/").pop()}`;
  files[tempFilePath] = `照片内容:${fileID}`;
  return { tempFilePath };
};

// 云函数端的 wx-server-sdk：管理员身份，不受数据库、存储权限限制
let tempUrlSeq = 0;
let serverUser = ""; // 正在调云函数的是谁（微信自动带上的 OPENID）
const serverCommand = {
  set: (value) => ({ __op: "set", value }),
  inc: (value) => ({ __op: "inc", value }),
  remove: () => ({ __op: "remove" }),
  exists: (value) => ({ __op: "exists", value }),
  or: (value) => ({ __op: "or", value }),
};
const fakeServerSdk = {
  DYNAMIC_CURRENT_ENV: "current-env",
  init: () => {},
  getWXContext: () => ({ OPENID: serverUser, APPID: "wx-test", ENV: "test-env" }),
  database: () => ({
    command: serverCommand,
    collection: serverCollection,
    createCollection: async (name) => {
      if (!serverCanCreate) throw cloudError("createCollection:fail -501001 permission denied");
      if (cloudDB[name]) throw cloudError(`createCollection:fail collection ${name} already exists`);
      cloudDB[name] = [];
      return { errMsg: "createCollection:ok" };
    },
  }),
  getTempFileURL: async ({ fileList }) => ({
    fileList: fileList.map((fileID) =>
      cloudFiles[fileID]
        ? { fileID, status: 0, tempFileURL: `https://tmp.tcb/${fileID.split("/").slice(3).join("/")}?sign=${++tempUrlSeq}` }
        : { fileID, status: -1, errMsg: "STORAGE_FILE_NONEXIST" }
    ),
  }),
  deleteFile: async ({ fileList }) => ({
    fileList: fileList.map((fileID) => {
      const had = !!cloudFiles[fileID];
      delete cloudFiles[fileID];
      return { fileID, status: had ? 0 : -1 };
    }),
  }),
  downloadFile: async ({ fileID }) => {
    if (!cloudFiles[fileID]) throw new Error(`STORAGE_FILE_NONEXIST ${fileID}`);
    return { fileContent: Buffer.from(cloudFiles[fileID].content || `照片内容:${fileID}`), statusCode: 200 };
  },
  uploadFile: async ({ cloudPath, fileContent }) => {
    const fileID = `cloud://test-env.1234/${cloudPath}`;
    cloudFiles[fileID] = { owner: "admin", path: `server:${cloudPath}`, content: String(fileContent) };
    return { fileID };
  },
};
const Module = require("module");
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "wx-server-sdk") return fakeServerSdk;
  return realLoad.call(this, request, parent, isMain);
};
const apiFunctionFile = path.join(root, "../cloudfunctions/api/index.js");
let apiDeployed = true; // 云函数 api 上传部署了没有
global.wx.cloud.callFunction = async ({ name, data }) => {
  if (!cloudInits) throw new Error("请先调用 wx.cloud.init()");
  const actions = data.action === "batch" ? data.calls.map((c) => c.action) : [data.action];
  calls.push(["callFunction", name, actions.join(",")]);
  if (offline) throw cloudError("cloud.callFunction:fail request:fail timeout");
  if (name !== "api" || !apiDeployed) {
    throw cloudError("cloud.callFunction:fail -501000 [ResourceNotFound.Function] 未找到指定的Function，请创建后再试。", -501000);
  }
  const caller = currentUser; // 发请求的那台手机（等结果的时候测试可能已经换了一台）
  await Promise.resolve();
  serverUser = caller;
  return { result: clone(await require(apiFunctionFile).main(clone(data), {})) };
};
// 确认点菜单页（pages/checkout）：opts 是页面参数（edit=1 改一改、start=菜品id 下好单直接开始做）
async function openCheckout(opts) {
  const page = newPage("pages/checkout/index");
  await page.onLoad(opts || {});
  return page;
}
// 去下单：照默认的填，setup(page) 里可以先改几样，再「确认下单」
async function placeOrder(setup) {
  const page = await openCheckout({});
  if (setup) await setup(page);
  await page.onSubmit();
  await flush();
  return page;
}
// 成员、申请人在小程序里的 id（跟云函数里一样算）
const memberKeyOf = (bookId, openid) => require("crypto").createHash("sha256").update(`${bookId}:${openid}`).digest("hex").slice(0, 12);
// 直接调云函数（不经过手机上的代码）：模拟几台手机同时调用
async function callAs(user, data) {
  await Promise.resolve();
  serverUser = user;
  return clone(await require(apiFunctionFile).main(clone(data), {}));
}
// 这个地址在当前这台手机上能不能显示出来
const imageLoads = (url) => {
  if (!url) return false;
  if (/^https:\/\/tmp\.tcb\//.test(url)) return true; // 云函数换来的临时链接，谁都能看
  if (/^cloud:\/\//.test(url)) return clientCanRead(url);
  return true; // 手机上的临时文件
};
global.getCurrentPages = () => pageStack;

let captured = null;
global.Page = (cfg) => {
  captured = cfg;
};
let capturedComponent = null;
global.Component = (cfg) => {
  capturedComponent = cfg;
};
// 创建一个自定义组件实例：props 是页面给的属性（会触发 observers），然后 attached
function newComponent(compPath, props) {
  const file = path.join(root, `${compPath}.js`);
  delete require.cache[require.resolve(file)];
  capturedComponent = null;
  require(file);
  const cfg = capturedComponent;
  const comp = Object.assign({ events: [] }, cfg.methods);
  comp.data = clone(cfg.data || {});
  Object.keys(cfg.properties || {}).forEach((k) => (comp.data[k] = cfg.properties[k].value));
  comp.setData = function (obj) {
    Object.keys(obj).forEach((k) => setPath(this.data, k, obj[k]));
    Object.keys(cfg.observers || {}).forEach((k) => {
      if (k in obj) cfg.observers[k].call(this, this.data[k]);
    });
  };
  comp.triggerEvent = function (name, detail) {
    this.events.push([name, detail]);
  };
  if (props) comp.setData(props);
  if (cfg.lifetimes && cfg.lifetimes.attached) cfg.lifetimes.attached.call(comp);
  return comp;
}
let appCfg = null;
global.App = (cfg) => {
  appCfg = cfg;
};

// 模拟在某台手机上重新打开小程序：清掉所有模块（内存里的数据），这台手机的本地缓存和云上的数据保留
function launchApp(user) {
  if (user) currentUser = user;
  Object.keys(require.cache).forEach((k) => {
    if (k.startsWith(root)) delete require.cache[k];
  });
  cloudInits = 0;
  require(path.join(root, "app.js"));
  appCfg.onLaunch();
}

function loadPageConfig(pagePath) {
  captured = null;
  const file = path.join(root, `${pagePath}.js`);
  delete require.cache[require.resolve(file)];
  require(file);
  return captured;
}

function setPath(obj, pathStr, value) {
  const keys = pathStr.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined) cur[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function newPage(pagePath) {
  const cfg = loadPageConfig(pagePath);
  const page = Object.create(cfg);
  page.route = pagePath;
  page.data = clone(cfg.data || {});
  page.setData = function (obj, cb) {
    Object.keys(obj).forEach((k) => setPath(this.data, k, obj[k]));
    if (cb) cb();
  };
  page.createSelectorQuery = () => {
    let wantsNode = false;
    const q = {
      select: () => q,
      selectAll: () => q,
      boundingClientRect: () => q,
      fields: (o) => {
        wantsNode = !!(o && o.node);
        return q;
      },
      exec: (cb) => {
        // 画布节点（点菜单图片用）；不然就是菜单页量各分类段的位置
        if (wantsNode) cb([{ node: page.canvasNode || (page.canvasNode = fakeCanvas()), width: 360, height: 360 }]);
        else cb([{ top: 100 }, page.data.sections.map((s, i) => ({ top: 100 + i * 400 }))]);
      },
    };
    return q;
  };
  return page;
}

const lastCall = (type) => calls.filter((c) => c[0] === type).pop();
const countCalls = (type) => calls.filter((c) => c[0] === type).length;
const ev = (dataset, detail) => ({ currentTarget: { dataset }, detail: detail || {} });
// 计时器的读数（"番茄炒蛋 · 第 1 步 00:20"）。Date.now 是真实时间加上拨过的时间，电脑忙的时候测试会慢一两秒，
// 剩余时间就比算好的少一秒，所以秒数允许少 3 秒以内，前面的字要完全一样
const secondsOf = (text) => {
  const m = /(\d+):(\d\d)$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
function assertTimers(actual, expected, message) {
  const head = (text) => text.replace(/\d+:\d\d$/, "");
  assert.deepStrictEqual(actual.map(head), expected.map(head), message);
  actual.forEach((text, i) => {
    const late = secondsOf(expected[i]) - secondsOf(text);
    assert.ok(late >= 0 && late <= 3, `${message || "计时"}：是 ${text}，应该是 ${expected[i]}`);
  });
}
// 按 WXML 里写的 class 表达式，算出某个元素实际有哪些 class（{{ }} 里是普通的 JS 表达式）
function classOf(pagePath, marker, scope) {
  const wxml = fs.readFileSync(path.join(root, pagePath + ".wxml"), "utf8");
  const m = wxml.match(new RegExp(`class="(${marker}[^"]*)"`));
  assert.ok(m, `${pagePath}.wxml 里找不到 class="${marker}…"`);
  const names = Object.keys(scope);
  const value = (expr) => new Function(...names, `return (${expr});`)(...names.map((k) => scope[k]));
  return m[1].replace(/\{\{(.+?)\}\}/g, (_, expr) => String(value(expr) || "")).split(/\s+/).filter(Boolean);
}
// 测试里两台手机一起用的那本（家庭本本）。云上的记录按 bookId 分本，plans 里每本各一条菜篮、库存、想吃清单
let testBookId = "";
const planIdOf = (bookId, kind) => (bookId === "legacy" ? kind : `${bookId}-${kind}`);
const inBook = (row) => !testBookId || row.bookId === testBookId || (testBookId === "legacy" && row.bookId === undefined);
const rowOf = (name) => (cloudDB.dishes || []).find((d) => d.name === name && inBook(d));
const sharedDoc = (kind) => (cloudDB.plans || []).find((p) => p._id === planIdOf(testBookId, kind)) || {};
const planDoc = () => sharedDoc("current");
const cacheOf = (base) => dev()[`dev_${base}@${testBookId}`]; // 手机上这本的缓存（开发版 key 带 dev_）
const svc = (name) => require(path.join(root, "services", name)); // 这次打开的模块（页面用的是同一份）
const dishNow = async (name) => (await svc("dish").listDishes()).find((d) => d.name === name);
const planItems = () => planDoc().items || {};
const idOf = (name) => rowOf(name)._id;
const catOf = (name) => cloudDB.categories.find((c) => c.name === name && inBook(c))._id;

// 在「对方的手机」上直接改云上的数据（模拟对方在自己手机上保存了）
function partnerWrites(fn) {
  fn();
  timeOffset += 1; // 让 updatedAt 不同
}

// ---------------- 静态检查 ----------------
function staticChecks() {
  const app = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
  for (const p of app.pages) {
    for (const ext of ["js", "json", "wxml", "wxss"]) {
      if (!fs.existsSync(path.join(root, `${p}.${ext}`))) fail(`missing ${p}.${ext}`);
    }
    try {
      JSON.parse(fs.readFileSync(path.join(root, `${p}.json`), "utf8"));
    } catch (e) {
      fail(`${p}.json: ${e.message}`);
    }
  }
  for (const t of app.tabBar.list) {
    if (!app.pages.includes(t.pagePath)) fail(`tab page not in pages: ${t.pagePath}`);
    for (const k of ["iconPath", "selectedIconPath"]) {
      const f = path.join(root, t[k]);
      if (!fs.existsSync(f)) fail(`missing icon ${t[k]}`);
      else if (fs.statSync(f).size > 40 * 1024) fail(`icon over 40KB ${t[k]}`);
    }
  }
  ok("app.json, page files, tab icons");

  // 自定义组件：app.json 里注册的组件文件都在
  const comps = app.usingComponents || {};
  for (const p of Object.values(comps)) {
    for (const ext of ["js", "json", "wxml", "wxss"]) {
      if (!fs.existsSync(path.join(root, `${p}.${ext}`))) fail(`missing component ${p}.${ext}`);
    }
    if (JSON.parse(fs.readFileSync(path.join(root, `${p}.json`), "utf8")).component !== true) fail(`${p}.json: 少了 "component": true`);
  }

  // WXML：标签配对 + 每个 '<' 都被识别成标签
  const wxmlFiles = app.pages.map((p) => path.join(root, `${p}.wxml`));
  fs.readdirSync(path.join(root, "templates")).filter((f) => f.endsWith(".wxml")).forEach((f) => wxmlFiles.push(path.join(root, "templates", f)));
  Object.values(comps).forEach((p) => wxmlFiles.push(path.join(root, `${p}.wxml`)));
  // 带横线的标签：要么是内置组件，要么在 app.json 里注册过
  const builtinDashed = new Set(["scroll-view", "swiper-item", "picker-view", "picker-view-column", "checkbox-group", "radio-group", "rich-text", "movable-area", "movable-view", "cover-view", "cover-image", "web-view", "page-meta", "navigation-bar", "page-container", "match-media", "root-portal"]);
  for (const file of wxmlFiles) {
    const src = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    for (const m of src.matchAll(/<([a-z][a-z0-9]*-[a-z0-9-]+)/g)) {
      if (!builtinDashed.has(m[1]) && !comps[m[1]]) fail(`${rel(file)}: <${m[1]}> 没有在 app.json 的 usingComponents 里注册`);
    }
  }
  for (const file of wxmlFiles) {
    const src = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>"'\/]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>/g;
    const stack = [];
    let tags = 0;
    let m;
    let bad = false;
    while ((m = re.exec(src))) {
      tags++;
      const [, closing, name, , selfClosing] = m;
      if (closing) {
        const top = stack.pop();
        if (top !== name) {
          fail(`${rel(file)}: </${name}> closes <${top}>`);
          bad = true;
          break;
        }
      } else if (!selfClosing) {
        stack.push(name);
      }
    }
    const opens = (src.match(/<[\/a-zA-Z]/g) || []).length;
    if (!bad && stack.length) fail(`${rel(file)}: unclosed <${stack.join(">, <")}>`);
    else if (!bad && opens !== tags) fail(`${rel(file)}: ${opens - tags} malformed tag(s)`);
    // WXML 表达式里不能调用方法（比如 indexOf），只能用运算符
    for (const expr of src.match(/{{[^}]*}}/g) || []) {
      if (/\.\w+\(/.test(expr)) fail(`${rel(file)}: 表达式里调用了方法 ${expr}`);
    }
    // 套在一起的 wx:for 序号名一样（默认都叫 index）时，里面那层的 {{index}} 是里面的序号，不是外面的：
    // 里面那层要用 wx:for-index 换个名字
    const loops = []; // 外面几层 wx:for 的序号名
    const opened = []; // 还没关上的标签
    const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>"'\/]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>/g;
    let t;
    while ((t = tagRe.exec(src))) {
      const [, closing, name, attrs, selfClosing] = t;
      if (closing) {
        const top = opened.pop();
        if (top && top.loop) {
          loops.pop();
          const inside = src.slice(top.bodyStart, t.index);
          if (top.shadows && new RegExp(`{{[^}]*\\b${top.indexName}\\b`).test(inside)) {
            fail(`${rel(file)}: <${top.name} wx:for> 套在另一个 wx:for 里，序号都叫 ${top.indexName}，里面用的是里层的序号；给里层加 wx:for-index`);
          }
        }
        continue;
      }
      if (selfClosing) continue;
      const loop = /\swx:for="/.test(attrs);
      const indexName = (/\swx:for-index="([^"]+)"/.exec(attrs) || [])[1] || "index";
      // 里层自己的属性（比如 data-i="{{index}}"）也算里层
      opened.push({ name, loop, indexName, shadows: loop && loops.includes(indexName), bodyStart: t.index });
      if (loop) loops.push(indexName);
    }
  }
  ok("WXML tags balanced, no method calls in expressions");

  // 本地图片：WXML 里写的 /images/... 都要真有这个文件（图标名字写错了会显示空白）
  const allWxml = wxmlFiles.concat(fs.readdirSync(path.join(root, "pages")).map((d) => path.join(root, "pages", d, "index.wxml")));
  let imageRefs = 0;
  for (const file of [...new Set(allWxml)]) {
    if (!fs.existsSync(file)) continue;
    for (const m of fs.readFileSync(file, "utf8").matchAll(/src="(\/images\/[^"{}]+)"/g)) {
      imageRefs++;
      if (!fs.existsSync(path.join(root, m[1]))) fail(`${rel(file)}: 图片不存在 ${m[1]}`);
    }
  }
  ok(`本地图片都在（${imageRefs} 处）`);

  // 事件处理函数：WXML（含 import 的模板）里绑定的函数，页面 JS 里都要有
  const handlersIn = (file, visited = new Set()) => {
    const names = new Set();
    if (visited.has(file)) return names;
    visited.add(file);
    const src = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    for (const m of src.matchAll(/\b(?:bind|catch):?[a-z]+="([^"{}]+)"/g)) names.add(m[1]);
    for (const m of src.matchAll(/<import\s+src="([^"]+)"/g)) {
      const t = m[1].startsWith("/") ? path.join(root, m[1]) : path.join(path.dirname(file), m[1]);
      if (!fs.existsSync(t)) {
        fail(`${rel(file)}: import not found ${m[1]}`);
        continue;
      }
      for (const n of handlersIn(t, visited)) names.add(n);
    }
    return names;
  };
  for (const p of app.pages) {
    const cfg = loadPageConfig(p);
    for (const name of handlersIn(path.join(root, `${p}.wxml`))) {
      if (typeof cfg[name] !== "function") fail(`${p}: handler ${name} not defined`);
    }
  }
  for (const p of Object.values(comps)) {
    const file = path.join(root, `${p}.js`);
    delete require.cache[require.resolve(file)];
    capturedComponent = null;
    require(file);
    for (const name of handlersIn(path.join(root, `${p}.wxml`))) {
      if (!capturedComponent || typeof (capturedComponent.methods || {})[name] !== "function") fail(`${p}: handler ${name} not defined`);
    }
  }
  ok("event handlers exist");

  // 弹窗按钮的字最多 4 个，多了微信不弹窗、点了没反应（「删掉并退出」出过这个事）。没跑到的弹窗也查一遍
  const jsFilesIn = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return jsFilesIn(p);
      return d.name.endsWith(".js") ? [p] : [];
    });
  let buttonTexts = 0;
  for (const file of jsFilesIn(root)) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/\b(confirmText|cancelText):\s*(["'`])(.*?)\2/g)) {
      buttonTexts++;
      if (m[3].length > 4) fail(`${rel(file)}: ${m[1]}「${m[3]}」超过 4 个字，真机上弹不出来`);
    }
  }
  if (!buttonTexts) fail("没找到弹窗按钮的字，检查的写法要跟着改");
  ok(`弹窗按钮的字都不超过 4 个（${buttonTexts} 处）`);

  // WXSS：括号配对，用到的 CSS 变量都在 app.wxss 里定义过
  const wxssFiles = [path.join(root, "app.wxss")]
    .concat(app.pages.map((p) => path.join(root, `${p}.wxss`)))
    .concat(Object.values(comps).map((p) => path.join(root, `${p}.wxss`)));
  const defined = new Set(
    [...fs.readFileSync(path.join(root, "app.wxss"), "utf8").matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
  );
  for (const file of wxssFiles) {
    const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const open = (src.match(/{/g) || []).length;
    const close = (src.match(/}/g) || []).length;
    if (open !== close) fail(`${rel(file)}: { ${open} vs } ${close}`);
    for (const m of src.matchAll(/var\((--[\w-]+)\)/g)) {
      if (!defined.has(m[1])) fail(`${rel(file)}: undefined ${m[1]}`);
    }
  }
  ok("WXSS braces and CSS variables");
}

// ---------------- 冒烟测试 ----------------
async function smoke() {
  const { formatSeconds, formatMonthDay, normalizeDish } = require(path.join(root, "utils/dish"));
  assert.strictEqual(formatSeconds(30), "30 秒");
  assert.strictEqual(formatSeconds(120), "2 分钟");
  assert.strictEqual(formatSeconds(90), "1 分 30 秒");
  assert.strictEqual(formatSeconds(3600), "1 小时");
  assert.strictEqual(formatMonthDay("2026-10-12"), "10月12日");
  assert.strictEqual(formatMonthDay(new Date(2026, 9, 17).getTime()), "10月17日");
  assert.strictEqual(formatMonthDay(null), "");
  const n = normalizeDish({ name: " 汤 ", tags: ["a", " a", "", "b"], ingredients: [{ name: " " }, { name: "盐", type: "x" }], steps: [{ text: "" }, { text: " 煮 ", timer: "30" }], difficulty: 9 });
  assert.deepStrictEqual([n.name, n.tags, n.ingredients.length, n.ingredients[0].type, n.steps.length, n.steps[0].timer, n.difficulty, n.status], ["汤", ["a", "b"], 1, "main", 1, 30, 5, "wish"]);
  ok("utils/dish formatters & normalizeDish");

  // 做饭总结的统计（utils/stats.js）：按月、按年、全部
  {
    const { summarize, shiftRange, canShift } = require(path.join(root, "utils/stats"));
    const at = (date) => new Date(`${date.replace(/-/g, "/")} 12:00`).getTime();
    const L = (dishId, date, extra) => Object.assign({ dishId, dishName: "", cookedAt: at(date), rating: 0, cook: "" }, extra);
    const statDishes = [{ _id: "a", name: "番茄炒蛋" }, { _id: "b", name: "可乐鸡翅" }, { _id: "c", name: "红烧肉" }];
    const statLogs = [
      L("c", "2026-06-10", { rating: 4, cook: "小亮" }),
      L("a", "2026-09-26", { rating: 5, cook: "小亮" }),
      L("a", "2026-09-27", { rating: 4, cook: "小鱼" }),
      L("b", "2026-09-27", { cook: "小亮" }),
      L("x", "2026-09-29", { dishName: "鲫鱼汤" }), // 这道菜后来删掉了
      L("b", "2026-10-02", { rating: 3 }),
    ];
    const statNow = at("2026-10-20");
    const sep = summarize(statLogs, statDishes, { kind: "month", year: 2026, month: 8 }, statNow);
    assert.deepStrictEqual([sep.title, sep.count, sep.dishCount, sep.days], ["2026年9月", 4, 3, 3], "下厨几次、几道不同的菜、几天在做饭");
    assert.deepStrictEqual(
      sep.top.map((t) => `${t.name}×${t.count}|${t.pct}${t.gone ? "|删掉了" : ""}`),
      ["番茄炒蛋×2|100", "鲫鱼汤×1|50|删掉了", "可乐鸡翅×1|50"],
      "最常做：次数一样的，最近做过的在前；删掉的菜用记录里的名字"
    );
    assert.deepStrictEqual(sep.cooks.map((c) => `${c.name} ${c.count} ${c.pct}% ${c.color}`), ["小亮 2 67% #ffb21e", "小鱼 1 33% #a0693f"]);
    assert.deepStrictEqual(sep.best.map((b) => `${b.name} ${b.stars} ${b.avgText} ${b.rated}`), ["番茄炒蛋 ★★★★★ 4.5 2"], "没打分的不算");
    assert.deepStrictEqual(sep.firstTimes.map((f) => f.name), ["番茄炒蛋", "可乐鸡翅", "鲫鱼汤"]);
    assert.deepStrictEqual([sep.chart, sep.stale], [[], []], "按月不画每个月的条（日历上有），也不提好久没做的");
    const oct = summarize(statLogs, statDishes, { kind: "month", year: 2026, month: 9 }, statNow);
    assert.deepStrictEqual([oct.count, oct.firstTimes, oct.cooks], [1, [], []], "以前做过的不算第一次做；没写掌勺就不显示");
    const y2026 = summarize(statLogs, statDishes, { kind: "year", year: 2026, month: 9 }, statNow);
    assert.deepStrictEqual([y2026.title, y2026.count, y2026.dishCount, y2026.days], ["2026年", 6, 4, 5]);
    assert.deepStrictEqual(
      y2026.chart.map((c) => `${c.label}:${c.count}${c.count ? "/" + c.pct : ""}${c.current ? "*" : ""}`).join(" "),
      "1月:0 2月:0 3月:0 4月:0 5月:0 6月:1/25 7月:0 8月:0 9月:4/100 10月:1/25* 11月:0 12月:0",
      "按年：12 个月的条，这个月标出来"
    );
    const all = summarize(statLogs, statDishes, { kind: "all", year: 2026, month: 9 }, statNow);
    assert.deepStrictEqual([all.title, all.count, all.firstTimes, all.chart[0].key, all.chart[11].key], ["全部", 6, [], "2025-11", "2026-10"], "全部：最近 12 个月");
    assert.deepStrictEqual(all.stale.map((d) => `${d.name} ${d.days} ${d.text}`), ["红烧肉 132 上次是 4 个月前"], "好久没做了：30 天以上，删掉的菜不提");
    assert.deepStrictEqual(summarize([], statDishes, { kind: "year", year: 2026, month: 0 }, statNow).chart, [], "一条都没有就不画");
    assert.deepStrictEqual([shiftRange({ kind: "month", year: 2026, month: 0 }, -1), shiftRange({ kind: "year", year: 2026, month: 3 }, 1)], [
      { kind: "month", year: 2025, month: 11 },
      { kind: "year", year: 2027, month: 3 },
    ]);
    assert.deepStrictEqual(
      [
        canShift({ kind: "month", year: 2026, month: 8 }, -1, statLogs, statNow),
        canShift({ kind: "month", year: 2026, month: 5 }, -1, statLogs, statNow),
        canShift({ kind: "month", year: 2026, month: 8 }, 1, statLogs, statNow),
        canShift({ kind: "month", year: 2026, month: 9 }, 1, statLogs, statNow),
        canShift({ kind: "all", year: 2026, month: 9 }, -1, statLogs, statNow),
      ],
      [true, false, true, false, false],
      "比最早的记录还早、还没到的月份不能翻"
    );
  }
  ok("做饭总结的统计：按月、按年、全部");

  // 买菜清单合并：番茄炒蛋 2 份 + 蛋炒饭 1 份
  const samplesData = require(path.join(root, "data/samples"));
  const { buildShoppingList, parseAmount } = require(path.join(root, "utils/shopping"));
  const sd = (name) => normalizeDish(samplesData.dishes.find((d) => d.name === name));
  const list = buildShoppingList([{ dish: sd("番茄炒蛋"), qty: 2 }, { dish: sd("蛋炒饭"), qty: 1 }], {}, {});
  const show = (items) => items.map((i) => `${i.name} ${i.amountText}`);
  assert.deepStrictEqual(show(list.buy), ["鸡蛋 8个", "番茄 4个", "葱 3根", "隔夜米饭 1碗", "火腿肠 1根"]);
  assert.deepStrictEqual(show(list.unknown), ["盐 适量", "白糖 2小勺", "食用油 6汤匙"]);
  // 对比库存：家里有的不用买，用完了的放回要买的
  const { keyOf } = require(path.join(root, "utils/shopping"));
  const stock = {
    [keyOf("盐")]: { name: "盐", inStock: true },
    [keyOf("食用油")]: { name: "食用油", inStock: true },
    [keyOf("鸡蛋")]: { name: "鸡蛋", inStock: false },
    [keyOf("隔夜米饭")]: { name: "隔夜米饭", inStock: true },
  };
  const withStock = buildShoppingList([{ dish: sd("番茄炒蛋"), qty: 2 }, { dish: sd("蛋炒饭"), qty: 1 }], {}, {}, stock);
  assert.deepStrictEqual(show(withStock.stocked), ["盐 适量", "食用油 6汤匙", "隔夜米饭 1碗"]);
  assert.deepStrictEqual(withStock.buy.filter((i) => i.outOfStock).map((i) => i.name), ["鸡蛋"], "用完了的标出来");
  assert.deepStrictEqual(show(withStock.unknown), ["白糖 2小勺"]);
  assert.strictEqual(withStock.total, 5, "家里有的不算在要买的里面");
  assert.strictEqual(keyOf("口蘑（可选）"), keyOf("口蘑"), "括号里的说明不影响对库存");
  assert.strictEqual(list.buy[0].dishesText, "番茄炒蛋、蛋炒饭");
  assert.deepStrictEqual([list.total, list.done], [8, 0]);
  assert.deepStrictEqual([parseAmount("1/2"), parseAmount("1.5"), parseAmount("适量")], [0.5, 1.5, null]);
  const mixed = buildShoppingList(
    [{ dish: normalizeDish({ name: "甲", ingredients: [{ name: "糖", amount: "1/2", unit: "勺" }, { name: "面", amount: "100", unit: "克" }] }), qty: 1 },
     { dish: normalizeDish({ name: "乙", ingredients: [{ name: "糖", amount: "1/2", unit: "勺" }, { name: "面", amount: "1", unit: "碗" }, { name: "面", amount: "少许" }] }), qty: 3 }],
    {}, {}
  );
  assert.deepStrictEqual(show(mixed.buy), ["糖 2勺", "面 100克 + 3碗 + 少许"]);
  ok(`买菜清单合并：${show(list.buy).slice(0, 3).join("、")}…`);

  // ---- 我的手机，第一次打开：云上集合是空的 → 欢迎页 ----
  cloudDB.categories = [];
  cloudDB.dishes = [];
  cloudDB.plans = [];
  cloudDB.cook_logs = [];
  launchApp("me");
  assert.deepStrictEqual(lastCall("cloud.init"), ["cloud.init", { traceUser: true }]);
  // 第一次打开新版本：自动有一本只有自己能看的「我的小本本」。先建一本家庭本本，后面两台手机都用这本
  const books0 = svc("book");
  await books0.ready();
  assert.deepStrictEqual([books0.current().name, books0.current().type, books0.list().length], ["我的小本本", "personal", 1]);
  assert.ok(cloudDB.users && cloudDB.books, "云函数自己建好了 users、books 集合");
  testBookId = await books0.create("我们家的小本本", "小亮");
  books0.switchTo(testBookId);
  await flush();
  assert.deepStrictEqual([books0.current().name, books0.current().family], ["我们家的小本本", true]);
  assert.ok(/^[2-9A-HJKMNP-Z]{6}$/.test(books0.current().code), "家庭码 6 位，没有容易看错的 0、O、1、I、L：" + books0.current().code);
  assert.strictEqual(cloudDB.users.find((u) => u._id === "me").lastBook, testBookId, "记住上次用的是哪本");
  const menu = newPage("pages/menu/index");
  await menu.onLoad();
  menu.onShow();
  assert.strictEqual(menu.data.status, "welcome");

  await menu.onImportSamples();
  assert.strictEqual(menu.data.status, "ready");
  assert.strictEqual(cloudDB.categories.length, 5);
  assert.strictEqual(cloudDB.dishes.length, 11);
  assert.ok(cloudDB.dishes.every((d) => d.sample && cloudDB.categories.some((c) => c._id === d.categoryId)));
  assert.deepStrictEqual(menu.data.categories.map((c) => c.name), ["家常菜", "硬菜", "汤羹", "凉菜", "主食"]);
  assert.deepStrictEqual(menu.data.sections[0].dishes.map((d) => d.name), ["番茄炒蛋", "青椒土豆丝", "麻婆豆腐"]);
  assert.strictEqual(menu.data.activeId, catOf("家常菜"));
  assert.deepStrictEqual(menu.sectionTops, [0, 400, 800, 1200, 1600]);
  assert.ok(cacheOf("cloud_cache") && cacheOf("cloud_cache").dishes.length === 11, "这本的数据缓存到本地（每本各存一份）");
  assert.ok(cloudDB.dishes.every((d) => d.bookId === testBookId && !("_openid" in d)), "云函数存的记录都记着是哪本");
  ok("welcome → 放示例菜 → 5 个分类、11 道菜");

  // ---- 点菜、搜索、左右联动 ----
  menu.onPlus(ev({ id: idOf("番茄炒蛋") }));
  assert.deepStrictEqual([menu.data.bump, lastCall("buzz")], [1, ["buzz", "light"]], "加了一份：菜篮弹一下，手机轻震");
  menu.onPlus(ev({ id: idOf("番茄炒蛋") }));
  assert.strictEqual(menu.data.bump, 2, "连着点：换个 class，动画每次都重播");
  menu.onPlus(ev({ id: idOf("可乐鸡翅") }));
  assert.strictEqual(menu.data.basketCount, 3);
  assert.deepStrictEqual(menu.data.basketByCat, { [catOf("家常菜")]: 2, [catOf("硬菜")]: 1 });
  assert.deepStrictEqual(lastCall("badge"), ["badge", null], "还没下单，「点菜单」Tab 上不显示数字（点了几份写在点菜栏上）");
  await flush();
  assert.deepStrictEqual(planItems(), { [idOf("番茄炒蛋")]: 2, [idOf("可乐鸡翅")]: 1 }, "菜篮存到云上");
  menu.onMinus(ev({ id: idOf("番茄炒蛋") }));
  assert.strictEqual(menu.data.basketCount, 2);
  await flush();
  assert.deepStrictEqual(planItems(), { [idOf("番茄炒蛋")]: 1, [idOf("可乐鸡翅")]: 1 });
  // 菜篮：点底部点菜栏左边弹出来，看已点的、加减
  menu.onOpenCart();
  assert.deepStrictEqual([menu.data.showCart, menu.data.cartItems.map((i) => `${i.name}×${i.qty}`)], [true, ["番茄炒蛋×1", "可乐鸡翅×1"]]);
  menu.onCartPlus(ev({ id: idOf("可乐鸡翅") }));
  assert.deepStrictEqual([menu.data.basketCount, menu.data.cartItems[1].qty], [3, 2], "在菜篮里加一份");
  menu.onCartMinus(ev({ id: idOf("可乐鸡翅") }));
  menu.onCloseCart();
  assert.deepStrictEqual([menu.data.showCart, menu.data.cartClosing], [true, true], "先播收起的动画");
  menu.onCloseCart(); // 动画还没播完又点了一下：不重复收
  await sheetClosed();
  assert.deepStrictEqual([menu.data.showCart, menu.data.cartClosing, menu.data.basketCount], [false, false, 2]);
  menu.onSearchInput({ detail: { value: "鸡蛋" } });
  const eggDishes = menu.data.searchResults.map((d) => d.name);
  assert.deepStrictEqual(eggDishes, ["番茄炒蛋", "紫菜蛋花汤", "蛋炒饭"]);
  menu.onClearSearch();
  menu.onTapCategory(ev({ id: catOf("汤羹") }));
  assert.strictEqual(menu.data.scrollIntoView, `sec-${catOf("汤羹")}`);
  menu.onDishScroll({ detail: { scrollTop: 300 } });
  assert.strictEqual(menu.data.activeId, catOf("汤羹"), "点击后的锁定期内不该被滚动改掉");
  menu.tapLock = false;
  menu.onDishScroll({ detail: { scrollTop: 1250 } });
  assert.strictEqual(menu.data.activeId, catOf("凉菜"));
  menu.onDishScrollToLower();
  assert.strictEqual(menu.data.activeId, catOf("主食"));
  clearTimeout(menu.tapTimer);
  menu.onAddDish(ev({}));
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", `/pages/dish-edit/index?categoryId=${catOf("主食")}`]);
  ok(`menu: 点菜、搜索（鸡蛋 → ${eggDishes.join("、")}）、联动、新菜默认当前分类`);

  // ---- 详情页 ----
  const samples = require(path.join(root, "data/samples"));
  for (const s of samples.dishes) {
    const p = newPage("pages/dish-detail/index");
    p.onLoad({ id: idOf(s.name) });
    await flush();
    assert.ok(p.data.dish, s.name);
    assert.strictEqual(p.data.dish.steps.length, s.steps.length);
    assert.strictEqual(p.data.dish.ingredientGroups.reduce((sum, g) => sum + g.items.length, 0), s.ingredients.length);
  }
  const missing = newPage("pages/dish-detail/index");
  missing.onLoad({ id: "nope" });
  await flush();
  assert.strictEqual(missing.data.notFound, true);
  ok(`dish-detail: ${samples.dishes.length} 道示例菜都能显示，找不到的菜显示提示`);

  // ---- 新增菜品 ----
  pageStack = [menu];
  const edit = newPage("pages/dish-edit/index");
  pageStack.push(edit);
  await edit.onLoad({ categoryId: catOf("汤羹") });
  assert.strictEqual(edit.data.form.categoryId, catOf("汤羹"), "从哪个分类点的新菜，就默认哪个分类");
  assert.deepStrictEqual(edit.data.categories.map((c) => c.name), ["家常菜", "硬菜", "汤羹", "凉菜", "主食"], "分类直接摆出来，点一下就选上");
  edit.onCategoryTap(ev({ id: catOf("家常菜") }));
  assert.strictEqual(edit.data.form.categoryId, catOf("家常菜"));
  edit.onCategoryTap(ev({ id: catOf("汤羹") }));
  assert.strictEqual(edit.data.isEdit, false);
  edit.onInput(ev({ field: "name" }, { value: "  鸡蛋羹 " }));
  edit.onInput(ev({ field: "duration" }, { value: "12" }));
  edit.onInput(ev({ field: "servings" }, { value: "1" }));
  edit.onStatusTap(ev({ value: "mastered" }));
  edit.onStarTap(ev({ value: 3 }));
  edit.onTagTap(ev({ tag: "快手" }));
  edit.onTagTap(ev({ tag: "下饭" }));
  edit.onTagTap(ev({ tag: "下饭" }));
  modalAnswers.push({ confirm: true, content: "孩子爱吃" });
  await edit.onAddTag();
  assert.deepStrictEqual(edit.data.tagChips.filter((t) => t.on).map((t) => t.name), ["快手", "孩子爱吃"]);
  edit.onIngInput(ev({ g: 0, i: 0, field: "name" }, { value: "鸡蛋" }));
  edit.onIngInput(ev({ g: 0, i: 0, field: "qty" }, { value: "2个" })); // 用量和单位写在一格里
  edit.onAddIng(ev({ g: 0 }));
  edit.onIngInput(ev({ g: 0, i: 1, field: "name" }, { value: "温水" }));
  edit.onIngInput(ev({ g: 0, i: 1, field: "qty" }, { value: "150 毫升" }));
  edit.onAddIng(ev({ g: 0 })); // 空行，保存时应该去掉
  edit.onRemoveIng(ev({ g: 1, i: 0 }));
  edit.onIngInput(ev({ g: 2, i: 0, field: "name" }, { value: "盐" }));
  edit.onIngInput(ev({ g: 2, i: 0, field: "qty" }, { value: "适量" }));
  edit.onStepInput(ev({ i: 0 }, { value: "鸡蛋加温水打散，过筛。" }));
  edit.onAddStep();
  edit.onStepInput(ev({ i: 1 }, { value: "盖上盘子，水开后中小火蒸 10 分钟。" }));
  edit.onOpenTimer(ev({ i: 1 })); // 计时面板：点常用时长
  assert.deepStrictEqual([edit.data.timerStep, edit.data.timerCurrent], [1, 0]);
  edit.onPickTimer(ev({ value: 600 }));
  await sheetClosed();
  assert.strictEqual(edit.data.timerStep, -1, "选好就收起来");
  // 自定义时长：写「1分30秒」；写不明白的提示一下；「不计时」清掉
  edit.onOpenTimer(ev({ i: 0 }));
  modalAnswers.push({ confirm: true, content: "1分30秒" });
  await edit.onCustomTimer();
  await sheetClosed();
  assert.deepStrictEqual([edit.data.form.steps[0].timer, edit.data.form.steps[0].timerText, edit.data.timerStep], [90, "1 分 30 秒", -1]);
  edit.onOpenTimer(ev({ i: 0 }));
  assert.strictEqual(edit.data.timerCurrent, 90, "打开时标出现在的时长");
  modalAnswers.push({ confirm: true, content: "一会儿" });
  await edit.onCustomTimer();
  assert.deepStrictEqual(lastCall("toast"), ["toast", "没看懂，写成「25分钟」「1分30秒」这样"]);
  assert.strictEqual(edit.data.timerStep, 0, "没看懂就先不关面板");
  edit.onNoTimer();
  await sheetClosed();
  assert.deepStrictEqual([edit.data.form.steps[0].timer, edit.data.timerStep], [0, -1]);
  assert.strictEqual(edit.data.form.steps[1].timerText, "10 分钟");
  await edit.onStepImage(ev({ i: 1 }));
  edit.onAddStep();
  edit.onStepInput(ev({ i: 2 }, { value: "淋生抽和香油。" }));
  const keys = edit.data.form.steps.map((s) => s.key);
  edit.onMoveStep(ev({ i: 2, dir: -1 }));
  assert.deepStrictEqual(edit.data.form.steps.map((s) => s.key), [keys[0], keys[2], keys[1]]);
  edit.onMoveStep(ev({ i: 1, dir: 1 }));
  assert.deepStrictEqual(edit.data.form.steps.map((s) => s.key), keys);
  edit.onAddStep(); // 空步骤，保存时应该去掉
  await edit.onChooseCover();
  assert.ok(countCalls("alertOn") >= 1, "改了表单要开启离开提醒");
  await edit.onSave();
  assert.strictEqual(cloudDB.dishes.length, 12);
  const saved = rowOf("鸡蛋羹");
  assert.ok(saved, "新菜存进云数据库");
  assert.strictEqual(saved.categoryId, catOf("汤羹"));
  assert.deepStrictEqual(saved.tags, ["快手", "孩子爱吃"]);
  assert.deepStrictEqual([saved.difficulty, saved.duration, saved.servings, saved.status, saved.sample], [3, 12, 1, "mastered", false]);
  assert.deepStrictEqual(saved.ingredients.map((i) => `${i.type}:${i.name}${i.amount}${i.unit}`), ["main:鸡蛋2个", "main:温水150毫升", "seasoning:盐适量"]);
  assert.deepStrictEqual(saved.steps.map((s) => s.timer), [0, 600, 0]);
  assert.ok(/^cloud:\/\/.*\/steps\//.test(saved.steps[1].image), "步骤照片传到云存储");
  assert.ok(/^cloud:\/\/.*\/covers\//.test(saved.cover) && /^cloud:\/\/.*\/thumbs\//.test(saved.coverThumb), "成品照传大图和小图");
  assert.strictEqual(Object.keys(cloudFiles).length, 3);
  assert.deepStrictEqual(lastCall("redirectTo"), ["redirectTo", `/pages/dish-detail/index?id=${saved._id}`]);
  assert.deepStrictEqual(lastCall("toast"), ["toast", "已保存"]);
  assert.ok(countCalls("alertOff") >= 1, "保存后离开前要关掉提醒");
  menu.onShow();
  await flush();
  const soup = menu.data.sections.find((s) => s._id === catOf("汤羹"));
  assert.deepStrictEqual(soup.dishes.map((d) => d.name), ["紫菜蛋花汤", "玉米排骨汤", "鸡蛋羹"]);
  assert.strictEqual(soup.dishes[2].cover, saved.coverThumb, "菜单卡片用小图");
  ok("dish-edit 新增：字段、空行去掉、计时、调顺序、照片上传、跳到详情、菜单刷新");

  // ---- 编辑：去掉成品照、改名、删一步 ----
  const det = newPage("pages/dish-detail/index");
  det.onLoad({ id: saved._id });
  await flush();
  assert.strictEqual(det.data.dish.cover, saved.cover, "详情页用大图");
  assert.strictEqual(det.data.dish.steps[1].timerText, "10 分钟");
  pageStack = [menu, det];
  const edit2 = newPage("pages/dish-edit/index");
  pageStack.push(edit2);
  await edit2.onLoad({ id: saved._id });
  assert.strictEqual(edit2.data.isEdit, true);
  assert.deepStrictEqual(edit2.data.form.groups.map((g) => g.items.length), [2, 0, 1]);
  assert.deepStrictEqual(
    edit2.data.form.groups[0].items.map((i) => i.qty).concat(edit2.data.form.groups[2].items.map((i) => i.qty)),
    ["2个", "150毫升", "适量"],
    "用量和单位合在一格里显示"
  );
  edit2.onRemoveCover();
  edit2.onInput(ev({ field: "name" }, { value: "蒸鸡蛋羹" }));
  modalAnswers.push({ confirm: true });
  await edit2.onRemoveStep(ev({ i: 2 }));
  await edit2.onSave();
  await flush(); // 换掉的照片在后台删
  assert.deepStrictEqual(lastCall("navigateBack"), ["navigateBack", 1]);
  const updated = cloudDB.dishes.find((d) => d._id === saved._id);
  assert.deepStrictEqual([updated.name, updated.cover, updated.coverThumb, updated.steps.length], ["蒸鸡蛋羹", "", "", 2]);
  assert.deepStrictEqual(
    updated.ingredients.map((i) => `${i.name}|${i.amount}|${i.unit}`),
    ["鸡蛋|2|个", "温水|150|毫升", "盐|适量|"],
    "再保存一次，用量和单位还是分开存的"
  );
  assert.deepStrictEqual(Object.keys(cloudFiles), [saved.steps[1].image], "换掉的成品照从云存储删掉，步骤照片保留");
  det.onShow();
  await flush();
  assert.strictEqual(det.data.dish.name, "蒸鸡蛋羹");
  assert.deepStrictEqual(lastCall("title"), ["title", "蒸鸡蛋羹"]);
  ok("dish-edit 编辑：去掉成品照、改名、删步骤，详情页回来自动刷新");

  // ---- 同名提醒 ----
  const edit3 = newPage("pages/dish-edit/index");
  await edit3.onLoad({});
  edit3.onInput(ev({ field: "name" }, { value: "番茄炒蛋" }));
  modalAnswers.push({ confirm: false });
  await edit3.onSave();
  assert.strictEqual(cloudDB.dishes.length, 12, "同名时选了取消就不保存");
  assert.strictEqual(lastCall("modal")[1], "已经有一道「番茄炒蛋」了");
  ok("dish-edit 同名提醒");

  // ---- 选照片失败：隐私指引没配置 ----
  chooseMediaFail = { errno: 112, errMsg: "chooseMedia:fail api scope is not declared in the privacy agreement" };
  await edit3.onChooseCover();
  assert.strictEqual(lastCall("modal")[1], "暂时不能选照片");
  assert.strictEqual(edit3.data.form.cover, "");
  const modals = countCalls("modal");
  chooseMediaFail = { errMsg: "chooseMedia:fail cancel" };
  await edit3.onChooseCover();
  assert.strictEqual(countCalls("modal"), modals, "自己取消选照片不弹提示");
  ok("选照片：隐私指引没配置时提示原因，取消不提示");

  // ---- 删除（从详情页进的编辑页，退回两层），点菜篮里也拿掉 ----
  menu.onPlus(ev({ id: saved._id }));
  pageStack = [menu, det];
  const edit4 = newPage("pages/dish-edit/index");
  pageStack.push(edit4);
  await edit4.onLoad({ id: saved._id });
  modalAnswers.push({ confirm: true });
  await edit4.onDelete();
  assert.deepStrictEqual(lastCall("navigateBack"), ["navigateBack", 2]);
  assert.strictEqual(cloudDB.dishes.length, 11);
  await flush();
  assert.deepStrictEqual(Object.keys(cloudFiles), [], "删菜时照片一起删");
  assert.ok(!(saved._id in planItems()), "删掉的菜从今日菜单拿掉");
  ok("dish-edit 删除：云数据库、云存储、点菜篮都清干净");

  // ---- 分类管理 ----
  const cats = newPage("pages/categories/index");
  await cats.refresh();
  assert.deepStrictEqual(cats.data.list.map((c) => `${c.name}${c.count}`), ["家常菜3", "硬菜2", "汤羹2", "凉菜2", "主食2"]);
  modalAnswers.push({ confirm: true, content: "早餐" });
  await cats.onAdd();
  await flush();
  assert.deepStrictEqual(cats.data.list.map((c) => c.name), ["家常菜", "硬菜", "汤羹", "凉菜", "主食", "早餐"]);
  modalAnswers.push({ confirm: true, content: "早餐" });
  await cats.onAdd();
  await flush();
  assert.strictEqual(lastCall("modal")[2], "已经有「早餐」这个分类了");
  modalAnswers.push({ confirm: true, content: "一二三四五六七八九" });
  await cats.onAdd();
  await flush();
  assert.strictEqual(lastCall("modal")[2], "分类名最多 8 个字");
  modalAnswers.push({ confirm: true, content: "早点" });
  await cats.onRename(ev({ index: 5 }));
  await flush();
  cats.onMove(ev({ index: 5, dir: -1 }));
  await flush();
  assert.deepStrictEqual(cats.data.list.map((c) => c.name), ["家常菜", "硬菜", "汤羹", "凉菜", "早点", "主食"]);
  assert.deepStrictEqual(
    cloudDB.categories.slice().sort((a, b) => a.sort - b.sort).map((c) => c.name),
    ["家常菜", "硬菜", "汤羹", "凉菜", "早点", "主食"],
    "云上的顺序也要改"
  );
  await cats.onRemove(ev({ index: 0 }));
  assert.strictEqual(lastCall("modal")[1], "还不能删");
  modalAnswers.push({ confirm: true });
  await cats.onRemove(ev({ index: 4 }));
  await flush();
  assert.deepStrictEqual(cats.data.list.map((c) => c.name), ["家常菜", "硬菜", "汤羹", "凉菜", "主食"]);
  menu.onShow();
  await flush();
  assert.deepStrictEqual(menu.data.categories.map((c) => c.name), ["家常菜", "硬菜", "汤羹", "凉菜", "主食"]);
  ok("categories：新建、重名/太长提示、改名、调顺序、有菜不能删、删空分类");

  // ---- 我的：统计、改过的示例菜不算示例、删除示例菜 ----
  const edit5 = newPage("pages/dish-edit/index");
  await edit5.onLoad({ id: idOf("番茄炒蛋") });
  edit5.onInput(ev({ field: "tips" }, { value: "我家喜欢多放糖。" }));
  await edit5.onSave();
  const mine = newPage("pages/mine/index");
  await mine.refresh();
  assert.deepStrictEqual(mine.data.stats, { total: 11, mastered: 5, cooked: 0 }, "次数按记录算，示例菜还没有记录");
  assert.strictEqual(mine.data.sampleCount, 10);
  modalAnswers.push({ confirm: true });
  await mine.onRemoveSamples();
  assert.deepStrictEqual(cloudDB.dishes.map((d) => d.name), ["番茄炒蛋"]);
  assert.strictEqual(mine.data.sampleCount, 0);
  assert.deepStrictEqual(lastCall("toast"), ["toast", "已删除 10 道示例菜"]);
  await flush();
  assert.deepStrictEqual(Object.keys(planItems()), [idOf("番茄炒蛋")], "删掉的示例菜从今日菜单拿掉");
  ok("mine：统计、删除示例菜（改过的留着）");

  // ---- 点菜单页，还没下单：菜篮里的菜只能看（加减在菜单页底部的菜篮里）+ 买菜清单 ----
  const today = newPage("pages/today/index");
  today.onShow();
  await flush();
  assert.deepStrictEqual([today.data.stage, today.data.items.map((i) => `${i.name}×${i.qty}`)], ["picking", ["番茄炒蛋×1"]]);
  assert.deepStrictEqual(show(today.data.shopping.buy), ["鸡蛋 3个", "番茄 2个", "葱 1根"]);
  today.onGoCheckout();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/checkout/index"], "「去下单」去确认点菜单");
  menu.onOpenCart();
  menu.onCartPlus(ev({ id: idOf("番茄炒蛋") }));
  await flush();
  await today.refresh();
  assert.strictEqual(today.data.count, 2);
  assert.deepStrictEqual(show(today.data.shopping.buy), ["鸡蛋 6个", "番茄 4个", "葱 2根"], "份数变了，用量跟着变");
  const eggKey = today.data.shopping.buy[0].key;
  const toggling = today.onToggleItem(ev({ key: eggKey }));
  assert.deepStrictEqual(
    [today.data.shopping.buy.map((i) => [i.name, i.checked]), today.data.shopping.buy[0].pop, today.data.shopping.done],
    [[["鸡蛋", true], ["番茄", false], ["葱", false]], true, 1],
    "点了先在原地打勾、划掉，「已买」马上跟着变"
  );
  await toggling;
  assert.deepStrictEqual(
    today.data.shopping.buy.map((i) => [i.name, i.checked]),
    [["番茄", false], ["葱", false], ["鸡蛋", true]],
    "点了马上显示买到了，沉到最下面"
  );
  modalAnswers.push({ confirm: true, content: "牛奶" });
  await today.onAddExtra();
  await flush();
  assert.deepStrictEqual(today.data.shopping.extras.map((x) => x.name), ["牛奶"]);
  assert.deepStrictEqual([today.data.shopping.done, today.data.shopping.total], [1, 7]);
  assert.strictEqual(planDoc().checked[eggKey], true, "买到了也存到云上");
  assert.deepStrictEqual(Object.values(planDoc().extras).map((x) => x.name), ["牛奶"]);
  today.onCopyList();
  const copied = lastCall("clipboard")[1];
  assert.ok(copied.startsWith("买菜清单（番茄炒蛋）\n· 番茄 4个\n· 葱 2根"), copied);
  assert.ok(!/鸡蛋/.test(copied) && /另外要买：\n· 牛奶/.test(copied), "买到了的不复制：" + copied);
  await today.onToggleItem(ev({ key: eggKey }));
  today.onRemoveExtra(ev({ key: today.data.shopping.extras[0].key }));
  await flush();
  assert.deepStrictEqual([planDoc().checked, planDoc().extras], [{}, {}]);
  // 清空：在菜单页底部的菜篮里
  modalAnswers.push({ confirm: true });
  await menu.onClearCart();
  await flush();
  await sheetClosed();
  assert.ok(/^点的菜都拿掉，买菜清单的勾选也清掉。这本里大家的都会清空。库存不受影响。$/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  assert.deepStrictEqual([menu.data.showCart, menu.data.basketCount, planItems()], [false, 0, {}], "清空了就收起来");
  await today.refresh();
  assert.strictEqual(today.data.stage, "empty");
  newPage("pages/logs/index").onShow();
  ok("点菜单页（还没下单）：菜篮里的菜只能看、去下单；在菜单页的菜篮里加减份数，用量跟着变；勾选、自己加的、清空，都存到云上");

  // ======== 做菜：先下单再开始做 ========
  const tomatoId = idOf("番茄炒蛋");
  pageStack = [menu];
  const det2 = newPage("pages/dish-detail/index");
  det2.onLoad({ id: tomatoId });
  await flush();
  pageStack.push(det2);
  // 还没下单：从菜谱点「开始做」，先把这道菜放进菜篮，去确认点菜单
  await det2.onStartCook();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", `/pages/checkout/index?start=${tomatoId}`]);
  assert.strictEqual(det2.data.qty, 1, "放进菜篮了");
  await flush();
  const coS = await openCheckout({ start: tomatoId });
  assert.deepStrictEqual([coS.data.starting, coS.data.items.map((i) => `${i.name}×${i.qty}`)], [true, ["番茄炒蛋×1"]], "按钮写着「确认下单，开始做」");
  // 没下单不能开始做
  const cook0 = newPage("pages/cook/index");
  await cook0.onLoad({ from: "basket" });
  assert.deepStrictEqual([cook0.data.notFound, cook0.data.emptyText, cook0.data.emptyDesc], [true, "还没下单", "先下单，再开始做"]);
  cook0.onGoCheckout();
  assert.deepStrictEqual(lastCall("redirectTo"), ["redirectTo", "/pages/checkout/index"]);
  // 下好单直接开始做这道菜
  await coS.onSubmit();
  assert.deepStrictEqual(lastCall("redirectTo"), ["redirectTo", `/pages/cook/index?from=basket&dish=${tomatoId}`]);
  await flush();
  assert.strictEqual(planDoc().order.no, 1, "这本的第一单");
  const cook = newPage("pages/cook/index");
  await cook.onLoad({ from: "basket", dish: tomatoId });
  cook.onShow();
  assert.deepStrictEqual(lastCall("keepScreenOn"), ["keepScreenOn", true], "做菜时屏幕常亮");
  assert.deepStrictEqual([cook.data.tab, cook.data.total, cook.data.stepLabel, cook.data.steps[0].timerText], [tomatoId, 5, "第 1 / 5 步", "00:30"], "直接打开这道菜");
  cook.onTimerMain(ev({ i: 0 }));
  cook.stopTicking(); // 测试里手动推进时间
  assert.deepStrictEqual([cook.data.steps[0].timerState, cook.data.steps[0].timerAction], ["running", "暂停"]);
  assert.strictEqual(lastCall("alertOn")[0], "alertOn", "有计时在走，退出前要问一下");
  cook.onNext();
  assert.strictEqual(cook.data.stepLabel, "第 2 / 5 步");
  cook.onSwipe({ detail: { current: 3 } });
  cook.onTimerMain(ev({ i: 3 }));
  cook.stopTicking();
  timeOffset += 10 * 1000;
  cook.tick();
  assertTimers(cook.data.running.map((r) => r.label), ["番茄炒蛋 · 第 1 步 00:20", "番茄炒蛋 · 第 4 步 01:50"]);
  cook.onTimerMain(ev({ i: 3 })); // 暂停第 4 步
  cook.stopTicking();
  const pausedText = cook.data.steps[3].timerText;
  assertTimers([pausedText], ["01:50"], "暂停时的读数");
  assert.deepStrictEqual([cook.data.steps[3].timerState, cook.data.steps[3].timerAction], ["paused", "继续"]);
  modalAnswers.push({ confirm: false }); // 时间到了：「知道了」
  timeOffset += 25 * 1000;
  cook.tick();
  await flush();
  assert.deepStrictEqual([cook.data.steps[0].timerState, cook.data.steps[0].timerText], ["done", "00:00"]);
  assert.ok(lastCall("vibrate") && lastCall("sound"), "时间到了要震动、响铃");
  assert.strictEqual(lastCall("sound")[1], "http://usr/ding.wav");
  assert.deepStrictEqual(lastCall("modal").slice(1), ["⏰ 时间到了", `番茄炒蛋 · 第 1 步：${rowOf("番茄炒蛋").steps[0].text.slice(0, 40)}`]);
  assert.strictEqual(cook.data.steps[3].timerText, pausedText, "暂停的计时不再走");
  cook.onTimerReset(ev({ i: 3 }));
  assert.deepStrictEqual([cook.data.steps[3].timerState, cook.data.steps[3].timerText], ["idle", "02:00"]);
  assert.strictEqual(lastCall("alertOff")[0], "alertOff");
  cook.onToggleIngredients();
  assert.deepStrictEqual(cook.data.dish.ingredientGroups.map((g) => g.label), ["主料", "辅料", "调料"]);
  cook.onToggleIngredients();
  cook.go(5);
  assert.strictEqual(cook.data.stepLabel, "最后一步做完了");
  cook.onHide();
  cook.onUnload();
  assert.deepStrictEqual(lastCall("keepScreenOn"), ["keepScreenOn", false]);
  // 改了主意：点菜单上「改一改」，最下面撤单。点的菜还在菜篮里，做菜的进度清掉；再下单还是 No.001（撤单不占号）
  const basketS = newPage("pages/today/index");
  basketS.onShow();
  await flush();
  assert.deepStrictEqual([basketS.data.stage, basketS.data.cooking], ["ordered", { done: 0, total: 1 }]);
  assert.deepStrictEqual(lastCall("badge"), ["badge", "1"], "下了单，「点菜单」Tab 上显示这单几份");
  basketS.onEditOrder();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/checkout/index?edit=1"]);
  const coE = await openCheckout({ edit: "1" });
  assert.deepStrictEqual([coE.data.editing, coE.data.orderNo, coE.data.form.meal], [true, "No.001", planDoc().order.meal], "改一改：原来填的都在");
  modalAnswers.push({ confirm: true });
  await coE.onCancelOrder();
  await flush();
  assert.ok(/编号还是这个。一起做的进度会清掉。$/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  assert.deepStrictEqual([!!planDoc().order, planItems(), lastCall("navigateBack")], [false, { [tomatoId]: 1 }, ["navigateBack", 1]]);
  assert.strictEqual(cacheOf("cook_session"), undefined, "做菜的进度清掉了");
  await basketS.refresh();
  assert.strictEqual(basketS.data.stage, "picking");
  await placeOrder();
  assert.strictEqual(planDoc().order.no, 1, "撤单不占号，再下单还是 No.001");
  // 已经下了单：从菜谱点另一道菜的「开始做」，问一下要不要加菜，加了直接打开那道菜
  const sideId = (await svc("dish").saveDish({ name: "清炒菠菜", categoryId: catOf("家常菜") }))._id;
  const det3 = newPage("pages/dish-detail/index");
  det3.onLoad({ id: sideId });
  await flush();
  modalAnswers.push({ confirm: true });
  await det3.onStartCook();
  assert.strictEqual(lastCall("modal")[1], "加菜一起做？");
  assert.ok(/加进点菜单 No\.001/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", `/pages/cook/index?from=basket&dish=${sideId}`]);
  await flush();
  assert.deepStrictEqual(Object.keys(planItems()).sort(), [tomatoId, sideId].sort(), "加进了这单");
  svc("plan").clear();
  await svc("dish").removeDish(sideId);
  await flush();
  ok("做菜：先下单再开始做（从菜谱点「开始做」先去下单，下好单直接开始做那道；已经下了单就问要不要加菜）、计时、看原料；「改一改」里撤单，进度清掉、编号不占");

  // ======== 打卡 ========
  menu.onPlus(ev({ id: tomatoId }));
  await flush();
  const le = newPage("pages/log-edit/index");
  pageStack = [menu, det2, le];
  await le.onLoad({ dishId: tomatoId });
  assert.deepStrictEqual([le.data.dishLocked, le.data.dishName, le.data.isEdit], [true, "番茄炒蛋", false]);
  assert.deepStrictEqual([le.data.showPlanOption, le.data.removeFromPlan], [true, true], "在今日菜单里的菜，默认划掉");
  await le.onChoosePhoto();
  assert.deepStrictEqual([le.data.showCoverOption, le.data.useAsCover], [true, true], "菜还没有成品照，默认用这张");
  le.onStarTap(ev({ value: 4 }));
  le.onInput(ev({ field: "note" }, { value: "番茄选熟一点的更好吃" }));
  le.onInput(ev({ field: "cook" }, { value: "小亮" }));
  await le.onSave();
  assert.strictEqual(cloudDB.cook_logs.length, 1);
  const logA = cloudDB.cook_logs[0];
  assert.deepStrictEqual([logA.dishId, logA.dishName, logA.rating, logA.note, logA.cook], [tomatoId, "番茄炒蛋", 4, "番茄选熟一点的更好吃", "小亮"]);
  assert.ok(/\/logs\//.test(logA.photo) && /\/thumbs\//.test(logA.photoThumb), "打卡照片传到云存储");
  assert.strictEqual((await dishNow("番茄炒蛋")).cookCount, 1, "做过几次 = 记录条数");
  assert.ok(Math.abs((await dishNow("番茄炒蛋")).lastCookedAt - Date.now()) < 1000, "上次做是今天");
  assert.ok(/\/covers\//.test(rowOf("番茄炒蛋").cover) && rowOf("番茄炒蛋").cover !== logA.photo, "另外传一份当菜的成品照");
  await flush();
  assert.ok(!(tomatoId in planItems()), "从今日菜单里划掉了");
  assert.deepStrictEqual(lastCall("toast"), ["toast", "打卡成功！做过 1 次了"]);
  assert.deepStrictEqual(lastCall("navigateBack"), ["navigateBack", 1]);
  assert.strictEqual(dev().dev_cook_name, "小亮", "记住这台手机的掌勺人");
  det2.onShow();
  await flush();
  assert.deepStrictEqual([det2.data.logCount, det2.data.logs[0].stars, det2.data.dish.cookLine.slice(0, 6)], [1, "★★★★☆", "做过 1 次"]);

  // 在「记录」页补一条以前的：自己选菜、选日期
  const le2 = newPage("pages/log-edit/index");
  await le2.onLoad({});
  assert.deepStrictEqual([le2.data.dishLocked, le2.data.form.cook], [false, "小亮"]);
  le2.onOpenDishPicker();
  assert.strictEqual(le2.data.showDishPicker, true, "点「做的菜」弹出选菜面板");
  await le2.onDishPicked({ detail: { id: tomatoId } });
  assert.deepStrictEqual([le2.data.showDishPicker, le2.data.form.dishId, le2.data.dishName], [false, tomatoId, "番茄炒蛋"]);
  const { dateValue } = require(path.join(root, "utils/log"));
  const oldDay = dateValue(Date.now() - 40 * 86400 * 1000);
  le2.onDateChange({ detail: { value: oldDay } });
  await le2.onSave();
  assert.strictEqual(cloudDB.cook_logs.length, 2);
  const logB = cloudDB.cook_logs.find((l) => l._id !== logA._id);
  assert.strictEqual(dateValue(logB.cookedAt), oldDay);
  assert.strictEqual((await dishNow("番茄炒蛋")).cookCount, 2);
  assert.ok(Math.abs((await dishNow("番茄炒蛋")).lastCookedAt - logA.cookedAt) < 1000, "补记以前的，「上次做」还是最近那次");

  const logsPage = newPage("pages/logs/index");
  logsPage.onShow();
  await flush();
  {
    const { summarize } = require(path.join(root, "utils/stats"));
    const thisMonth = { kind: "month", year: new Date(Date.now()).getFullYear(), month: new Date(Date.now()).getMonth() };
    const [statLogs, statDishes] = [await svc("log").listLogs(), await svc("dish").listDishes()];
    assert.deepStrictEqual(
      [summarize(statLogs, statDishes, thisMonth, Date.now()).count, summarize(statLogs, statDishes, { kind: "all" }, Date.now()).count, summarize(statLogs, statDishes, { kind: "all" }, Date.now()).dishCount],
      [1, 2, 1],
      "这个月 1 次，一共 2 次，1 道菜"
    );
  }
  assert.strictEqual(logsPage.data.months.length, 2, "按月份分组");
  assert.deepStrictEqual(
    [logsPage.data.months[0].days[0].logs[0].dishName, logsPage.data.months[0].days[0].logs[0].cook],
    ["番茄炒蛋", "小亮"]
  );

  // 改一条、删一条
  const le3 = newPage("pages/log-edit/index");
  await le3.onLoad({ id: logB._id });
  assert.deepStrictEqual([le3.data.isEdit, le3.data.form.date], [true, oldDay]);
  le3.onStarTap(ev({ value: 3 }));
  le3.onStarTap(ev({ value: 3 })); // 再点一下同一颗星 = 不打分
  le3.onInput(ev({ field: "note" }, { value: "第一次做，有点咸" }));
  await le3.onSave();
  assert.deepStrictEqual([logB.rating, logB.note, (await dishNow("番茄炒蛋")).cookCount], [0, "第一次做，有点咸", 2]);
  const le4 = newPage("pages/log-edit/index");
  await le4.onLoad({ id: logB._id });
  modalAnswers.push({ confirm: true });
  await le4.onDelete();
  assert.strictEqual(cloudDB.cook_logs.length, 1);
  assert.strictEqual((await dishNow("番茄炒蛋")).cookCount, 1, "删一条记录，次数 -1");
  ok("打卡：照片、打分、心得、掌勺；次数和上次做的日期跟着变；补记、修改、删除；记录页按月分组");

  // ======== 数据导出 ========
  const exp = newPage("pages/export/index");
  await exp.onLoad();
  assert.deepStrictEqual(exp.data.summary, { categoryCount: 5, dishCount: 1, logCount: 1, photoCount: 2 });
  await exp.onBuild();
  assert.strictEqual(exp.data.status, "ready");
  const exported = JSON.parse(files[exp.data.file.filePath]);
  assert.deepStrictEqual(
    [exported.app, exported.categories.length, exported.dishes.length, exported.logs.length, Object.keys(exported.photos).length],
    ["nashoucai-xiaobenben", 5, 1, 1, 0]
  );
  exp.onTogglePhotos();
  assert.strictEqual(exp.data.status, "idle", "换了选项要重新生成");
  await exp.onBuild();
  const withPhotos = JSON.parse(files[exp.data.file.filePath]);
  assert.deepStrictEqual(Object.keys(withPhotos.photos).sort(), [rowOf("番茄炒蛋").cover, logA.photo].sort());
  assert.strictEqual(Buffer.from(withPhotos.photos[logA.photo], "base64").toString(), `照片内容:${logA.photo}`);
  exp.onSend();
  assert.ok(/^拿手菜小本本备份-我们家的小本本-\d{8}\.json$/.test(lastCall("shareFile")[1]), lastCall("shareFile")[1]);
  ok(`导出：不带照片 / 带 2 张照片，发到聊天（${exp.data.file.sizeText}）`);

  // ======== 两个人共用 ========

  // 我先点一道菜，等会儿看对方那边能不能看到
  menu.onPlus(ev({ id: idOf("番茄炒蛋") }));
  await flush();

  // 对方的手机：第一次打开新版本，先是只有自己的「我的小本本」；用家庭码申请加入，我同意了才看得到
  launchApp("partner");
  const pMenu0 = newPage("pages/menu/index");
  await pMenu0.onLoad();
  await flush();
  assert.deepStrictEqual([pMenu0.data.status, pMenu0.data.book.shortName, pMenu0.data.book.initial], ["welcome", "我的", "我"], "对方先是自己的个人本本");
  assert.ok(/只有你能看的「我的小本本」/.test(pMenu0.data.welcomeHint), pMenu0.data.welcomeHint);
  await assert.rejects(svc("api").call("load", { bookId: testBookId }), (e) => e.code === "NOT_MEMBER", "还没加入，读不到");
  // 菜单左上角 → 切换小本本 → 输入家庭码加入
  pMenu0.onOpenBooks();
  assert.strictEqual(pMenu0.data.showBooks, true);
  const pSheet = newComponent("components/book-sheet/index", { show: true });
  await flush();
  assert.deepStrictEqual(pSheet.data.books.map((b) => `${b.name}${b.current ? "（正在用）" : ""}`), ["我的小本本（正在用）"]);
  pSheet.onJoin();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/join/index"]);
  const join = newPage("pages/join/index");
  join.onLoad({});
  const familyCode = cloudDB.books.find((b) => b._id === testBookId).code;
  // 认错字了：家庭码里没有 0、O、1、I、L，不用去云上查，也不算输错一次
  const callsBeforeCode = countCalls("callFunction");
  assert.strictEqual(join.onCodeInput({ detail: { value: "ab0cd1" } }), "AB0CD1", "输入框里换成大写");
  await flush();
  assert.ok(/没有 0、O、1、I、L/.test(join.data.error) && countCalls("callFunction") === callsBeforeCode, join.data.error);
  // 输错了：说还能试几次
  join.onCodeInput({ detail: { value: "zzzzzz" } });
  await flush();
  assert.ok(/^没找到这个家庭码，再核对一下（还能试 9 次）$/.test(join.data.error), join.data.error);
  // 对了（小写、中间有空格也行）：先看到是哪一本、几个人、几道菜、本主是谁
  join.onCodeInput({ detail: { value: `${familyCode.slice(0, 3).toLowerCase()} ${familyCode.slice(3)}` } });
  await flush();
  const familyDishCount = cloudDB.dishes.filter((d) => d.bookId === testBookId).length;
  assert.deepStrictEqual([join.data.found.name, join.data.found.sub, join.data.status], ["我们家的小本本", `1 位成员 · ${familyDishCount} 道菜 · 本主 小亮`, ""]);
  join.onNameInput({ detail: { value: " " } });
  await join.onRequest();
  assert.deepStrictEqual(lastCall("toast"), ["toast", "写个名字，本主才知道是谁"]);
  join.onNameInput({ detail: { value: "小鱼" } });
  await join.onRequest();
  assert.strictEqual(join.data.status, "pending", "申请了，等本主同意");
  await assert.rejects(svc("api").call("load", { bookId: testBookId }), (e) => e.code === "NOT_MEMBER", "申请了也还读不到");
  const pSheet2 = newComponent("components/book-sheet/index", { show: true });
  await flush();
  assert.deepStrictEqual(pSheet2.data.pending.map((b) => b.name), ["我们家的小本本"], "切换面板里写着在等本主同意");

  // 我这边：「我的」上有小红点，名片上写着有人申请；在小本本设置里同意
  launchApp("me");
  const meMine = newPage("pages/mine/index");
  meMine.onShow();
  await flush();
  assert.deepStrictEqual(lastCall("redDot"), ["redDot", 3, true], "「我的」上有小红点");
  assert.deepStrictEqual([meMine.data.book.name, meMine.data.requestText], ["我们家的小本本", "1 个人申请加入这本"]);
  meMine.onOpenRequests();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", `/pages/book/index?id=${testBookId}`]);
  const meSettings = newPage("pages/book/index");
  meSettings.onLoad({ id: testBookId });
  meSettings.onShow();
  await flush();
  assert.deepStrictEqual(meSettings.data.requests.map((r) => r.label), ["小鱼"], "本主看得到申请");
  await meSettings.onApprove(ev({ id: meSettings.data.requests[0].id }));
  assert.deepStrictEqual(
    meSettings.data.members.map((m) => `${m.label}${m.owner ? "（本主）" : ""}${m.me ? "（我）" : ""}`),
    ["小亮（本主）（我）", "小鱼"]
  );
  assert.deepStrictEqual([meSettings.data.requests.length, lastCall("redDot")], [0, ["redDot", 3, false]]);
  assert.deepStrictEqual(lastCall("toast"), ["toast", "同意了，TA 打开小程序就能看到这本"]);

  // 对方再打开：收到「加入成功」，点「切换过去」
  launchApp("partner");
  modalAnswers.push({ confirm: true });
  const pMenu = newPage("pages/menu/index");
  await pMenu.onLoad();
  await flush();
  assert.ok(calls.some((c) => c[0] === "modal" && c[1] === "加入成功" && /「我们家的小本本」的本主同意了/.test(c[2])), "对方收到通知");
  assert.strictEqual(svc("book").currentId(), testBookId, "点了「切换过去」");

  // 对方切过来：看到同一本菜谱、同一份菜篮，能加菜，也能改我加的菜
  assert.strictEqual(pMenu.data.status, "ready", "对方打开看到的是同一本菜谱，不是欢迎页");
  assert.deepStrictEqual(pMenu.allDishes.map((d) => d.name), ["番茄炒蛋"]);
  assert.strictEqual(pMenu.data.basketCount, 1, "今日菜单两个人共用");
  const pLogs = newPage("pages/logs/index");
  pLogs.onShow();
  await flush();
  assert.deepStrictEqual(
    [pLogs.data.months.reduce((n, m) => n + m.count, 0), pLogs.data.months[0].days[0].logs[0].cook],
    [1, "小亮"],
    "对方也看得到我的做菜记录"
  );
  pMenu.onPlus(ev({ id: idOf("番茄炒蛋") }));
  const pToday = newPage("pages/today/index");
  pToday.onShow();
  await flush();
  pToday.onToggleItem(ev({ key: pToday.data.shopping.buy[1].key })); // 对方在超市买到了番茄
  await flush();
  assert.deepStrictEqual(planItems(), { [idOf("番茄炒蛋")]: 2 });
  const pEdit = newPage("pages/dish-edit/index");
  await pEdit.onLoad({ categoryId: catOf("主食") });
  pEdit.onInput(ev({ field: "name" }, { value: "红糖糍粑" }));
  await pEdit.onSave();
  const pEdit2 = newPage("pages/dish-edit/index");
  await pEdit2.onLoad({ id: idOf("番茄炒蛋") });
  pEdit2.onInput(ev({ field: "tips" }, { value: "对方说：最后撒点葱花更香。" }));
  await pEdit2.onSave();
  assert.strictEqual(rowOf("番茄炒蛋").tips, "对方说：最后撒点葱花更香。");
  assert.strictEqual(rowOf("红糖糍粑").bookId, testBookId);
  ok("对方：打开就是同一本菜谱，能加菜，也能改我加的菜");

  // 回到我的手机：重新打开，先显示缓存，再换成云上最新的（看得到对方的改动）
  launchApp("me");
  const menu2 = newPage("pages/menu/index");
  const loading = menu2.onLoad();
  assert.strictEqual(menu2.data.status, "loading");
  await loading;
  await flush();
  assert.deepStrictEqual(menu2.allDishes.map((d) => d.name), ["番茄炒蛋", "红糖糍粑"]);
  assert.strictEqual(menu2.allDishes[0].tips, "对方说：最后撒点葱花更香。");
  assert.strictEqual(menu2.data.basketCount, 2, "对方加的那份我这边也看得到");
  const myToday = newPage("pages/today/index");
  myToday.onShow();
  await flush();
  assert.deepStrictEqual(
    myToday.data.shopping.buy.filter((i) => i.checked).map((i) => i.name),
    ["番茄"],
    "对方勾掉的番茄，我这边也显示买到了"
  );

  // 两个人几乎同时点不同的菜：对方那边刚加了红糖糍粑（还没同步到我这），我再加一份番茄炒蛋，两边的都不会丢
  partnerWrites(() => {
    planDoc().items[idOf("红糖糍粑")] = 1;
  });
  menu2.onPlus(ev({ id: idOf("番茄炒蛋") }));
  await flush();
  assert.deepStrictEqual(planItems(), { [idOf("番茄炒蛋")]: 3, [idOf("红糖糍粑")]: 1 });
  await menu2.onPullRefresh();
  assert.strictEqual(menu2.data.basketCount, 4);

  // 小程序开着的时候对方又加了一道：马上回到菜单不去云上查，隔 15 秒以上回来就会刷出来
  partnerWrites(() =>
    cloudDB.dishes.push({ _id: "p1", bookId: testBookId, name: "酸辣土豆丝", categoryId: catOf("家常菜"), createdAt: Date.now() })
  );
  menu2.onShow();
  await flush();
  assert.strictEqual(menu2.allDishes.length, 2, "刚同步过，不重复去云上查");
  timeOffset += 20 * 1000;
  menu2.onShow();
  await flush();
  assert.deepStrictEqual(menu2.allDishes.map((d) => d.name), ["番茄炒蛋", "红糖糍粑", "酸辣土豆丝"]);

  // 下拉刷新：马上取最新的
  partnerWrites(() => {
    rowOf("酸辣土豆丝").name = "醋溜土豆丝";
  });
  await menu2.onPullRefresh();
  assert.ok(menu2.allDishes.some((d) => d.name === "醋溜土豆丝"));
  assert.strictEqual(menu2.data.refreshing, false);
  ok("我：看得到对方的改动（重新打开、隔一会儿回到页面、下拉刷新）");

  // 同时改同一道菜：我打开编辑页之后对方先保存了，我再保存时要问一下
  const edit6 = newPage("pages/dish-edit/index");
  await edit6.onLoad({ id: idOf("番茄炒蛋") });
  partnerWrites(() => {
    rowOf("番茄炒蛋").tips = "对方刚改的";
    rowOf("番茄炒蛋").updatedAt = Date.now();
  });
  edit6.onInput(ev({ field: "tips" }, { value: "我改的" }));
  const backs = countCalls("navigateBack");
  modalAnswers.push({ confirm: false });
  await edit6.onSave();
  assert.strictEqual(lastCall("modal")[1], "这道菜刚被改过");
  assert.strictEqual(rowOf("番茄炒蛋").tips, "对方刚改的", "选了不覆盖就不保存");
  assert.strictEqual(countCalls("navigateBack"), backs, "不覆盖时留在编辑页");
  modalAnswers.push({ confirm: true });
  await edit6.onSave();
  assert.strictEqual(rowOf("番茄炒蛋").tips, "我改的", "选了覆盖就用我的");
  assert.strictEqual(countCalls("navigateBack"), backs + 1);

  // 我在改的时候对方把这道菜删了
  const edit7 = newPage("pages/dish-edit/index");
  await edit7.onLoad({ id: idOf("红糖糍粑") });
  partnerWrites(() => cloudDB.dishes.splice(cloudDB.dishes.indexOf(rowOf("红糖糍粑")), 1));
  edit7.onInput(ev({ field: "tips" }, { value: "蘸黄豆粉" }));
  await edit7.onSave();
  assert.deepStrictEqual(lastCall("modal").slice(1), ["保存失败", "这道菜已经被删掉了，可能是家人刚删的"]);
  ok("同时改：对方先保存了会问要不要覆盖；对方删掉了会提示");

  // 没网：有缓存就先显示缓存
  launchApp("me");
  offline = true;
  const menu3 = newPage("pages/menu/index");
  await menu3.onLoad();
  await flush();
  assert.strictEqual(menu3.data.status, "ready");
  assert.ok(menu3.allDishes.length >= 2);
  assert.deepStrictEqual(lastCall("toast"), ["toast", "网络不太好，先显示上次的菜谱"]);
  offline = false;
  ok("没网时显示上次的缓存");

  // ======== 每本分开：别的本里的东西读不到、改不了（改了小程序代码直接调云函数也不行） ========
  launchApp("me");
  const myPersonalId = cloudDB.users.find((u) => u._id === "me").personalBookId;
  const secret = await svc("api").call("add", { bookId: myPersonalId, collection: "dishes", data: { name: "私房红烧肉", createdAt: Date.now() } });
  assert.strictEqual(cloudDB.dishes.find((d) => d._id === secret._id).bookId, myPersonalId);
  launchApp("partner");
  const herApi = svc("api");
  await assert.rejects(herApi.call("load", { bookId: myPersonalId }), (e) => e.code === "NOT_MEMBER" && e.message === "你已经不在这本小本本里了");
  await assert.rejects(herApi.call("add", { bookId: myPersonalId, collection: "dishes", data: { name: "偷偷加的" } }), (e) => e.code === "NOT_MEMBER");
  // 拿着我个人本本里那道菜的 id，从我们共用的那本去读、改、删：都当作没有
  assert.strictEqual(await herApi.call("get", { bookId: testBookId, collection: "dishes", id: secret._id }), null);
  assert.deepStrictEqual(await herApi.call("update", { bookId: testBookId, collection: "dishes", id: secret._id, data: { name: "改了" } }), { updated: 0 });
  assert.deepStrictEqual(await herApi.call("remove", { bookId: testBookId, collection: "dishes", id: secret._id }), { removed: 0 });
  await assert.rejects(herApi.call("update", { bookId: testBookId, collection: "dishes", id: idOf("番茄炒蛋"), data: { bookId: myPersonalId } }), (e) => e.code === "BAD_INPUT", "不能把菜挪到别的本");
  await assert.rejects(herApi.call("get", { bookId: testBookId, collection: "users", id: "me" }), (e) => e.code === "BAD_INPUT", "users、books 小程序碰不到");
  assert.strictEqual(cloudDB.dishes.find((d) => d._id === secret._id).name, "私房红烧肉");
  // 照片也一样：我个人本本里的照片，对方换不到链接、删不掉
  const secretPhoto = `cloud://test-env.1234/books/${myPersonalId}/covers/secret.jpg`;
  cloudFiles[secretPhoto] = { owner: "me", path: "http://tmp/secret.jpg" };
  const denied = await herApi.call("urls", { fileIDs: [secretPhoto] });
  assert.deepStrictEqual([denied.urls, denied.denied], [{}, [secretPhoto]]);
  await herApi.call("removeFiles", { fileIDs: [secretPhoto] });
  assert.ok(cloudFiles[secretPhoto], "删不掉别的本里的照片");
  await assert.rejects(herApi.call("readFile", { fileID: secretPhoto }), (e) => e.code === "NOT_MEMBER");
  // 不认识的操作
  await assert.rejects(herApi.call("dropDatabase", {}), (e) => e.code === "BAD_ACTION");
  launchApp("me");
  await svc("api").call("remove", { bookId: myPersonalId, collection: "dishes", id: secret._id });
  delete cloudFiles[secretPhoto];
  ok("每本分开：读不到、改不了、删不掉别的本里的菜和照片，也不能把菜挪到别的本");

  // ======== 云函数 api 还没部署、集合还没建 ========

  // 没缓存、云函数还没部署：说清楚怎么部署；部署好以后点重试
  devices.me = {};
  apiDeployed = false;
  launchApp("me");
  const menu4 = newPage("pages/menu/index");
  await menu4.onLoad();
  assert.strictEqual(menu4.data.status, "error");
  assert.ok(/^云函数 api 还没部署：.*右键 api 文件夹.*上传并部署：云端安装依赖/.test(menu4.data.errorText), menu4.data.errorText);
  apiDeployed = true;
  menu4.onRetry();
  await flush();
  assert.strictEqual(menu4.data.status, "ready");
  assert.strictEqual(svc("book").currentId(), testBookId, "部署好以后接着进上次用的那本");
  ok("云函数没部署：提示怎么部署，部署好以后重试正常");

  // 「我的 → 检查一下云开发」：集合没建的，云函数自己建上；建不了的写明是哪个；还看得出数据库权限收紧了没有
  delete cloudDB.plans;
  serverCanCreate = false;
  const mineCheck = newPage("pages/mine/index");
  await mineCheck.onCheckDatabase();
  let checkReport = lastCall("modal")[2];
  assert.strictEqual(lastCall("modal")[1], "云开发检查");
  assert.ok(/✅ 云函数 api：正常/.test(checkReport) && /✅ dishes：正常/.test(checkReport) && /❌ plans：还没建/.test(checkReport), checkReport);
  assert.ok(/⚠️ 数据库权限：还是谁都能直接读写/.test(checkReport) && /所有用户不可读写/.test(checkReport), checkReport);
  serverCanCreate = true;
  permission = "locked";
  await mineCheck.onCheckDatabase();
  checkReport = lastCall("modal")[2];
  assert.ok(/✅ plans：刚刚自动建好了/.test(checkReport) && /🔒 数据库权限：只有云函数能读写/.test(checkReport) && /都正常$/.test(checkReport), checkReport);
  assert.ok(Array.isArray(cloudDB.plans));
  permission = "shared";
  ok("检查一下云开发：云函数、每个集合（没建的自动建上）、照片、数据库权限");

  // plans 集合没建：点菜时云函数自己建上；建不了的话，弹窗说明怎么建，同样的问题只弹一次，之后是轻提示
  delete cloudDB.plans;
  devices.me = {};
  launchApp("me");
  const menuAuto = newPage("pages/menu/index");
  await menuAuto.onLoad();
  menuAuto.onPlus(ev({ id: "x1" }));
  await flush();
  assert.deepStrictEqual(planItems(), { x1: 1 }, "集合自动建上，点的菜存上了");
  delete cloudDB.plans;
  serverCanCreate = false;
  devices.me = {};
  launchApp("me");
  const menu5 = newPage("pages/menu/index");
  await menu5.onLoad();
  await flush();
  assert.strictEqual(menu5.data.status, "ready");
  menu5.onPlus(ev({ id: "x1" }));
  await flush();
  assert.strictEqual(lastCall("modal")[1], "菜篮没存上");
  assert.ok(/还没有 plans 集合.*所有用户不可读写/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  const modalCount = countCalls("modal");
  menu5.onPlus(ev({ id: "x1" }));
  await flush();
  assert.strictEqual(countCalls("modal"), modalCount, "同样的问题只弹一次窗");
  assert.deepStrictEqual(lastCall("toast"), ["toast", "菜篮没同步上，稍后再试"]);
  ok("plans 集合没建：云函数自己建上；建不了时菜单照样能用，点菜时提示怎么建");

  // 只有 cook_logs 集合没建（云函数也建不了）：菜单、记录页照样能打开；打卡时提示怎么建
  cloudDB.plans = [];
  delete cloudDB.cook_logs;
  cloudDB.dishes.push({ _id: "d-x", bookId: testBookId, name: "清炒时蔬", categoryId: catOf("家常菜"), createdAt: Date.now() });
  devices.me = {};
  launchApp("me");
  const menu6 = newPage("pages/menu/index");
  await menu6.onLoad();
  assert.strictEqual(menu6.data.status, "ready");
  const logs6 = newPage("pages/logs/index");
  logs6.onShow();
  await flush();
  assert.deepStrictEqual([logs6.data.loaded, logs6.data.months.length], [true, 0]);
  const le6 = newPage("pages/log-edit/index");
  await le6.onLoad({ dishId: "d-x" });
  await le6.onSave();
  assert.strictEqual(lastCall("modal")[1], "保存失败");
  assert.ok(/cook_logs/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  ok("cook_logs 集合没建：照样能看菜谱和记录页，打卡时提示怎么建");
  serverCanCreate = true;

  // ======== 导入 6 道菜（tests/fixtures 里的文件，照片换成了很小的图） ========
  const importFile = path.join(__dirname, "fixtures", "six-dishes.json");
  files["http://tmp/import.json"] = fs.readFileSync(importFile, "utf8");
  nextMessageFile = { path: "http://tmp/import.json", name: "拿手菜-6道菜.json" };
  cloudDB.categories = [];
  cloudDB.dishes = [];
  cloudDB.plans = [];
  cloudDB.cook_logs = [];
  Object.keys(cloudFiles).forEach((k) => delete cloudFiles[k]);
  devices.me = {};
  launchApp("me");
  await newPage("pages/menu/index").onImportSamples(); // 先有一本示例菜谱，看导入会不会跟它打架
  const imp = newPage("pages/import/index");
  imp.onChoose();
  await flush();
  assert.deepStrictEqual(
    [imp.data.status, imp.data.file.dishCount, imp.data.file.newCount, imp.data.file.logCount, imp.data.file.photoCount],
    ["ready", 6, 6, 6, 7]
  );
  await imp.onImport();
  assert.strictEqual(imp.data.status, "done");
  assert.deepStrictEqual(imp.data.result, { added: 6, skipped: 0, logsAdded: 6, logsError: "" });
  const imported = ["莴笋炒肉", "奥尔良鸡翅（空气炸锅版）", "番茄鸡蛋汤", "经典小梁汤面", "土豆肉丝炒饭", "台式卤肉饭"].map(rowOf);
  assert.ok(imported.every((d) => d && /\/covers\//.test(d.cover) && /\/thumbs\//.test(d.coverThumb)), "6 道菜都有成品照");
  assert.deepStrictEqual(imported.map((d) => cloudDB.categories.find((c) => c._id === d.categoryId).name), ["家常菜", "硬菜", "汤羹", "主食", "主食", "主食"]);
  assert.strictEqual(cloudDB.categories.length, 5, "分类按名字对上，没有多建");
  const importedNow = await Promise.all(imported.map((d) => dishNow(d.name)));
  assert.deepStrictEqual(importedNow.map((d) => d.cookCount), [1, 1, 1, 2, 1, 0], "次数按记录算：卤肉饭没有记录就是 0");
  assert.strictEqual(new Date(importedNow[3].lastCookedAt).toISOString(), "2026-09-29T10:55:00.000Z");
  assert.strictEqual(rowOf("台式卤肉饭").steps.length, 8);
  assert.strictEqual(cloudDB.cook_logs.length, 6);
  assert.ok(cloudDB.cook_logs.every((l) => /\/logs\//.test(l.photo)), "做菜记录也带上照片");
  assert.ok(imported.every((d) => cloudDB.cook_logs.every((l) => l.photo !== d.cover)), "记录的照片和菜的成品照是两份，删记录不会删封面");
  assert.strictEqual(Object.keys(files).filter((k) => /import-/.test(k)).length, 0, "导入时写的临时照片删掉了");
  const today6 = newPage("pages/menu/index");
  await today6.onLoad();
  assert.strictEqual(today6.allDishes.length, 17, "11 道示例菜 + 6 道新菜");
  today6.onSearchInput({ detail: { value: "空气炸锅" } });
  assert.deepStrictEqual(today6.data.searchResults.map((d) => d.name), ["奥尔良鸡翅（空气炸锅版）"], "按标签搜得到");
  const lettuceDetail = newPage("pages/dish-detail/index");
  lettuceDetail.onLoad({ id: idOf("莴笋炒肉") });
  await flush();
  assert.deepStrictEqual([lettuceDetail.data.logCount, lettuceDetail.data.dish.cookLine], [1, "做过 1 次 · 上次 10月2日"]);

  // 再导入一次：全都跳过，不会重复
  const imp2 = newPage("pages/import/index");
  imp2.onChoose();
  await flush();
  assert.deepStrictEqual([imp2.data.file.newCount, imp2.data.file.skipNames.length], [0, 6]);
  await imp2.onImport();
  assert.deepStrictEqual(lastCall("toast"), ["toast", "这些菜都已经有了"]);
  const importService = require(path.join(root, "services/import"));
  const again = await importService.importData((await importService.readFile("http://tmp/import.json")).data);
  assert.deepStrictEqual(again, { added: 0, skipped: 6, logsAdded: 0, logsError: "" });
  assert.deepStrictEqual([cloudDB.dishes.length, cloudDB.cook_logs.length], [17, 6]);

  // cook_logs 集合没建（云函数也建不了）：菜照样导进来，提示记录没导进去；建好集合再导一次，记录补上、次数不会多算
  cloudDB.categories = [];
  cloudDB.dishes = [];
  delete cloudDB.cook_logs;
  serverCanCreate = false;
  devices.me = {};
  launchApp("me");
  const imp3 = newPage("pages/import/index");
  imp3.onChoose();
  await flush();
  await imp3.onImport();
  assert.deepStrictEqual([imp3.data.result.added, imp3.data.result.logsAdded], [6, 0]);
  assert.strictEqual(lastCall("modal")[1], "菜谱导进来了，做菜记录没导进去");
  cloudDB.cook_logs = [];
  serverCanCreate = true;
  const imp4 = newPage("pages/import/index");
  imp4.onChoose();
  await flush();
  // 重新打开过小程序，要拿这次打开时的模块
  const retry = await require(path.join(root, "services/import")).importData(imp4.importing);
  assert.deepStrictEqual([retry.added, retry.logsAdded], [0, 6]);
  assert.strictEqual((await dishNow("经典小梁汤面")).cookCount, 2, "补上记录以后次数还是 2，不会多算");
  nextMessageFile = null;
  ok("导入 6 道菜：照片、分类、做菜记录、次数都对；重复导入不重复；记录集合没建时能补导");

  // ======== 卤肉饭：次数按记录算（以前导入时记了 1 次、再打卡会变成 2 次） ========
  assert.strictEqual((await dishNow("台式卤肉饭")).cookCount, 0);
  const leL = newPage("pages/log-edit/index");
  await leL.onLoad({ dishId: idOf("台式卤肉饭") });
  await leL.onSave();
  assert.strictEqual((await dishNow("台式卤肉饭")).cookCount, 1, "打一次卡就是 1 次，跟记录对得上");
  ok("次数按记录算：卤肉饭打一次卡就是 1 次");

  // ======== 库存 ========
  const pantryPage = newPage("pages/pantry/index");
  pantryPage.onShow();
  assert.deepStrictEqual([pantryPage.data.inStock.length, pantryPage.data.presets.includes("生抽")], [0, true]);
  pantryPage.onAddAllPresets();
  await flush();
  assert.strictEqual(pantryPage.data.inStock.length, 16);
  pantryPage.onInput({ detail: { value: "米、面粉 ,鸡蛋" } });
  pantryPage.onAdd();
  await flush();
  assert.strictEqual(pantryPage.data.inStock.length, 19);
  assert.strictEqual(Object.keys(sharedDoc("pantry").items).length, 19, "库存存到云上");

  svc("plan").clear();
  svc("plan").add(idOf("莴笋炒肉"));
  const basketPage = newPage("pages/today/index");
  basketPage.onShow();
  await flush();
  assert.deepStrictEqual(basketPage.data.shopping.buy.map((i) => i.name), ["莴笋", "猪里脊", "蒜", "葱"]);
  assert.deepStrictEqual([basketPage.data.shopping.unknown.length, basketPage.data.shopping.stocked.length], [0, 7], "调料家里都有，不用提醒");
  await basketPage.onHaveIt(ev({ name: "蒜" }));
  assert.deepStrictEqual(basketPage.data.shopping.buy.map((i) => i.name), ["莴笋", "猪里脊", "葱"]);
  await basketPage.onRanOut(ev({ key: keyOf("生抽") }));
  assert.deepStrictEqual(
    basketPage.data.shopping.buy.filter((i) => i.outOfStock).map((i) => i.name),
    ["生抽"],
    "用完了的回到要买的，标「家里用完了」"
  );
  pantryPage.onShow();
  assert.deepStrictEqual(pantryPage.data.outOfStock.map((i) => i.name), ["生抽"]);
  pantryPage.onRestock(ev({ key: keyOf("生抽") }));
  assert.strictEqual(pantryPage.data.outOfStock.length, 0);
  svc("plan").add(idOf("台式卤肉饭"));
  await basketPage.refresh();
  assert.deepStrictEqual(basketPage.data.shopping.unknown.map((i) => i.name), ["冰糖"], "库存里没记录的调料单独一组");
  await basketPage.onHaveAll();
  assert.strictEqual(basketPage.data.shopping.unknown.length, 0);
  await flush();
  assert.strictEqual(sharedDoc("pantry").items[keyOf("冰糖")].inStock, true);
  modalAnswers.push({ confirm: true });
  await pantryPage.onRemove(ev({ key: keyOf("冰糖"), name: "冰糖" }));
  await flush();
  assert.ok(!sharedDoc("pantry").items[keyOf("冰糖")], "从库存里删掉");
  ok("库存：一键加常用调料、家里有的不提醒、用完了回到要买的、补上了、都有、删除");

  // ======== 想吃清单 ========
  const wishPage = newPage("pages/wishes/index");
  wishPage.onShow();
  assert.deepStrictEqual([wishPage.data.loaded, wishPage.data.list.length], [true, 0]);
  wishPage.onAdd();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/wish-edit/index"]);
  const we = newPage("pages/wish-edit/index");
  we.onLoad({});
  await we.onChoosePhoto();
  we.onInput(ev({ field: "name" }, { value: "酸菜鱼" }));
  we.onInput(ev({ field: "note" }, { value: "楼下那家的味道" }));
  await we.onSave();
  await flush();
  const wishKey = Object.keys(sharedDoc("wishes").items)[0];
  const wishRow = sharedDoc("wishes").items[wishKey];
  assert.ok(wishRow.name === "酸菜鱼" && /\/wishes\//.test(wishRow.photo), "想吃清单存到云上，照片传了");
  wishPage.onShow();
  assert.deepStrictEqual(wishPage.data.list.map((w) => w.name), ["酸菜鱼"]);
  wishPage.onLearn(ev({ key: wishKey }));
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", `/pages/dish-edit/index?wish=${wishKey}`]);
  const learn = newPage("pages/dish-edit/index");
  pageStack = [wishPage, learn];
  await learn.onLoad({ wish: wishKey });
  assert.deepStrictEqual(
    [learn.data.form.name, learn.data.form.cover, learn.data.form.status, learn.data.form.tips],
    ["酸菜鱼", wishRow.photo, "wish", "楼下那家的味道"]
  );
  await learn.onSave();
  await flush();
  assert.ok(rowOf("酸菜鱼") && rowOf("酸菜鱼").cover === wishRow.photo, "写成菜谱，照片直接用");
  assert.strictEqual(Object.keys(sharedDoc("wishes").items).length, 0, "从想吃清单里拿掉");
  assert.ok(cloudFiles[wishRow.photo], "照片菜谱还在用，没删");
  const we2 = newPage("pages/wish-edit/index");
  we2.onLoad({});
  we2.onInput(ev({ field: "name" }, { value: "麻辣香锅" }));
  await we2.onSave();
  await flush();
  const key2 = Object.keys(sharedDoc("wishes").items)[0];
  const we3 = newPage("pages/wish-edit/index");
  we3.onLoad({ key: key2 });
  assert.strictEqual(we3.data.isEdit, true);
  modalAnswers.push({ confirm: true });
  await we3.onDelete();
  await flush();
  assert.strictEqual(Object.keys(sharedDoc("wishes").items).length, 0);
  ok("想吃清单：记菜名和照片、开始学写成菜谱（照片沿用）、删除");

  // ======== 做饭日历 ========
  const calPage = newPage("pages/logs/index");
  calPage.onLoad();
  calPage.onShow();
  await flush();
  calPage.calYear = 2026;
  calPage.calMonth = 9;
  calPage.renderCalendar();
  const day = (date) => [].concat(...calPage.data.cal.weeks.map((w) => w.days)).find((d) => d.date === date);
  assert.deepStrictEqual([calPage.data.cal.title, day("2026-10-02").count], ["2026年10月", 3]);
  assert.deepStrictEqual([calPage.data.calOpen, calPage.data.weeks.length], [false, 1], "日历默认收起，只显示一周");
  calPage.onToggleCalendar();
  assert.deepStrictEqual([calPage.data.calOpen, calPage.data.weeks.length, calPage.data.calAnim], [true, calPage.data.cal.weeks.length, "unfold"], "展开看整月");
  const swipe = (dx, dy) => {
    calPage.onCalTouchStart({ touches: [{ clientX: 200, clientY: 300 }] });
    calPage.onCalTouchEnd({ changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
  };
  swipe(-120, 10);
  assert.deepStrictEqual([calPage.data.cal.title, calPage.data.calAnim], ["2026年11月", "slide-next1"], "往左滑看下个月");
  swipe(-30, 0);
  swipe(-80, 90);
  assert.strictEqual(calPage.data.cal.title, "2026年11月", "滑得短、斜着滑都不算");
  swipe(120, -10);
  assert.deepStrictEqual([calPage.data.cal.title, calPage.data.calAnim], ["2026年10月", "slide-prev2"], "往右滑看上个月");
  await calPage.onTapDay(ev({ date: "2026-10-02", count: 3, future: false }));
  assert.deepStrictEqual([calPage.data.selected, calPage.data.dayLogs.length], ["2026-10-02", 3]);
  assert.ok(/做了 3 道菜/.test(calPage.data.dayTitle), calPage.data.dayTitle);
  await calPage.onTapDay(ev({ date: "2026-10-02", count: 3, future: false }));
  assert.strictEqual(calPage.data.selected, "", "再点一下回到看全部");
  calPage.onPrevMonth();
  assert.deepStrictEqual(
    [calPage.data.cal.title, day("2026-09-26").count, day("2026-09-27").count, day("2026-09-29").count],
    ["2026年9月", 1, 1, 1]
  );
  // 做饭总结：日历右上角「总结」进来，先看日历上的这个月
  calPage.onOpenStats();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/stats/index?month=2026-09"]);
  const statsPage = newPage("pages/stats/index");
  statsPage.onLoad({ month: "2026-09" });
  statsPage.onShow();
  await flush();
  const sum9 = statsPage.data.s;
  assert.deepStrictEqual(
    [statsPage.data.kind, sum9.title, sum9.count, sum9.dishCount, sum9.top[0].name, sum9.top[0].count],
    ["month", "2026年9月", 3, 2, "经典小梁汤面", 2],
    "下厨几次、最常做的菜从日历挪到了做饭总结"
  );
  assert.strictEqual(statsPage.data.canNext, true);
  statsPage.onNext();
  assert.deepStrictEqual([statsPage.data.s.title, statsPage.data.anim], ["2026年10月", "slide-next1"], "往后翻一个月，从右边滑进来");
  statsPage.onPickKind(ev({ kind: "year" }));
  assert.deepStrictEqual([statsPage.data.kind, statsPage.data.s.title, statsPage.data.s.chart.length, statsPage.data.anim], ["year", "2026年", 12, "unfold"], "按年：每个月一根条");
  statsPage.onPickKind(ev({ kind: "all" }));
  assert.deepStrictEqual([statsPage.data.s.title, statsPage.data.canPrev, statsPage.data.canNext], ["全部", false, false]);
  statsPage.onPickKind(ev({ kind: "month" }));
  assert.strictEqual(statsPage.data.s.title, "2026年10月", "切回按月：还是刚才看的那个月");
  statsPage.onOpenDish(ev({ id: idOf("经典小梁汤面"), gone: false }));
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", `/pages/dish-detail/index?id=${idOf("经典小梁汤面")}`]);
  statsPage.onOpenDish(ev({ id: "gone", gone: true }));
  assert.deepStrictEqual(lastCall("toast"), ["toast", "这道菜已经删掉了"]);
  const emptyStats = newPage("pages/stats/index");
  emptyStats.onLoad({ month: "2026-08" });
  emptyStats.onShow();
  await flush();
  assert.deepStrictEqual([emptyStats.data.s.count, emptyStats.data.emptyText, emptyStats.data.current], [0, "2026年8月没有做菜记录", false]);
  const nowStats = newPage("pages/stats/index");
  nowStats.onLoad({});
  nowStats.onShow();
  await flush();
  assert.deepStrictEqual([nowStats.data.s.title, nowStats.data.canNext], [`${new Date(Date.now()).getFullYear()}年${new Date(Date.now()).getMonth() + 1}月`, false], "从「我的」进来看这个月，不能往后翻");
  await calPage.onTapDay(ev({ date: "2026-09-27", count: 1, future: false }));
  calPage.onToggleCalendar();
  assert.deepStrictEqual(
    [calPage.data.calOpen, calPage.data.cal.title, calPage.data.weeks.map((w) => w.days.map((d) => d.day).join(","))],
    [false, "2026年9月", ["21,22,23,24,25,26,27"]],
    "收起：只显示选中的那天那一周"
  );
  calPage.onToggleCalendar();
  await calPage.onTapDay(ev({ date: "2026-09-27", count: 1, future: false }));
  swipe(-120, 0);
  swipe(-120, 0);
  calPage.onToggleCalendar();
  assert.strictEqual(calPage.data.cal.title.slice(5), `${new Date(Date.now()).getMonth() + 1}月`, "没选日子：收起回到今天那个月");
  calPage.onToggleCalendar();
  calPage.calYear = 2026;
  calPage.calMonth = 8;
  calPage.renderCalendar();
  modalAnswers.push({ confirm: true });
  await calPage.onTapDay(ev({ date: "2026-09-20", count: 0, future: false }));
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/log-edit/index?date=2026-09-20"]);
  const le920 = newPage("pages/log-edit/index");
  await le920.onLoad({ date: "2026-09-20" });
  assert.strictEqual(le920.data.form.date, "2026-09-20", "补记那天的日期带过来了");
  const leFuture = newPage("pages/log-edit/index");
  await leFuture.onLoad({ date: "2099-01-01" });
  assert.strictEqual(leFuture.data.form.date, dateValue(Date.now()), "以后的日期不能补记");
  ok("做饭日历：标出做饭的日子、点一天只看那天、翻月、点空的日子补记");

  // ======== 对方看不到我传的照片：免费环境的云存储只有上传的人能读，照片交给云函数 api 换链接 ========
  launchApp("partner");
  const myThumb = rowOf("莴笋炒肉").coverThumb;
  assert.ok(myThumb && cloudFiles[myThumb].owner === "me", "照片是我导入时传的");
  assert.ok(!imageLoads(myThumb), "对方直接用文件 ID 读不到（就是这次的问题）");
  const IMG = "components/cloud-image/index";
  const fnCalls = () => countCalls("callFunction");
  let before = fnCalls();
  const imgs = ["莴笋炒肉", "番茄鸡蛋汤", "台式卤肉饭"].map((n) => newComponent(IMG, { src: rowOf(n).coverThumb, mode: "aspectFill" }));
  await settle();
  assert.strictEqual(fnCalls() - before, 1, "同一屏的照片攒成一批，只调一次云函数");
  assert.ok(imgs.every((c) => /^https:\/\/tmp\.tcb\//.test(c.data.url) && imageLoads(c.data.url)), "换成临时链接，对方能看到");
  assert.ok(imgs.every((c) => !c.events.length));
  const cached = newComponent(IMG, { src: myThumb });
  await settle();
  assert.deepStrictEqual([fnCalls() - before, cached.data.url], [1, imgs[0].data.url], "缓存里有，不用再调");
  timeOffset += 10 * 60 * 1000;
  const stale = newComponent(IMG, { src: myThumb });
  await settle();
  assert.strictEqual(fnCalls() - before, 2, "链接快过期了，重新换");
  // 链接过期加载失败：换个新的再试一次，还是不行才告诉页面
  const oldUrl = stale.data.url;
  stale.onError();
  await settle();
  assert.ok(stale.data.url !== oldUrl && imageLoads(stale.data.url), "换了新链接");
  assert.strictEqual(stale.events.length, 0);
  stale.onError();
  assert.deepStrictEqual(stale.events, [["error", { src: myThumb }]]);
  // 换了照片就显示新的；手机上刚选的照片直接显示；文件没了发 error（页面换成占位图）
  stale.setData({ src: rowOf("番茄鸡蛋汤").cover });
  await settle();
  assert.ok(/番茄|covers\//.test(stale.data.url) && imageLoads(stale.data.url), stale.data.url);
  before = fnCalls();
  const local = newComponent(IMG, { src: "http://tmp/photo99.jpg" });
  await settle();
  assert.deepStrictEqual([local.data.url, fnCalls() - before], ["http://tmp/photo99.jpg", 0]);
  const goneId = `cloud://test-env.1234/books/${testBookId}/covers/gone.jpg`;
  const gone = newComponent(IMG, { src: goneId });
  await settle();
  assert.deepStrictEqual([gone.data.url, gone.events], ["", [["error", { src: goneId }]]]);
  const herCheck = newPage("pages/mine/index");
  await herCheck.onCheckDatabase();
  assert.ok(/✅ 照片：正常（试了 \d+ 张）/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  ok("照片：云函数换成两个人都能看的链接；一屏只调一次、缓存 9 分钟、过期自动重试；本地照片直接显示");

  // 对方删掉我加的菜：我传的照片也删得掉（以前删不掉，只能留在云存储里）；对方导出时也能带上我传的照片
  const herSoup = rowOf("番茄鸡蛋汤");
  const herSoupFiles = [herSoup.cover, herSoup.coverThumb];
  assert.ok(herSoupFiles.every((f) => cloudFiles[f] && cloudFiles[f].owner === "me"));
  const herExp = await svc("export").buildFile({ withPhotos: true, onProgress: () => {} });
  const herBackup = JSON.parse(files[herExp.filePath]);
  assert.strictEqual(herExp.failedPhotos, 0, "对方传的照片也导出来了");
  assert.strictEqual(Buffer.from(herBackup.photos[herSoup.cover], "base64").toString(), `照片内容:${herSoup.cover}`);
  const herEdit = newPage("pages/dish-edit/index");
  pageStack = [herEdit];
  await herEdit.onLoad({ id: herSoup._id });
  modalAnswers.push({ confirm: true });
  await herEdit.onDelete();
  await flush();
  assert.ok(herSoupFiles.every((f) => !cloudFiles[f]), "我传的照片也删掉了");
  ok("对方删我加的菜，照片一起删掉；对方导出时也带上我传的照片");

  // ======== 云函数还没部署 ========
  apiDeployed = false;
  launchApp("partner");
  const herMine = newPage("pages/mine/index");
  await herMine.onCheckDatabase();
  const report = lastCall("modal")[2];
  assert.ok(/❌ 云函数 api：还没部署/.test(report), report);
  assert.ok(/右键 api 文件夹.*上传并部署：云端安装依赖/.test(report), "告诉对方怎么部署");
  const fallback = newComponent(IMG, { src: myThumb });
  await settle();
  assert.strictEqual(fallback.data.url, myThumb, "退回直接用文件 ID");
  assert.ok(!imageLoads(fallback.data.url), "对方看不到我传的");
  fallback.onError(); // 图片加载失败：重试也换不到新地址，图片不会再加载一次，所以马上告诉页面
  await settle();
  assert.deepStrictEqual(fallback.events, [["error", { src: myThumb }]], "加载不出来，告诉页面");
  const herMenu = newPage("pages/menu/index");
  await herMenu.onLoad();
  herMenu.onCoverError(ev({ src: myThumb }));
  assert.strictEqual(herMenu.data.broken[myThumb], true, "加载不出来的照片换成占位图");
  assert.deepStrictEqual(lastCall("toast"), ["toast", "有照片加载不出来，去「我的」底部点「检查一下云开发」"]);
  const toastsBefore = countCalls("toast");
  herMenu.onCoverError(ev({ src: rowOf("台式卤肉饭").coverThumb }));
  assert.strictEqual(countCalls("toast"), toastsBefore, "只提示一次");
  before = fnCalls();
  newComponent(IMG, { src: rowOf("台式卤肉饭").cover });
  await settle();
  assert.strictEqual(fnCalls() - before, 0, "知道没部署以后，这次打开就不再调了");
  launchApp("me");
  const mine2 = newComponent(IMG, { src: myThumb });
  await settle();
  assert.ok(mine2.data.url === myThumb && imageLoads(mine2.data.url), "我自己传的照片照样能看");
  // 部署好以后重新打开：正常；下拉刷新时加载失败的照片重新加载
  apiDeployed = true;
  launchApp("partner");
  await herMine.onCheckDatabase();
  assert.ok(/✅ 照片：正常/.test(lastCall("modal")[2]) && !/上传并部署/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  await herMenu.onPullRefresh();
  assert.deepStrictEqual(herMenu.data.broken, {}, "下拉刷新，照片重新加载");
  // 照片文件被删了（不是没部署）：只说照片不在了
  const lostFile = cloudFiles[myThumb];
  delete cloudFiles[myThumb];
  await herMine.onCheckDatabase();
  assert.ok(/1 张已经不在云存储里了/.test(lastCall("modal")[2]) && !/上传并部署/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  cloudFiles[myThumb] = lostFile;
  ok("云函数没部署：自己的照片照样显示，对方的换成占位图并提示一次；检查里写明怎么部署；部署后正常");

  // ======== 再导入 3 道新菜（带照片；照片没有拍摄日期，所以没有做菜记录） ========
  launchApp("me");
  const dishCount3 = cloudDB.dishes.length;
  const catCount3 = cloudDB.categories.length;
  const logCount3 = cloudDB.cook_logs.length;
  files["http://tmp/import3.json"] = fs.readFileSync(path.join(__dirname, "fixtures", "three-dishes.json"), "utf8");
  nextMessageFile = { path: "http://tmp/import3.json", name: "拿手菜-3道菜.json" };
  const imp3New = newPage("pages/import/index");
  imp3New.onChoose();
  await flush();
  assert.deepStrictEqual(
    [imp3New.data.status, imp3New.data.file.dishCount, imp3New.data.file.newCount, imp3New.data.file.logCount, imp3New.data.file.photoCount],
    ["ready", 3, 3, 0, 3]
  );
  await imp3New.onImport();
  assert.deepStrictEqual(imp3New.data.result, { added: 3, skipped: 0, logsAdded: 0, logsError: "" });
  const three = ["口蘑酿虾滑", "咸蛋黄豆腐汤", "青椒土豆丝"].map(rowOf);
  assert.ok(three.every((d) => d && /\/covers\//.test(d.cover) && /\/thumbs\//.test(d.coverThumb)), "3 道菜都有成品照");
  assert.deepStrictEqual(three.map((d) => cloudDB.categories.find((c) => c._id === d.categoryId).name), ["硬菜", "汤羹", "家常菜"]);
  assert.deepStrictEqual(
    [cloudDB.dishes.length - dishCount3, cloudDB.categories.length - catCount3, cloudDB.cook_logs.length - logCount3],
    [3, 0, 0],
    "分类按名字对上没有多建；没有做菜记录"
  );
  assert.deepStrictEqual(three.map((d) => d.steps.filter((st) => st.timer > 0).length), [2, 3, 3], "带计时的步骤");
  assert.ok(three.every((d) => d.status === "mastered" && d.tips));
  assert.deepStrictEqual((await Promise.all(three.map((d) => dishNow(d.name)))).map((d) => d.cookCount), [0, 0, 0]);
  ok("导入 3 道新菜：照片、分类、计时都对，没有做菜记录");

  // ======== 照着导入模板手写的文件（docs/菜谱导入模板.json） ========
  const templateText = fs.readFileSync(path.join(path.dirname(root), "docs", "菜谱导入模板.json"), "utf8");
  // 模拟用 Windows 记事本改的（开头带 BOM），最后一道菜后面还多了一个逗号
  const sloppy = "\uFEFF" + templateText.replace(/("熟练度": "想学"\s*})/, "$1,");
  assert.notStrictEqual(sloppy.length, templateText.length + 1, "确实多了个逗号");
  files["http://tmp/template.json"] = sloppy;
  nextMessageFile = { path: "http://tmp/template.json", name: "菜谱导入模板.json" };
  const impT = newPage("pages/import/index");
  impT.onChoose();
  await flush();
  assert.deepStrictEqual([impT.data.status, impT.data.file.dishCount, impT.data.file.newCount, impT.data.file.photoCount], ["ready", 2, 2, 0]);
  await impT.onImport();
  assert.deepStrictEqual(impT.data.result, { added: 2, skipped: 0, logsAdded: 0, logsError: "" });
  const noodle = rowOf("葱油拌面");
  assert.strictEqual(cloudDB.categories.find((c) => c._id === noodle.categoryId).name, "主食");
  assert.deepStrictEqual([noodle.status, noodle.difficulty, noodle.duration, noodle.servings, noodle.tags], ["learning", 2, 20, 2, ["快手", "一人食"]]);
  assert.deepStrictEqual(
    noodle.ingredients.map((i) => `${i.type}:${i.name}|${i.amount}|${i.unit}`),
    ["main:细面条|200|克", "side:葱|8|根", "seasoning:食用油|4|汤匙", "seasoning:生抽|2|汤匙", "seasoning:老抽|1|汤匙", "seasoning:白糖|1|汤匙"]
  );
  assert.deepStrictEqual(noodle.steps.map((st) => st.timer), [0, 480, 0, 180, 0], "「8分钟」「3分钟」变成计时");
  assert.ok(/擦干再下锅/.test(noodle.tips));
  const cucumber = rowOf("拍黄瓜");
  assert.deepStrictEqual(
    [cucumber.status, cucumber.ingredients.length, cucumber.steps.length, cloudDB.categories.find((c) => c._id === cucumber.categoryId).name],
    ["wish", 0, 0, "凉菜"],
    "只写菜名和分类也行"
  );
  // 没有的分类自动新建；原料的各种写法
  files["http://tmp/template2.json"] = JSON.stringify({
    菜谱: [{ 菜名: "糖醋小排", 分类: "宴客菜", 熟练度: "拿手菜", 用时: "1小时", 主料: ["猪小排 500克", "番茄 2 个", "鸡蛋2个"], 调料: ["盐适量", "干辣椒 2个（可选）", "葱 一把"], 做法: [{ 步骤: "小火炖", 计时: "1分30秒" }] }],
  });
  nextMessageFile = { path: "http://tmp/template2.json", name: "t2.json" };
  const impT2 = newPage("pages/import/index");
  impT2.onChoose();
  await flush();
  await impT2.onImport();
  const ribs = rowOf("糖醋小排");
  assert.strictEqual(cloudDB.categories.find((c) => c._id === ribs.categoryId).name, "宴客菜", "没有的分类自动新建");
  assert.deepStrictEqual(
    ribs.ingredients.map((i) => `${i.name}|${i.amount}|${i.unit}`),
    ["猪小排|500|克", "番茄|2|个", "鸡蛋|2|个", "盐|适量|", "干辣椒（可选）|2|个", "葱|一把|"]
  );
  assert.deepStrictEqual([ribs.status, ribs.duration, ribs.steps[0].timer], ["mastered", 60, 90]);
  // 写错了（用了中文冒号）：说在第几行附近
  files["http://tmp/bad.json"] = '{\n  "菜谱": [\n    { "菜名"： "红烧肉" }\n  ]\n}';
  nextMessageFile = { path: "http://tmp/bad.json", name: "bad.json" };
  const impBad = newPage("pages/import/index");
  impBad.onChoose();
  await flush();
  assert.strictEqual(lastCall("modal")[1], "打不开这个文件");
  assert.ok(/^文件格式不对（第 3 行附近）：/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  ok("导入模板：中文字段、按名字对分类（没有就新建）、原料一行一样、计时写「8分钟」；带 BOM、多个逗号也能读，写错了提示第几行");

  // ======== 界面整理：「我的」页、备份与导入、搜不到记到想吃清单 ========
  launchApp("me");
  const mineUi = newPage("pages/mine/index");
  mineUi.onShow();
  await flush();
  const pantryNow = svc("pantry").list();
  assert.deepStrictEqual(
    [mineUi.data.wishCount, mineUi.data.outCount, mineUi.data.stockCount],
    [svc("wish").list().length, pantryNow.outOfStock.length, pantryNow.inStock.length],
    "方块上的数字"
  );
  mineUi.onOpenBackup();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/backup/index"]);
  mineUi.onGoLogs();
  assert.deepStrictEqual(lastCall("switchTab"), ["switchTab", "/pages/logs/index"]);
  await mineUi.onCheckDatabase();
  assert.strictEqual(lastCall("modal")[1], "云开发检查");
  const backup = newPage("pages/backup/index");
  backup.onOpenExport();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/export/index"]);
  backup.onOpenImport();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/import/index"]);
  backup.onSendTemplate();
  const shared = lastCall("shareFile");
  assert.strictEqual(shared[1], "菜谱导入模板.json");
  const docsTemplate = JSON.parse(fs.readFileSync(path.join(path.dirname(root), "docs", "菜谱导入模板.json"), "utf8"));
  assert.deepStrictEqual(JSON.parse(files[shared[2]]), docsTemplate, "发出去的模板和 docs/菜谱导入模板.json 一样");
  // 发出去的模板拿回来能直接导入
  nextMessageFile = { path: shared[2], name: "菜谱导入模板.json" };
  const impBack = newPage("pages/import/index");
  impBack.onChoose();
  await flush();
  assert.deepStrictEqual([impBack.data.status, impBack.data.file.dishCount], ["ready", 2]);

  // 菜单：搜不到 → 记到想吃清单，菜名带过去
  const menuUi = newPage("pages/menu/index");
  await menuUi.onLoad();
  menuUi.onSearchInput({ detail: { value: "酸辣粉" } });
  assert.deepStrictEqual([menuUi.data.searching, menuUi.data.searchResults.length], [true, 0]);
  menuUi.onWishFromSearch();
  const wishUrl = lastCall("navigateTo")[1];
  assert.strictEqual(wishUrl, `/pages/wish-edit/index?name=${encodeURIComponent("酸辣粉")}`);
  const weFromSearch = newPage("pages/wish-edit/index");
  weFromSearch.onLoad({ name: wishUrl.split("name=")[1] });
  assert.strictEqual(weFromSearch.data.form.name, "酸辣粉", "菜名已经填好");
  await menuUi.onDiagnose();
  assert.strictEqual(lastCall("modal")[1], "云开发检查");
  ok("界面整理：「我的」方块和入口、备份与导入（发模板能直接导回来）、搜不到记到想吃清单");

  // ======== 本地导入导出：复制成文字 / 粘贴导入 / 电脑上存到电脑 ========
  launchApp("me");
  platformName = "ios";
  const expPhone = newPage("pages/export/index");
  await expPhone.onLoad();
  assert.strictEqual(expPhone.data.canSaveToDisk, false, "手机上没有「存到电脑」");
  expPhone.onCopy();
  assert.notStrictEqual(lastCall("modal")[1], "已复制", "还没生成文件时点了没反应");
  await expPhone.onBuild();
  expPhone.onCopy();
  assert.strictEqual(lastCall("modal")[1], "已复制");
  assert.strictEqual(JSON.parse(clipboardText).app, "nashoucai-xiaobenben", "复制出来的就是备份文件的内容");
  // 粘贴导入：同一份数据，菜都已经有了
  const impPaste = newPage("pages/import/index");
  await impPaste.onPaste();
  assert.deepStrictEqual(
    [impPaste.data.status, impPaste.data.file.name, impPaste.data.file.dishCount, impPaste.data.file.newCount],
    ["ready", "复制的内容", cloudDB.dishes.length, 0]
  );
  // 电脑版微信：可以直接存到电脑
  platformName = "windows";
  const expPc = newPage("pages/export/index");
  await expPc.onLoad();
  assert.strictEqual(expPc.data.canSaveToDisk, true);
  await expPc.onBuild();
  expPc.onSaveToDisk();
  assert.deepStrictEqual(lastCall("saveToDisk"), ["saveToDisk", expPc.data.file.filePath]);
  // 导入模板：电脑上存到电脑；手机上复制 → 改好 → 粘贴导入
  const backupPc = newPage("pages/backup/index");
  backupPc.onLoad();
  assert.strictEqual(backupPc.data.canSaveToDisk, true);
  backupPc.onSaveTemplate();
  assert.ok(/import-template\.json$/.test(lastCall("saveToDisk")[1]));
  platformName = "ios";
  backupPc.onCopyTemplate();
  assert.strictEqual(lastCall("modal")[1], "已复制");
  const impTpl = newPage("pages/import/index");
  await impTpl.onPaste();
  assert.deepStrictEqual([impTpl.data.status, impTpl.data.file.dishCount], ["ready", 2]);
  // 剪贴板是空的、不是 JSON、不是我们的数据：都说清楚
  clipboardText = "";
  await impTpl.onPaste();
  assert.deepStrictEqual(lastCall("modal").slice(1), ["导入不了", "剪贴板里是空的：先把要导入的内容全选复制，再来点「粘贴」"]);
  clipboardText = "今天买了白菜";
  await impTpl.onPaste();
  assert.ok(/^复制的内容格式不对/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  clipboardText = JSON.stringify({ hello: 1 });
  await impTpl.onPaste();
  assert.ok(/这不是「拿手菜小本本」的数据/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  // 隐私指引里还没声明剪切板：复制、粘贴都说清楚原因
  clipboardFail = { errMsg: "setClipboardData:fail api scope is not declared in the privacy agreement", errno: 112 };
  backupPc.onCopyTemplate();
  assert.strictEqual(lastCall("modal")[1], "暂时不能复制");
  await impTpl.onPaste();
  assert.strictEqual(lastCall("modal")[1], "暂时不能读取剪贴板");
  clipboardFail = null;
  ok("本地导入导出：复制成文字、粘贴导入（备份和模板）、电脑上存到电脑；剪贴板没声明时提示原因");

  // ======== 不用滚轮：选菜面板、快捷日期、以前写过的掌勺 ========
  launchApp("me");
  svc("plan").clear();
  svc("plan").add(idOf("青椒土豆丝"));
  await flush();
  const picker = newComponent("components/dish-picker/index", { show: true, selected: idOf("口蘑酿虾滑") });
  await settle();
  const pickTitles = picker.data.sections.map((sct) => sct.title);
  assert.deepStrictEqual(pickTitles.slice(0, 2), ["菜篮里的", "最近做过"], pickTitles.join("、"));
  assert.deepStrictEqual(picker.data.sections[0].items.map((i) => i.name), ["青椒土豆丝"]);
  const recentNames = picker.data.sections[1].items.map((i) => i.name);
  assert.ok(recentNames.length >= 1 && recentNames.length <= 5 && !recentNames.includes("青椒土豆丝"), recentNames.join("、"));
  assert.ok(pickTitles.includes("家常菜") && pickTitles.includes("汤羹"), "下面按分类排");
  const listedCount = picker.data.sections.slice(2).reduce((n, sct) => n + sct.items.length, 0);
  assert.strictEqual(listedCount, cloudDB.dishes.length, "所有的菜都按分类列出来了");
  picker.onInput({ detail: { value: "土豆" } });
  const potatoNames = picker.data.results.map((d) => d.name);
  assert.ok(potatoNames.includes("青椒土豆丝") && potatoNames.includes("土豆肉丝炒饭"), potatoNames.join("、"));
  picker.onInput({ detail: { value: "火锅" } });
  assert.strictEqual(picker.data.results.length, 0);
  picker.onClear();
  assert.strictEqual(picker.data.keyword, "");
  picker.onPick(ev({ id: idOf("青椒土豆丝"), name: "青椒土豆丝" }));
  assert.deepStrictEqual(picker.events.pop(), ["select", { id: idOf("青椒土豆丝"), name: "青椒土豆丝" }]);
  picker.onClose();
  assert.strictEqual(picker.events.length, 0, "先播收起的动画，播完才发 close");
  await sheetClosed();
  assert.deepStrictEqual(picker.events.pop(), ["close", undefined]);
  // 补记录：今天 / 昨天点一下；以前写过的掌勺名字点一下
  const leCook = newPage("pages/log-edit/index");
  await leCook.onLoad({ dishId: idOf("口蘑酿虾滑") });
  leCook.onInput(ev({ field: "cook" }, { value: "小亮" }));
  await leCook.onSave();
  await flush();
  const leQuick = newPage("pages/log-edit/index");
  await leQuick.onLoad({});
  assert.deepStrictEqual([leQuick.data.form.date, leQuick.data.today], [dateValue(Date.now()), dateValue(Date.now())]);
  leQuick.onQuickDate(ev({ date: leQuick.data.yesterday }));
  assert.strictEqual(leQuick.data.form.date, dateValue(Date.now() - 24 * 3600 * 1000));
  assert.ok(leQuick.data.cookNames.includes("小亮"), "以前写过的名字：" + leQuick.data.cookNames.join("、"));
  leQuick.onInput(ev({ field: "cook" }, { value: "" }));
  leQuick.onPickCook(ev({ name: "小亮" }));
  assert.strictEqual(leQuick.data.form.cook, "小亮");
  await leQuick.onDishPicked({ detail: { id: idOf("青椒土豆丝") } });
  assert.deepStrictEqual([leQuick.data.dishName, leQuick.data.showPlanOption], ["青椒土豆丝", true], "菜篮里的菜，打卡时可以顺便拿掉");
  svc("plan").clear();
  ok("不用滚轮：选菜面板（菜篮里的、最近做过、按分类、能搜）、今天/昨天、以前写过的掌勺");

  // ======== 同一天记好几道（bug：今天记过一次以后，记录页没有地方再加了） ========
  launchApp("me");
  const todayKey = dateValue(Date.now());
  const countToday = () => cloudDB.cook_logs.filter((l) => dateValue(l.cookedAt) === todayKey).length;
  const before2 = countToday();
  assert.ok(before2 >= 1, "今天已经有记录了");
  const logsPageDay = newPage("pages/logs/index");
  logsPageDay.onLoad();
  logsPageDay.onShow();
  await flush();
  logsPageDay.onAddLog(ev({}));
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/log-edit/index"], "没点开哪天时：「记一笔」记在今天");
  await logsPageDay.onTapDay(ev({ date: todayKey, count: before2, future: false }));
  assert.strictEqual(logsPageDay.data.selected, todayKey, "点今天：看今天的记录");
  logsPageDay.onAddLog(ev({ date: logsPageDay.data.selected }));
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", `/pages/log-edit/index?date=${todayKey}`], "「这天再记一道」带上日期");
  const againDay = newPage("pages/log-edit/index");
  await againDay.onLoad({ date: todayKey });
  await againDay.onDishPicked({ detail: { id: idOf("咸蛋黄豆腐汤") } });
  await againDay.onSave();
  await flush();
  const sameDish = newPage("pages/log-edit/index");
  await sameDish.onLoad({ date: todayKey });
  await sameDish.onDishPicked({ detail: { id: idOf("咸蛋黄豆腐汤") } });
  await sameDish.onSave();
  await flush();
  assert.strictEqual(countToday(), before2 + 2, "同一天能记好几道，同一道菜也能记两次");
  logsPageDay.onShow();
  await flush();
  logsPageDay.renderCalendar();
  assert.strictEqual(logsPageDay.data.dayLogs.length, before2 + 2, "选中的这天马上显示新记的");
  ok("同一天记好几道：记录页「记一笔」「这天再记一道」都能进去，保存不受限制");

  // ======== 日历：没选日子时，月初月末的空格子不能显示成选中（bug：以前是一整块黄的） ========
  const gridPage = newPage("pages/logs/index");
  gridPage.onLoad();
  gridPage.onShow();
  await flush();
  const calCells = () => gridPage.data.cal.weeks.reduce((all, w) => all.concat(w.days), []);
  const selectedCells = () =>
    calCells().filter((d) => classOf("pages/logs/index", "cal-day ", { d, selected: gridPage.data.selected }).includes("selected"));
  gridPage.calYear = 2026;
  gridPage.calMonth = 9; // 2026 年 10 月：1 号是周四，前面空 3 格，后面空 1 格
  gridPage.renderCalendar();
  assert.strictEqual(calCells().filter((d) => !d.date).length, 4);
  assert.deepStrictEqual(selectedCells(), [], "没选日子：一个格子都不显示成选中");
  gridPage.setData({ selected: "2026-10-02" });
  gridPage.renderCalendar();
  assert.deepStrictEqual(selectedCells().map((d) => d.date), ["2026-10-02"], "选了哪天，就只有那天显示成选中");
  ok("日历：月初月末的空格子不会显示成选中");

  // ======== 点菜单：确认（哪一顿、口味、谁点的）、下单、加菜、存成图片、发给对方、撤单 ========
  launchApp("me");
  svc("plan").clear();
  await flush();
  const { mealByTime } = require(path.join(root, "utils/order"));
  const LUROU = idOf("台式卤肉饭");
  const WINGS = idOf("奥尔良鸡翅（空气炸锅版）");
  const LETTUCE = idOf("莴笋炒肉");
  const menuO = newPage("pages/menu/index");
  await menuO.onLoad();
  menuO.onShow();
  [LUROU, WINGS, WINGS, LETTUCE].forEach((id) => menuO.onPlus(ev({ id })));
  await flush();
  assert.deepStrictEqual([menuO.data.basketCount, menuO.data.ordered], [4, false]);
  // 菜单页点「去下单」：确认点菜单页
  menuO.onGoToday();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/checkout/index"]);
  const co = await openCheckout({});
  assert.deepStrictEqual(co.data.items.map((i) => `${i.name}×${i.qty}`).sort(), ["台式卤肉饭×1", "奥尔良鸡翅（空气炸锅版）×2", "莴笋炒肉×1"].sort(), "点的菜在这里只能看");
  assert.strictEqual(co.data.slowText, "最慢的台式卤肉饭要 90 分钟");
  assert.deepStrictEqual([co.data.form.date, co.data.form.meal], [dateValue(Date.now()), mealByTime(Date.now())], "默认今天，按现在几点猜哪一顿");
  assert.strictEqual(co.data.form.cook, "小亮", "掌勺默认是这台手机上次写的");
  assert.ok(co.data.names.includes("小亮"), "以前写过的名字点一下就行：" + co.data.names.join("、"));
  const checkoutWxml = fs.readFileSync(path.join(root, "pages/checkout/index.wxml"), "utf8");
  assert.ok(!/onPlus|onMinus|stepper/.test(checkoutWxml), "确认点菜单页上不能改点的菜");
  co.onBackToMenu();
  assert.deepStrictEqual(lastCall("switchTab"), ["switchTab", "/pages/menu/index"], "要改菜回菜单");
  co.onPickMeal(ev({ meal: "晚饭" }));
  co.onPickDate(ev({ date: co.data.tomorrow }));
  assert.ok(/^\d+月\d+日 周/.test(co.data.dateLabel), co.data.dateLabel);
  co.onPickDate(ev({ date: co.data.today }));
  co.onToggleFlavor(ev({ name: "少辣" }));
  co.onToggleFlavor(ev({ name: "不要香菜" }));
  co.onToggleFlavor(ev({ name: "少辣" })); // 再点一下取消
  co.onAddFlavor();
  assert.strictEqual(co.data.addingFlavor, true, "「＋ 口味」变成输入框");
  co.onFlavorDone({ detail: { value: " 多放醋 " } }); // 点了键盘上的「完成」
  co.onFlavorDone({ detail: { value: " 多放醋 " } }); // 接着还有一次 blur：不会加两遍
  assert.deepStrictEqual([co.data.addingFlavor, co.data.form.flavors], [false, ["不要香菜", "多放醋"]]);
  assert.ok(co.data.flavorChips.some((c) => c.name === "多放醋" && c.on), "自己加的口味也变成选项");
  co.onNoteInput({ detail: { value: "鸡翅烤焦一点" } });
  modalAnswers.push({ confirm: true, content: "小鱼" });
  await co.onAddName(ev({ field: "orderedBy" }));
  co.onPickName(ev({ field: "cook", name: "小亮" }));
  assert.strictEqual(co.data.form.cook, "", "再点一下同一个名字就是不填");
  co.onPickName(ev({ field: "cook", name: "小亮" }));
  await co.onSubmit();
  await flush();
  assert.deepStrictEqual(lastCall("switchTab"), ["switchTab", "/pages/today/index"], "下好单去「点菜单」");
  const basketO = newPage("pages/today/index");
  basketO.onLoad({});
  basketO.onShow();
  await flush();
  assert.strictEqual(basketO.data.stampIn, true, "刚下的单：「已下单」的章盖下来");
  await new Promise((r) => setTimeout(r, 600));
  assert.deepStrictEqual(lastCall("buzz"), ["buzz", "medium"], "章落下的那一下手机震一下");
  await basketO.refresh();
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(basketO.data.stampIn, false, "章只盖一次");
  const order1 = planDoc().order;
  assert.deepStrictEqual(
    [order1.no, order1.meal, order1.date, order1.flavors, order1.note, order1.orderedBy, order1.cook],
    [1, "晚饭", dateValue(Date.now()), ["不要香菜", "多放醋"], "鸡翅烤焦一点", "小鱼", "小亮"]
  );
  assert.deepStrictEqual(order1.items, planItems(), "记下下单时点了哪些菜");
  assert.strictEqual(basketO.data.stage, "ordered");
  assert.deepStrictEqual([basketO.data.ticket.noText, basketO.data.ticket.peopleText], ["No.001", "点菜 小鱼 · 掌勺 小亮"]);
  assert.strictEqual(dev().dev_order_name, "小鱼", "记住这台手机的点菜人");
  menuO.onShow();
  await flush();
  assert.deepStrictEqual([menuO.data.ordered, menuO.data.basketCount], [true, 4], "菜单页底部：「已点 4 份」「看点菜单」，不写编号");
  const menuWxml = fs.readFileSync(path.join(root, "pages/menu/index.wxml"), "utf8");
  assert.ok(!/No\.|orderNo|已下单/.test(menuWxml), "菜单页上不显示点菜单编号");
  // 对方打开菜篮就是这张点菜单；对方又点了一道，点菜单上标「加」
  launchApp("partner");
  const herBasket = newPage("pages/today/index");
  herBasket.onShow();
  await flush();
  assert.deepStrictEqual([herBasket.data.stage, herBasket.data.ticket.noText], ["ordered", "No.001"]);
  svc("plan").add(idOf("土豆肉丝炒饭"));
  await flush();
  launchApp("me");
  const basketO2 = newPage("pages/today/index");
  basketO2.onShow();
  await settle();
  assert.deepStrictEqual(basketO2.data.ticket.items.filter((i) => i.added).map((i) => i.name), ["土豆肉丝炒饭"], "下单以后点的标「加」");
  // 存成图片：小票上写着编号、菜、口味、备注，盖着「已下单」
  await basketO2.onSaveImage();
  const drawn = files[lastCall("shareImage")[1]];
  ["点菜单", "No.001", "台式卤肉饭", "×2", "加", "口味：不要香菜、多放醋", "备注：鸡翅烤焦一点", "已下单"].forEach((t) => assert.ok(drawn.includes(t), `图片上没有「${t}」：${drawn}`));
  assert.deepStrictEqual(lastCall("canvasImage").slice(2, 3), [720], "图片放大 2 倍，看着清楚");
  // 发给对方：小程序卡片，标题写着吃什么，封面是点菜单
  const share = basketO2.onShareAppMessage({ from: "button" });
  assert.strictEqual(share.path, `/pages/today/index?book=${testBookId}`, "对方点开时切到这本");
  assert.ok(/^今晚吃这些：.+等 4 道菜$/.test(share.title), share.title);
  assert.ok(share.imageUrl && files[share.imageUrl].includes("点菜单 No.001 · 晚饭"), "卡片封面先画好了");
  // 改一改：在确认点菜单页改成午饭、换个掌勺、少个口味；编号、下单时点的菜都不变。点的菜在这里也不能改
  basketO2.onEditOrder();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/checkout/index?edit=1"]);
  const coEdit = await openCheckout({ edit: "1" });
  assert.deepStrictEqual(
    [coEdit.data.editing, coEdit.data.orderNo, coEdit.data.form.meal, coEdit.data.form.flavors, coEdit.data.form.note, coEdit.data.form.cook],
    [true, "No.001", "晚饭", ["不要香菜", "多放醋"], "鸡翅烤焦一点", "小亮"],
    "原来填的都在"
  );
  assert.deepStrictEqual(lastCall("title"), ["title", "改点菜单"]);
  coEdit.onPickMeal(ev({ meal: "午饭" }));
  coEdit.onPickName(ev({ field: "cook", name: "小鱼" }));
  coEdit.onToggleFlavor(ev({ name: "多放醋" }));
  await coEdit.onSubmit();
  await flush();
  const edited = planDoc().order;
  assert.deepStrictEqual([edited.no, edited.meal, edited.cook, edited.flavors, edited.items], [1, "午饭", "小鱼", ["不要香菜"], order1.items]);
  assert.deepStrictEqual(lastCall("navigateBack"), ["navigateBack", 1]);
  assert.deepStrictEqual(lastCall("toast"), ["toast", "改好了"]);
  await basketO2.refresh();
  assert.strictEqual(basketO2.data.ticket.meal, "午饭");
  // 已经下了单，再从菜单点「去下单」：去看点菜单，不会再下一单
  const coAgain = await openCheckout({});
  assert.deepStrictEqual(lastCall("switchTab"), ["switchTab", "/pages/today/index"]);
  assert.strictEqual(coAgain.data.ready, false);
  // 撤单（在「改一改」最下面）：点的菜还在；再下单还是这个编号（撤单不占号）
  const coCancel = await openCheckout({ edit: "1" });
  modalAnswers.push({ confirm: true });
  await coCancel.onCancelOrder();
  await flush();
  assert.ok(!planDoc().order, "撤单以后云上没有点菜单了");
  await basketO2.refresh();
  assert.deepStrictEqual([basketO2.data.stage, basketO2.data.items.length], ["picking", 4]);
  await placeOrder();
  assert.strictEqual(planDoc().order.no, 1, "撤单不占号");
  // 一道一道打卡、拿出菜篮：菜篮空了，点菜单也就没了
  Object.keys(planItems()).forEach((id) => svc("plan").drop(id));
  await flush();
  assert.ok(!planDoc().order, "菜篮空了，点菜单也没了");
  basketO2.onShow();
  await flush();
  assert.strictEqual(basketO2.data.stage, "empty");
  ok("点菜单：确认（哪一顿、口味、谁点的）、下单、对方看得到、加菜标「加」、存成图片、发给对方、改一改、撤单不占号；菜单页不显示编号");

  // ======== 开饭啦：一次把这顿的菜都记下来，没做的留在菜篮；记录页按顿显示；分享这顿饭；再来一单 ========
  launchApp("me");
  const POTATO = idOf("土豆肉丝炒饭");
  const countOf = async (name) => (await dishNow(name)).cookCount;
  const before3 = { lurou: await countOf("台式卤肉饭"), potato: await countOf("土豆肉丝炒饭") };
  svc("plan").addMany({ [LUROU]: 1, [WINGS]: 2, [LETTUCE]: 1, [POTATO]: 1 });
  await flush();
  const basketM = newPage("pages/today/index");
  basketM.onLoad();
  basketM.onShow();
  await flush();
  await placeOrder((co) => co.onPickMeal(ev({ meal: "晚饭" })));
  await basketM.refresh();
  basketM.onToggleItem(ev({ key: basketM.data.shopping.buy[0].key })); // 买到了一样
  modalAnswers.push({ confirm: true, content: "牛奶" });
  await basketM.onAddExtra();
  await flush();
  basketM.onFinishMeal();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/meal/index"]);
  const mealPage = newPage("pages/meal/index");
  await mealPage.onLoad({});
  const mi = (id) => mealPage.data.dishes.findIndex((d) => d.dishId === id);
  assert.deepStrictEqual(
    [mealPage.data.dishes.length, mealPage.data.madeCount, mealPage.data.date, mealPage.data.meal, mealPage.data.cook, mealPage.data.orderText],
    [4, 4, dateValue(Date.now()), "晚饭", "小亮", "点菜单 No.001"],
    "默认全勾上；哪天、哪一顿、掌勺跟着点菜单"
  );
  await mealPage.onChoosePhoto();
  mealPage.onToggleDish(ev({ i: mi(POTATO) })); // 炒饭这次没做
  assert.strictEqual(mealPage.data.madeCount, 3);
  mealPage.onStar(ev({ i: mi(LUROU), value: 5 }));
  mealPage.onStar(ev({ i: mi(WINGS), value: 4 }));
  mealPage.onStar(ev({ i: mi(LETTUCE), value: 2 }));
  mealPage.onStar(ev({ i: mi(LETTUCE), value: 2 })); // 再点一下同一颗星 = 不打分
  mealPage.onStar(ev({ i: mi(LETTUCE), value: 3 }));
  mealPage.onNoteInput({ detail: { value: "卤肉炖得很烂，下次少放点糖" } });
  // meals 集合还没建（云函数也建不了）：提示怎么建；建好以后在这一页重试，不会多记
  delete cloudDB.meals;
  serverCanCreate = false;
  const logsBefore = cloudDB.cook_logs.length;
  await mealPage.onSave();
  assert.strictEqual(lastCall("modal")[1], "没记上");
  assert.ok(/meals/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  assert.ok(planItems()[LUROU] && planDoc().order, "没记上就还在菜篮里");
  cloudDB.meals = [];
  serverCanCreate = true;
  await mealPage.onSave();
  await flush();
  assert.strictEqual(cloudDB.meals.length, 1);
  const meal1 = cloudDB.meals[0];
  assert.deepStrictEqual(
    [meal1.no, meal1.meal, meal1.date, meal1.cook, meal1.orderedBy, meal1.note],
    [1, "晚饭", dateValue(Date.now()), "小亮", "小鱼", "卤肉炖得很烂，下次少放点糖"]
  );
  assert.deepStrictEqual(meal1.items.map((i) => [i.dishId, i.qty]).sort(), [[LUROU, 1], [WINGS, 2], [LETTUCE, 1]].sort());
  assert.ok(/\/logs\//.test(meal1.photo) && cloudFiles[meal1.photo] && cloudFiles[meal1.photoThumb], "整桌照片传到云存储");
  const mealLogs = cloudDB.cook_logs.filter((l) => l.mealId === meal1._id);
  assert.strictEqual(cloudDB.cook_logs.length, logsBefore + 3, "重试没有多记");
  assert.deepStrictEqual(mealLogs.map((l) => [l.dishId, l.rating, l.cook, dateValue(l.cookedAt)]).sort(), [[LUROU, 5, "小亮", dateValue(Date.now())], [WINGS, 4, "小亮", dateValue(Date.now())], [LETTUCE, 3, "小亮", dateValue(Date.now())]].sort());
  assert.deepStrictEqual([await countOf("台式卤肉饭"), await countOf("土豆肉丝炒饭")], [before3.lurou + 1, before3.potato], "做过几次跟着记录变");
  assert.deepStrictEqual(planItems(), { [POTATO]: 1 }, "没做的留在菜篮");
  assert.ok(!planDoc().order, "点菜单收起来了");
  assert.deepStrictEqual(Object.values(planDoc().extras).map((x) => x.name), ["牛奶"], "还剩菜，买菜清单先不动");
  assert.deepStrictEqual(lastCall("switchTab"), ["switchTab", "/pages/logs/index"]);
  assert.strictEqual(dev().dev_cook_name, "小亮");
  // 记录页：直接选中那天，同一顿的菜合成一张卡片
  const logsM = newPage("pages/logs/index");
  logsM.onLoad();
  logsM.onShow();
  await flush();
  assert.strictEqual(logsM.data.selected, dateValue(Date.now()), "开完饭直接看那天");
  const mealEntry = logsM.data.dayEntries.find((e) => e.type === "meal");
  assert.ok(mealEntry, "那天有一张「一顿饭」的卡片");
  assert.strictEqual(mealEntry.meal.fresh, true, "刚记好的这一顿盖个「已开饭」的章");
  assert.strictEqual(logsM.data.calOpen, false, "日历默认收起");
  assert.deepStrictEqual(
    logsM.data.weeks.map((w) => w.days.some((d) => d.date === dateValue(Date.now()))),
    [true],
    "收起时只显示选中的那天那一周"
  );
  assert.deepStrictEqual(
    [mealEntry.meal.title, mealEntry.meal.noText, mealEntry.meal.photo, mealEntry.meal.peopleText, mealEntry.meal.note],
    ["晚饭", "No.001", meal1.photoThumb, "点菜 小鱼 · 掌勺 小亮", "卤肉炖得很烂，下次少放点糖"]
  );
  assert.deepStrictEqual(mealEntry.meal.dishes.map((d) => `${d.dishName}${d.qtyText}|${d.stars}`).sort(), ["台式卤肉饭|★★★★★", "奥尔良鸡翅（空气炸锅版）×2|★★★★☆", "莴笋炒肉|★★★☆☆"].sort());
  assert.ok(logsM.data.months[0].days[0].entries.some((e) => e.type === "meal" && e.mealId === meal1._id), "全部记录里也按顿合在一起");
  // 详情页：开饭记的那条没自己的照片，用整桌照片
  const detM = newPage("pages/dish-detail/index");
  detM.onLoad({ id: LUROU });
  await flush();
  assert.strictEqual(detM.data.logs[0].photo, meal1.photoThumb);
  // 分享这顿饭：小票盖「已开饭」，有分数和心得，最上面是整桌照片
  await logsM.onShareMeal(ev({ id: meal1._id }));
  const mealImg = files[lastCall("shareImage")[1]];
  ["已开饭", "No.001", "★★★★★", "奥尔良鸡翅（空气炸锅版） ×2", "卤肉炖得很烂，下次少放点糖"].forEach((t) => assert.ok(mealImg.includes(t), `图片上没有「${t}」：${mealImg}`));
  // 再来一单：按当时的份数放回菜篮
  logsM.onReorder(ev({ id: meal1._id }));
  await flush();
  assert.deepStrictEqual(planItems(), { [POTATO]: 1, [LUROU]: 1, [WINGS]: 2, [LETTUCE]: 1 });
  assert.deepStrictEqual([lastCall("navigateTo"), lastCall("toast")], [["navigateTo", "/pages/checkout/index"], ["toast", "放进菜篮了"]], "还没下单：放进菜篮，去确认点菜单");
  ok("开饭啦：一次记下这顿的菜（打分、掌勺、整桌照片）、没做的留在菜篮、集合没建时重试不多记；记录页按顿显示、分享这顿饭、再来一单");

  // ======== 忘了开饭：第二天问一下；菜都做了，菜篮和买菜清单一起清掉；一顿的记录删光了，这一顿也删掉 ========
  const basketL = newPage("pages/today/index");
  basketL.onShow();
  await flush();
  await placeOrder();
  const yesterday = dateValue(Date.now() - 24 * 3600 * 1000);
  partnerWrites(() => {
    planDoc().order.date = yesterday; // 点菜单是昨天的
  });
  await svc("plan").sync();
  basketL.onShow();
  await flush();
  const [, ym, yd] = yesterday.split("-").map(Number);
  assert.strictEqual(basketL.data.overdue, `${ym}月${yd}日的${planDoc().order.meal}做了吗？`);
  basketL.onOverdueDone();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", `/pages/meal/index?date=${yesterday}`]);
  const lateMeal = newPage("pages/meal/index");
  await lateMeal.onLoad({ date: yesterday });
  assert.strictEqual(lateMeal.data.date, yesterday, "按点菜单那天记");
  await lateMeal.onSave();
  await flush();
  const meal2 = cloudDB.meals.find((m) => m.no === 2);
  assert.ok(meal2 && meal2.date === yesterday && !meal2.photo, "没拍照也能记");
  assert.ok(cloudDB.cook_logs.filter((l) => l.mealId === meal2._id).every((l) => dateValue(l.cookedAt) === yesterday));
  assert.deepStrictEqual([planItems(), planDoc().checked, Object.values(planDoc().extras).map((x) => x.name)], [{}, {}, ["牛奶"]], "菜都做了：菜篮、勾选清空，没买的牛奶留着");
  // 删掉这一顿的记录：删光了，这一顿和整桌照片也删掉
  launchApp("me");
  for (const l of cloudDB.cook_logs.filter((x) => x.mealId === meal1._id)) await svc("log").removeLog(l._id);
  assert.ok(!cloudDB.meals.some((m) => m._id === meal1._id), "这一顿也删掉了");
  await flush();
  assert.ok(!cloudFiles[meal1.photo] && !cloudFiles[meal1.photoThumb], "整桌照片也删掉了");
  ok("忘了开饭：第二天问一下、按那天记；菜都做了清空菜篮（没买的留着）；一顿的记录删光，这一顿和照片也删掉");

  // ======== 备份：每一顿和整桌照片也导出；导入时记录跟着换成新的那一顿 ========
  const backupData = JSON.parse(files[(await svc("export").buildFile({ withPhotos: true })).filePath]);
  assert.ok(backupData.meals.some((m) => m._id === meal2._id), "导出里有每一顿");
  const fileMeal = { _id: "file-meal-1", no: 9, date: "2025-05-01", meal: "午饭", items: [{ dishId: "f-lurou", dishName: "台式卤肉饭", qty: 2 }], note: "五一做的", photo: "cloud://old/logs/table.jpg", createdAt: new Date(2025, 4, 1, 12).getTime() };
  const fileData = {
    app: "nashoucai-xiaobenben",
    format: 1,
    categories: [],
    dishes: [{ _id: "f-lurou", name: "台式卤肉饭" }],
    logs: [{ _id: "file-log-1", dishId: "f-lurou", dishName: "台式卤肉饭", cookedAt: fileMeal.createdAt, rating: 4, mealId: "file-meal-1" }],
    meals: [fileMeal],
    photos: { "cloud://old/logs/table.jpg": Buffer.from("整桌").toString("base64") },
  };
  await svc("import").importData(fileData);
  await svc("import").importData(fileData); // 再导一次不会多出来
  const importedMeals = cloudDB.meals.filter((m) => m.date === "2025-05-01");
  assert.strictEqual(importedMeals.length, 1);
  assert.deepStrictEqual([importedMeals[0].items[0].dishId, importedMeals[0].items[0].qty, importedMeals[0].note], [LUROU, 2, "五一做的"]);
  assert.ok(/\/logs\//.test(importedMeals[0].photo) && importedMeals[0].photo !== fileMeal.photo, "整桌照片重新传了");
  const importedLog = cloudDB.cook_logs.find((l) => l.dishId === LUROU && l.cookedAt === fileMeal.createdAt);
  assert.strictEqual(importedLog.mealId, importedMeals[0]._id, "记录跟着换成新的那一顿");
  ok("备份：每一顿和整桌照片也导出；导入时对上菜、换成新的那一顿，重复导入不重复");

  // ======== 一起做：备菜（先腌上、建议顺序、按份数算好）、按菜切换、计时器各走各的、退出了接着做、做好了去开饭 ========
  launchApp("me");
  svc("plan").clear();
  await flush();
  svc("plan").addMany({ [LUROU]: 1, [WINGS]: 2, [LETTUCE]: 1 });
  await flush();
  const basketC = newPage("pages/today/index");
  basketC.onShow();
  await flush();
  basketC.onStartCook();
  assert.deepStrictEqual(lastCall("toast"), ["toast", "先下单，再开始做"], "没下单不能开始做");
  await placeOrder();
  await basketC.refresh();
  assert.strictEqual(planDoc().order.no, 10, "编号接着开过饭的最大编号往下数（导入的那顿是 No.009）");
  basketC.onStartCook();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/cook/index?from=basket"]);
  const together = newPage("pages/cook/index");
  await together.onLoad({ from: "basket" });
  together.onShow();
  assert.strictEqual(together.data.tab, "prep", "第一页是备菜");
  assert.deepStrictEqual(together.data.sequence.map((x) => `${x.name} ${x.durationText}`), ["台式卤肉饭 90 分钟", "奥尔良鸡翅（空气炸锅版） 50 分钟", "莴笋炒肉 20 分钟"], "用时长的先做");
  assert.strictEqual(together.data.sequenceTip, "快手菜等台式卤肉饭快好了再下锅，差不多能一起出锅");
  assert.deepStrictEqual(together.data.waits.map((w) => `${w.dishName} 第${w.index + 1}步 ${w.timerText}`), ["奥尔良鸡翅 第2步 30 分钟", "莴笋炒肉 第1步 10 分钟"], "要腌的提前提醒");
  const wingPrep = together.data.prep.find((g) => g.dishId === WINGS);
  assert.deepStrictEqual([wingPrep.title, wingPrep.items.map((i) => `${i.name} ${i.amountText}`), wingPrep.seasonings], ["奥尔良鸡翅（空气炸锅版） · 2 份", ["鸡翅中/翅根 16个"], "奥尔良腌料、清水、蜂蜜"], "用量乘好份数，调料写一行");
  assert.deepStrictEqual(together.data.tabs.map((t) => `${t.label}${t.sub}`), ["备菜", "台式卤肉饭0/8", "奥尔良鸡翅0/5", "莴笋炒肉0/5"]);
  together.onTogglePrep(ev({ key: wingPrep.items[0].key }));
  assert.ok(together.data.prep.find((g) => g.dishId === WINGS).items[0].checked, "备好一样勾一样");
  // 先腌上鸡翅：点一下跳到鸡翅第 2 步，开始计时
  together.onJumpWait(ev({ id: WINGS, i: 1 }));
  assert.deepStrictEqual([together.data.tab, together.data.stepLabel], [WINGS, "第 2 / 5 步"]);
  together.onTimerMain(ev({ i: 1 }));
  together.stopTicking();
  // 回备菜页，按顺序开始做卤肉饭，开第 1 步的计时
  together.onTab(ev({ key: "prep" }));
  assert.strictEqual(together.data.startText, "开始做：台式卤肉饭");
  together.onStartCooking();
  assert.deepStrictEqual([together.data.tab, together.data.current], [LUROU, 0]);
  together.onTimerMain(ev({ i: 0 }));
  together.stopTicking();
  together.onNext();
  assertTimers(together.data.running.map((r) => r.label), ["奥尔良鸡翅 · 第 2 步 30:00", "台式卤肉饭 · 第 1 步 08:00"], "计时写着是哪道菜");
  // 切到别的菜，计时不停；卤肉饭到点了，弹窗写明是哪道菜，点「去看看」跳过去
  together.onTab(ev({ key: LETTUCE }));
  assert.deepStrictEqual([together.data.tab, together.data.current], [LETTUCE, 0]);
  timeOffset += 8 * 60 * 1000 + 1000;
  together.tick();
  together.stopTicking();
  await flush();
  assert.deepStrictEqual(lastCall("modal").slice(1), ["⏰ 时间到了", "台式卤肉饭 · 第 1 步：鸡蛋冷水下锅，水开后再煮 8 分钟，捞出泡凉水，剥壳备用。"]);
  assert.deepStrictEqual([together.data.tab, together.data.current], [LUROU, 0], "点「去看看」切到卤肉饭那一步");
  assertTimers(together.data.running.map((r) => r.label), ["奥尔良鸡翅 · 第 2 步 21:59"], "鸡翅的计时一直在走");
  // 微信被关掉了：菜篮页显示「继续做菜」；回来接着做，离开时到点的马上提醒
  together.onHide();
  together.onUnload();
  basketC.onShow();
  await flush();
  assert.deepStrictEqual(basketC.data.cooking, { done: 0, total: 3 });
  timeOffset += 22 * 60 * 1000;
  launchApp("me");
  const resumed = newPage("pages/cook/index");
  modalAnswers.push({ confirm: false }); // 「知道了」
  await resumed.onLoad({ from: "basket" });
  resumed.stopTicking();
  await flush();
  assert.ok(/奥尔良鸡翅 · 第 2 步/.test(lastCall("modal")[2]), "离开的时候鸡翅腌好了，回来马上提醒");
  assert.deepStrictEqual([resumed.data.tab, resumed.data.current, resumed.data.running.length], [LUROU, 0, 0], "接着上次那一步");
  assert.ok(resumed.prepChecked[wingPrep.items[0].key], "备菜也接着上次的");
  // 做好一道：自动切到下一道；点错了能改回来
  resumed.go(8);
  assert.strictEqual(resumed.data.stepLabel, "最后一步做完了");
  resumed.onDishDone();
  assert.deepStrictEqual([resumed.data.tab, lastCall("toast")], [WINGS, ["toast", "下一道：奥尔良鸡翅"]]);
  assert.deepStrictEqual(resumed.data.tabs.slice(1).map((t) => `${t.label}${t.sub}`), ["台式卤肉饭✓", "奥尔良鸡翅1/5", "莴笋炒肉0/5"]);
  resumed.onTab(ev({ key: LUROU }));
  resumed.onDishUndo();
  assert.strictEqual(resumed.data.dishDone, false);
  resumed.go(8);
  resumed.onDishDone();
  resumed.go(5);
  resumed.onDishDone();
  assert.strictEqual(resumed.data.tab, LETTUCE);
  // 莴笋还没做就开饭：做好了的两道勾上，莴笋先不勾，留在菜篮
  resumed.onServe();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/meal/index?from=cook"]);
  const mealC = newPage("pages/meal/index");
  await mealC.onLoad({ from: "cook" });
  assert.deepStrictEqual(mealC.data.dishes.filter((d) => d.checked).map((d) => d.dishId).sort(), [LUROU, WINGS].sort());
  assert.strictEqual(mealC.data.madeCount, 2);
  await mealC.onSave();
  await flush();
  assert.deepStrictEqual(planItems(), { [LETTUCE]: 1 });
  assert.strictEqual(cacheOf("cook_session"), undefined, "记好以后进度清掉");
  basketC.onShow();
  await flush();
  assert.strictEqual(basketC.data.cooking, null);
  ok("一起做：备菜（先腌上、建议顺序、按份数算好）、按菜切换、计时器各走各的、到点跳过去、退出了接着做、做好一道切下一道、开饭只勾做好的");

  // ======== 点菜单记录：进行中的那一单 + 开过饭的（新的在前，按月分组）；再来一单、分享这顿饭、在记录里看 ========
  // 没下单不能开饭
  const mealNoOrder = newPage("pages/meal/index");
  await mealNoOrder.onLoad({});
  assert.deepStrictEqual(lastCall("modal").slice(1), ["还没下单", "先下单，做好了再来开饭"]);
  assert.deepStrictEqual(lastCall("navigateBack"), ["navigateBack", 1]);
  // 入口：菜篮页最上面、「我的」页（basketC 是上次打开小程序时的页面，换一个新的）
  const basketF = newPage("pages/today/index");
  basketF.onShow();
  await flush();
  basketF.onOpenOrders();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/orders/index"]);
  const mineO = newPage("pages/mine/index");
  await mineO.refresh();
  assert.strictEqual(mineO.data.orderCount, 3, "开过饭的 3 单");
  mineO.onOpenOrders();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/orders/index"]);
  mineO.onOpenStats();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", "/pages/stats/index"], "「我的」里进做饭总结");
  // 再下一单（菜篮里还剩莴笋炒肉）
  await placeOrder();
  const ordersP = newPage("pages/orders/index");
  ordersP.onShow();
  await flush();
  assert.deepStrictEqual([ordersP.data.current.noText, ordersP.data.current.dishesText], ["No.011", "莴笋炒肉"], "最上面是正在进行的那单");
  const orderCards = [].concat(...ordersP.data.months.map((m) => m.cards));
  assert.deepStrictEqual(orderCards.map((c) => c.noText), ["No.010", "No.002", "No.009"], "开过饭的，新的在前（按哪天吃的排）");
  assert.deepStrictEqual([ordersP.data.count, ordersP.data.unnumbered, ordersP.data.months[ordersP.data.months.length - 1].title], [3, 0, "2025年5月"]);
  const meal10 = cloudDB.meals.find((m) => m.no === 10);
  assert.ok(orderCards[0].title.endsWith(` · ${meal10.meal}`) && orderCards[0].dishes.length === 2, orderCards[0].title);
  ordersP.onOpenCurrent();
  assert.deepStrictEqual(lastCall("switchTab"), ["switchTab", "/pages/today/index"]);
  // 分享这顿饭
  await ordersP.onShareMeal(ev({ id: orderCards[1]._id }));
  const orderImg = files[lastCall("shareImage")[1]];
  ["已开饭", "No.002", "台式卤肉饭"].forEach((t) => assert.ok(orderImg.includes(t), `图片上没有「${t}」：${orderImg}`));
  // 再来一单：按当时的份数放回菜篮（现在有点菜单，就是加菜）
  await ordersP.onReorder(ev({ id: orderCards[1]._id }));
  await flush();
  assert.deepStrictEqual([planItems()[LUROU], planItems()[WINGS], planItems()[LETTUCE]], [1, 2, 2]);
  assert.deepStrictEqual([lastCall("switchTab"), lastCall("toast")], [["switchTab", "/pages/today/index"], ["toast", "加进点菜单了"]], "已经下了单，就是给这单加菜");
  // 在记录里看：记录页打开就选中那天
  ordersP.onOpenDay(ev({ date: orderCards[1].date }));
  assert.deepStrictEqual(lastCall("switchTab"), ["switchTab", "/pages/logs/index"]);
  const logsDay = newPage("pages/logs/index");
  logsDay.onLoad();
  logsDay.onShow();
  await flush();
  assert.strictEqual(logsDay.data.selected, orderCards[1].date);
  // 撤掉的单不记
  const basketE = newPage("pages/today/index");
  basketE.onShow();
  await flush();
  basketE.onEditOrder();
  const coE2 = await openCheckout({ edit: "1" });
  modalAnswers.push({ confirm: true });
  await coE2.onCancelOrder();
  await flush();
  ordersP.onShow();
  await flush();
  assert.deepStrictEqual([ordersP.data.current, ordersP.data.count], [null, 3], "撤掉的单不记");
  svc("plan").clear();
  await flush();
  ok("点菜单记录：进行中的那单在最上面、开过饭的新的在前按月分组、撤掉的不记；再来一单、分享这顿饭、在记录里看；没下单不能开饭");

  // ======== 小本本：切换、打开时进哪本、新建（把个人本本的菜复制过去）、邀请卡片、家庭码 ========
  launchApp("me");
  const menuB = newPage("pages/menu/index");
  await menuB.onLoad();
  await flush();
  menuB.onOpenBooks();
  const sheetB = newComponent("components/book-sheet/index", { show: true });
  await flush();
  assert.deepStrictEqual(sheetB.data.books.map((b) => `${b.initial} ${b.name} ${b.sub}${b.current ? "（正在用）" : ""}`), [
    "我 我的小本本 个人 · 只有你能看",
    "家 我们家的小本本 家庭 · 小亮、小鱼（正在用）",
  ]);
  const myBookId = sheetB.data.books[0]._id;
  // 切到个人本本：菜单、菜篮都换成那本的
  sheetB.onPick(ev({ id: myBookId }));
  assert.deepStrictEqual(sheetB.events.slice(-2), [["close", undefined], ["switch", { id: myBookId }]]);
  await menuB.onBookSwitched();
  await flush();
  assert.deepStrictEqual([menuB.data.status, menuB.data.book.shortName, menuB.data.basketCount], ["welcome", "我的", 0], "个人本本是空的，菜篮也是这本的");
  assert.strictEqual(cloudDB.users.find((u) => u._id === "me").lastBook, myBookId, "记住上次用的是哪本");
  await menuB.onImportSamples(); // 个人本本里放几道示例菜，等会儿复制到新建的家庭本本
  const myCover = `cloud://test-env.1234/books/${myBookId}/covers/my-tomato.jpg`;
  cloudFiles[myCover] = { owner: "me", path: "http://tmp/my-tomato.jpg", content: "我的番茄炒蛋照片" };
  const myTomato = cloudDB.dishes.find((d) => d.bookId === myBookId && d.name === "番茄炒蛋");
  myTomato.cover = myCover;
  assert.strictEqual(cloudDB.dishes.filter((d) => d.bookId === myBookId).length, 11);
  // 打开小程序时进哪本：指定「我们家的小本本」
  sheetB.onOpenDefault();
  assert.deepStrictEqual(sheetB.data.options.map((o) => `${o.label}${o.on ? "✓" : ""}`), ["上次用的那本✓", "我的小本本", "我们家的小本本"]);
  await sheetB.onSetDefault(ev({ id: testBookId }));
  assert.deepStrictEqual([sheetB.data.picking, sheetB.data.defaultText], [false, "我们家的小本本"]);
  launchApp("me");
  await svc("book").ready();
  assert.strictEqual(svc("book").currentId(), testBookId, "上次用的是个人本本，但指定了进「我们家的小本本」");
  await newComponent("components/book-sheet/index", { show: true }).onSetDefault(ev({ id: "" }));
  launchApp("me");
  await svc("book").ready();
  assert.strictEqual(svc("book").currentId(), myBookId, "改回「上次用的那本」");

  // 新建家庭本本：名字不跟已有的重，「我在这本里叫」用别的本本里写过的；把个人本本的 11 道菜复制过去（分批复制，照片也复制一份）
  const newBook = newPage("pages/book-new/index");
  newBook.onLoad();
  await flush();
  assert.deepStrictEqual([newBook.data.name, newBook.data.myName, newBook.data.personalCount, newBook.data.full], ["家庭小本本", "小亮", 11, false]);
  newBook.onNameInput({ detail: { value: "周末厨房" } });
  newBook.onToggleCopy();
  const loadingsBefore = countCalls("loading");
  await newBook.onCreate();
  const weekendId = svc("book").currentId();
  assert.notStrictEqual(weekendId, myBookId, "建好就切到新的这本");
  assert.deepStrictEqual(lastCall("redirectTo"), ["redirectTo", `/pages/book/index?id=${weekendId}&created=1`]);
  assert.ok(calls.slice(-200).filter((c) => c[0] === "loading").map((c) => c[1]).includes("正在复制菜 11/11"), "复制的时候显示进度");
  assert.ok(countCalls("loading") - loadingsBefore >= 4, "一次复制几道，分几次");
  const weekendDishes = cloudDB.dishes.filter((d) => d.bookId === weekendId);
  assert.deepStrictEqual(weekendDishes.map((d) => d.name).sort(), cloudDB.dishes.filter((d) => d.bookId === myBookId).map((d) => d.name).sort());
  const weekendCats = cloudDB.categories.filter((c) => c.bookId === weekendId).sort((a, b) => a.sort - b.sort).map((c) => c.name);
  assert.deepStrictEqual(weekendCats, ["家常菜", "硬菜", "汤羹", "凉菜", "主食"], "分类按原来的顺序建好");
  const copiedTomato = weekendDishes.find((d) => d.name === "番茄炒蛋");
  assert.ok(copiedTomato.cover.startsWith(`cloud://test-env.1234/books/${weekendId}/covers/`) && cloudFiles[copiedTomato.cover].content === "我的番茄炒蛋照片", "照片复制到新的这本里");
  assert.ok(cloudFiles[myCover], "个人本本里的照片还在");
  assert.ok(weekendDishes.every((d) => cloudDB.categories.find((c) => c._id === d.categoryId).bookId === weekendId), "菜放进新这本的分类里");

  // 小本本设置：刚建好的提示、家庭码、复制、邀请卡片（点开就是加入页面，家庭码已经填好）
  const weekend = newPage("pages/book/index");
  weekend.onLoad({ id: weekendId, created: "1" });
  weekend.onShow();
  await settle();
  const weekendCode = cloudDB.books.find((b) => b._id === weekendId).code;
  assert.deepStrictEqual([weekend.data.created, weekend.data.codeChars.map((c) => c.ch).join(""), weekend.data.book.owner], [true, weekendCode, true]);
  weekend.onCopyCode();
  assert.strictEqual(clipboardText, weekendCode);
  const inviteShare = weekend.onShareAppMessage();
  assert.deepStrictEqual([inviteShare.title, inviteShare.path], ["小亮邀请你加入「周末厨房」", `/pages/join/index?code=${weekendCode}`]);
  assert.ok(files[inviteShare.imageUrl].includes(weekendCode.split("").join(" ")) && files[inviteShare.imageUrl].includes("「周末厨房」"), "邀请卡片的封面写着本本名字和家庭码");
  modalAnswers.push({ confirm: true, content: "周末小厨房" });
  await weekend.onRename();
  assert.strictEqual(cloudDB.books.find((b) => b._id === weekendId).name, "周末小厨房");
  ok("小本本：切换、打开时进哪本、新建时把个人本本的菜（连分类、照片）复制过去、设置页的家庭码和邀请卡片、改名");

  // ======== 申请加入：输错太多次要等、本主不同意、撤回、同意；换家庭码；5 本上限 ========
  launchApp("third");
  const thirdBook = svc("book");
  await thirdBook.ready();
  for (let i = 1; i <= 9; i++) {
    await assert.rejects(thirdBook.peek("ZZZZZZ"), (e) => e.code === "BAD_CODE" && e.message.includes(`还能试 ${10 - i} 次`));
  }
  await assert.rejects(thirdBook.peek("ZZZZZZ"), (e) => e.code === "TOO_MANY");
  await assert.rejects(thirdBook.peek(weekendCode), (e) => e.code === "TOO_MANY", "输错 10 次以后，对的也先不让试");
  timeOffset += 61 * 60 * 1000;
  const peeked = await thirdBook.peek(weekendCode);
  assert.deepStrictEqual([peeked.name, peeked.memberCount, peeked.dishCount, peeked.ownerName, peeked.status], ["周末小厨房", 1, 11, "小亮", ""], "过了一个小时又能试了");
  // 申请 → 本主不同意 → TA 收到通知
  assert.strictEqual(await thirdBook.requestJoin(weekendCode, "小三"), "pending");
  launchApp("me");
  const weekend2 = newPage("pages/book/index");
  weekend2.onLoad({ id: weekendId });
  weekend2.onShow();
  await flush();
  modalAnswers.push({ confirm: true });
  await weekend2.onReject(ev({ id: weekend2.data.requests[0].id, name: "小三" }));
  assert.deepStrictEqual(weekend2.data.requests, []);
  launchApp("third");
  await svc("book").refresh();
  await svc("book").showNotices();
  assert.deepStrictEqual(lastCall("modal").slice(1), ["没有加入", "「周末小厨房」的本主没有同意你加入"]);
  // 再申请 → 自己撤回（在切换面板里）
  assert.strictEqual(await svc("book").requestJoin(weekendCode, "小三"), "pending");
  const thirdSheet = newComponent("components/book-sheet/index", { show: true });
  await flush();
  modalAnswers.push({ confirm: true });
  await thirdSheet.onCancelRequest(ev({ id: weekendId, name: "周末小厨房" }));
  assert.deepStrictEqual(thirdSheet.data.pending, []);
  assert.deepStrictEqual(cloudDB.books.find((b) => b._id === weekendId).requests, {}, "本主那边也没有这个申请了");
  // 本主换了家庭码：旧的马上不能用
  launchApp("me");
  const weekend3 = newPage("pages/book/index");
  weekend3.onLoad({ id: weekendId });
  weekend3.onShow();
  await flush();
  modalAnswers.push({ confirm: true });
  await weekend3.onNewCode();
  const weekendCode2 = cloudDB.books.find((b) => b._id === weekendId).code;
  assert.ok(weekendCode2 !== weekendCode && weekend3.data.codeChars.map((c) => c.ch).join("") === weekendCode2);
  launchApp("third");
  await assert.rejects(svc("book").peek(weekendCode), (e) => e.code === "BAD_CODE", "旧的家庭码不能用了");
  // 用新的申请 → 同意了，TA 就是成员（不是本主，只能看家庭码，不能换）
  assert.strictEqual(await svc("book").requestJoin(weekendCode2, "小三"), "pending");
  launchApp("me");
  await svc("book").refresh();
  await svc("book").approve(weekendId, svc("book").get(weekendId).requests[0].id);
  launchApp("third");
  await svc("book").refresh();
  const thirdView = svc("book").get(weekendId);
  assert.deepStrictEqual([thirdView.owner, thirdView.code, thirdView.requests], [false, weekendCode2, []]);
  await assert.rejects(svc("book").newCode(weekendId), (e) => e.code === "NOT_OWNER");
  // 5 本上限：先申请「我们家的小本本」，再建 4 本就满了：第 6 本建不了、也申请不了，本主同意时也加不进来
  const familyCode2 = cloudDB.books.find((b) => b._id === testBookId).code;
  assert.strictEqual(await svc("book").requestJoin(familyCode2, "小三"), "pending");
  for (let i = 1; i <= 4; i++) await svc("book").create(`第 ${i} 本`, "小三");
  await assert.rejects(svc("book").create("第 5 本", "小三"), (e) => e.code === "LIMIT" && /最多加 5 本家庭本本/.test(e.message));
  await assert.rejects(svc("book").requestJoin(familyCode2, "小三"), (e) => e.code === "LIMIT");
  const lateApprove = await callAs("me", { action: "approve", bookId: testBookId, memberId: memberKeyOf(testBookId, "third") });
  assert.deepStrictEqual([lateApprove.ok, lateApprove.error.code, lateApprove.error.message], [false, "LIMIT", "TA 已经加了 5 本家庭本本，加不进来了"]);
  await callAs("me", { action: "reject", bookId: testBookId, memberId: memberKeyOf(testBookId, "third") });
  const thirdNew = newPage("pages/book-new/index");
  thirdNew.onLoad();
  await flush();
  assert.strictEqual(thirdNew.data.full, true, "新建页上直接说加不了了");
  await assert.rejects(svc("api").call("leaveBook", { bookId: svc("book").personalId() }), (e) => e.code === "PERSONAL", "个人本本不能退出");
  ok("申请加入：输错 10 次要等一个小时、本主不同意会通知、自己能撤回、换了家庭码旧的就不能用、同意了才是成员；最多 5 本家庭本本");

  // ======== 成员：本主移出别人（TA 正在用这本的话回到个人本本）；退出不用谁同意，本主退出了最早加入的人接着当；最后一个人退出，这本删掉 ========
  launchApp("partner");
  assert.strictEqual(await svc("book").requestJoin(weekendCode2, "小鱼"), "pending");
  launchApp("me");
  await svc("book").refresh();
  await svc("book").approve(weekendId, svc("book").get(weekendId).requests[0].id);
  launchApp("partner");
  const herMenuW = newPage("pages/menu/index");
  modalAnswers.push({ confirm: true }); // 加入成功 → 切换过去
  await herMenuW.onLoad();
  await flush();
  assert.strictEqual(svc("book").currentId(), weekendId);
  assert.strictEqual(herMenuW.allDishes.length, 11);
  // 我（本主）把对方移出了：对方的小程序还开着，隔一会儿回到菜单就回到个人本本，弹窗说一声
  const partnerMemberId = svc("book").get(weekendId).members.find((m) => m.label === "小鱼").id;
  const removed = await callAs("me", { action: "removeMember", bookId: weekendId, memberId: partnerMemberId });
  assert.ok(removed.ok, JSON.stringify(removed));
  timeOffset += 20 * 1000;
  herMenuW.onShow();
  await flush();
  assert.strictEqual(svc("book").currentId(), svc("book").personalId(), "回到个人本本");
  assert.deepStrictEqual(lastCall("modal").slice(1), ["不在这本里了", "「周末小厨房」的本主把你移出了这本"]);
  assert.strictEqual(herMenuW.data.book.shortName, "我的");
  await assert.rejects(svc("api").call("load", { bookId: weekendId }), (e) => e.code === "NOT_MEMBER");
  // 我（本主）退出：最早加入的人（小三）接着当本主；我正在用这本，回到个人本本，这本的缓存也清掉
  launchApp("me");
  svc("book").switchTo(weekendId);
  const meWeekendMenu = newPage("pages/menu/index");
  await meWeekendMenu.onLoad();
  await flush();
  assert.ok(dev()[`dev_cloud_cache@${weekendId}`], "这本的缓存");
  const weekend4 = newPage("pages/book/index");
  weekend4.onLoad({});
  weekend4.onShow();
  await flush();
  modalAnswers.push({ confirm: true });
  await weekend4.onLeave();
  assert.ok(/你是本主，退出以后最早加入的人接着当本主/.test(calls.filter((c) => c[0] === "modal").pop()[2]));
  const weekendRow = cloudDB.books.find((b) => b._id === weekendId);
  assert.deepStrictEqual([Object.keys(weekendRow.members), weekendRow.owner], [["third"], "third"]);
  assert.deepStrictEqual([svc("book").currentId(), lastCall("switchTab")], [myBookId, ["switchTab", "/pages/menu/index"]]);
  assert.strictEqual(dev()[`dev_cloud_cache@${weekendId}`], undefined, "退出的那本，手机上的缓存清掉");
  assert.strictEqual(cloudDB.dishes.filter((d) => d.bookId === weekendId).length, 11, "记的东西留在这本里");
  // 对方又来申请；小三是最后一个人，退出：这本连同菜、分类、菜篮、照片都删掉，申请的人收到通知
  launchApp("partner");
  assert.strictEqual(await svc("book").requestJoin(weekendCode2, "小鱼"), "pending");
  launchApp("third");
  svc("book").switchTo(weekendId);
  svc("plan").add(copiedTomato._id);
  await flush();
  assert.ok((cloudDB.plans || []).some((p) => p._id === `${weekendId}-current`), "这本的菜篮");
  const weekend5 = newPage("pages/book/index");
  weekend5.onLoad({ id: weekendId });
  weekend5.onShow();
  await flush();
  modalAnswers.push({ confirm: true });
  await weekend5.onLeave();
  assert.strictEqual(calls.filter((c) => c[0] === "modal").pop()[1], "删掉这本？");
  assert.ok(!cloudDB.books.some((b) => b._id === weekendId), "这本删掉了");
  assert.deepStrictEqual(
    [cloudDB.dishes.filter((d) => d.bookId === weekendId).length, cloudDB.categories.filter((c) => c.bookId === weekendId).length, (cloudDB.plans || []).filter((p) => p._id.startsWith(weekendId)).length],
    [0, 0, 0],
    "菜、分类、菜篮都删掉了"
  );
  assert.ok(!cloudFiles[copiedTomato.cover] && cloudFiles[myCover], "这本的照片删掉了，别的本里的照片还在");
  launchApp("partner");
  await svc("book").refresh();
  await svc("book").showNotices();
  assert.deepStrictEqual(lastCall("modal").slice(1), ["这本没有了", "「周末小厨房」已经删掉了，你的申请也没有了"]);
  assert.deepStrictEqual(svc("book").pending(), []);
  ok("成员：本主能移出别人（TA 正开着就回到个人本本）；退出不用谁同意，本主退出了最早加入的接着当；最后一个人退出，这本连同照片删掉，申请的人收到通知");

  // ======== 一道菜复制到另一本；点家人发来的卡片，切到那本；个人本本里不说「两个人」「对方」 ========
  launchApp("me");
  svc("book").switchTo(testBookId);
  const famDish = cloudDB.dishes.find((d) => d.bookId === testBookId && d.name === "莴笋炒肉");
  const detailC = newPage("pages/dish-detail/index");
  detailC.onLoad({ id: famDish._id });
  await flush();
  assert.strictEqual(detailC.data.canCopy, true, "还有别的本，能复制过去");
  // 只有一本可以去：问一下就复制；那本里没有「家常菜」分类，自动建一个
  await detailC.onCopyToBook();
  assert.strictEqual(lastCall("modal")[1], "复制到「我的小本本」？");
  const copiedLettuce = cloudDB.dishes.find((d) => d.bookId === myBookId && d.name === "莴笋炒肉");
  assert.ok(copiedLettuce && copiedLettuce._id !== famDish._id, "复制了一份到个人本本");
  assert.strictEqual(cloudDB.categories.find((c) => c._id === copiedLettuce.categoryId).bookId, myBookId);
  assert.ok(copiedLettuce.cover && copiedLettuce.cover.includes(`/books/${myBookId}/covers/`) && copiedLettuce.cover !== famDish.cover, "照片也复制了一份");
  assert.deepStrictEqual(lastCall("toast"), ["toast", "复制到「我的小本本」了"]);
  // 再复制一次：那本里已经有了
  await detailC.onCopyToBook();
  assert.deepStrictEqual(lastCall("modal").slice(1), ["没有复制", "「我的小本本」里已经有「莴笋炒肉」了"]);
  // 好几本可以去：选一本（取消就不复制）
  const extraBook = await svc("book").create("爸妈家", "小亮");
  svc("book").switchTo(testBookId);
  const detailC2 = newPage("pages/dish-detail/index");
  detailC2.onLoad({ id: famDish._id });
  await flush();
  const dishCountBefore = cloudDB.dishes.length;
  await detailC2.onCopyToBook();
  assert.deepStrictEqual(lastCall("actionSheet")[1], ["我的小本本", "爸妈家"]);
  assert.strictEqual(cloudDB.dishes.length, dishCountBefore, "取消了就不复制");
  sheetAnswers.push(1);
  await detailC2.onCopyToBook();
  assert.ok(cloudDB.dishes.some((d) => d.bookId === extraBook && d.name === "莴笋炒肉"));
  // 转发这道菜：带上是哪本；家人点开时，先切到那本再显示
  const dishShare = detailC2.onShareAppMessage();
  assert.strictEqual(dishShare.path, `/pages/dish-detail/index?id=${famDish._id}&book=${testBookId}`);
  launchApp("partner");
  svc("book").switchTo(svc("book").personalId() || cloudDB.users.find((u) => u._id === "partner").personalBookId);
  await flush();
  const herDetail = newPage("pages/dish-detail/index");
  herDetail.onLoad({ id: famDish._id, book: testBookId });
  await flush();
  assert.deepStrictEqual([svc("book").currentId(), herDetail.data.dish && herDetail.data.dish.name], [testBookId, "莴笋炒肉"], "点卡片打开，切到了那本");
  // 不在那本里：不切，显示找不到
  launchApp("third");
  await svc("book").ready();
  const thirdBefore = svc("book").currentId();
  const thirdDetail = newPage("pages/dish-detail/index");
  thirdDetail.onLoad({ id: famDish._id, book: testBookId });
  await flush();
  assert.deepStrictEqual([svc("book").currentId(), thirdDetail.data.notFound], [thirdBefore, true]);
  // 个人本本里的说法：不说「两个人」「对方」
  launchApp("me");
  svc("book").switchTo(myBookId);
  const myBasket = newPage("pages/today/index");
  myBasket.onLoad({});
  myBasket.onShow();
  await flush();
  assert.strictEqual(myBasket.data.shared, false);
  assert.deepStrictEqual(classOf("pages/today/index", "empty-desc", {}), ["empty-desc"]);
  const todayWxml = fs.readFileSync(path.join(root, "pages/today/index.wxml"), "utf8");
  assert.ok(!/两个人|对方/.test(todayWxml), "菜篮页上的说法跟着本本变");
  const myMenu = newPage("pages/menu/index");
  await myMenu.onLoad();
  await flush();
  modalAnswers.push({ confirm: false });
  await myMenu.onClearCart();
  assert.deepStrictEqual(lastCall("modal").slice(1), ["清空菜篮？", "点的菜都拿掉，买菜清单的勾选也清掉。库存不受影响。"]);
  const myEdit = newPage("pages/dish-edit/index");
  await myEdit.onLoad({ id: copiedLettuce._id });
  modalAnswers.push({ confirm: false });
  await myEdit.onDelete();
  assert.strictEqual(lastCall("modal")[2], "删除后照片也会一起删掉，找不回来。");
  const myMine = newPage("pages/mine/index");
  await myMine.refresh();
  assert.deepStrictEqual([myMine.data.footerText, myMine.data.book.family], ["「我的小本本」只有你能看", false]);
  ok("一道菜复制到另一本（照片、分类一起；已经有了不重复）；点家人发来的卡片会切到那本；个人本本里的说法不说「两个人」「对方」");

  // 复制到的那本已经不在了（在别的手机上退出了）：说清楚，正在用的这本不受影响
  launchApp("me");
  svc("book").switchTo(testBookId);
  await svc("book").refresh();
  const leftElsewhere = await callAs("me", { action: "leaveBook", bookId: extraBook });
  assert.ok(leftElsewhere.ok && leftElsewhere.data.deleted, "在别的手机上退出了「爸妈家」（最后一个人，这本删掉了）");
  const detailL = newPage("pages/dish-detail/index");
  detailL.onLoad({ id: famDish._id });
  await flush();
  sheetAnswers.push(1);
  await detailL.onCopyToBook();
  assert.deepStrictEqual(lastCall("modal").slice(1), ["没复制成", "你已经不在这本小本本里了"]);
  assert.strictEqual(svc("book").currentId(), testBookId, "正在用的这本没受影响");
  assert.ok(!svc("book").has(extraBook), "不在的那本从列表里拿掉了");
  // 对方被移出了「我们家的小本本」：再打开小程序时进自己的本本，弹窗说一声
  await callAs("me", { action: "removeMember", bookId: testBookId, memberId: memberKeyOf(testBookId, "partner") });
  launchApp("partner");
  const herMenuL = newPage("pages/menu/index");
  await herMenuL.onLoad();
  await flush();
  assert.deepStrictEqual([svc("book").currentId(), herMenuL.data.book.shortName], [cloudDB.users.find((u) => u._id === "partner").personalBookId, "我的"]);
  assert.deepStrictEqual(lastCall("modal").slice(1), ["不在这本里了", "「我们家的小本本」的本主把你移出了这本"]);
  ok("复制到的那本已经不在了：说清楚，不影响正在用的这本；被移出以后再打开，进自己的本本并说一声");

  // ======== 旧数据变成家庭本本：以前大家共用一份数据（记录上没有 bookId），新版本第一次打开时自动变成「我们家的小本本」 ========
  Object.keys(cloudDB).forEach((k) => delete cloudDB[k]);
  Object.keys(cloudFiles).forEach((k) => delete cloudFiles[k]);
  Object.keys(devices).forEach((k) => {
    devices[k] = {};
  });
  const t0 = new Date(2026, 9, 1, 12).getTime();
  const oldCover = "cloud://test-env.1234/covers/old-wings.jpg";
  const oldThumb = "cloud://test-env.1234/thumbs/old-wings.jpg";
  cloudFiles[oldCover] = { owner: "partner", path: "http://tmp/old.jpg" };
  cloudFiles[oldThumb] = { owner: "partner", path: "http://tmp/old-s.jpg" };
  cloudDB.categories = [{ _id: "c-old", _openid: "partner", name: "家常菜", sort: 1, createdAt: t0 }];
  cloudDB.dishes = [
    { _id: "d-old1", _openid: "partner", name: "可乐鸡翅", categoryId: "c-old", cover: oldCover, coverThumb: oldThumb, createdAt: t0 + 1, updatedAt: t0 + 1 },
    { _id: "d-old2", _openid: "me", name: "番茄炒蛋", categoryId: "c-old", createdAt: t0 + 2, updatedAt: t0 + 2 },
  ];
  cloudDB.cook_logs = [{ _id: "l-old", _openid: "me", dishId: "d-old2", dishName: "番茄炒蛋", cookedAt: t0 + 3, createdAt: t0 + 3 }];
  cloudDB.meals = [];
  cloudDB.plans = [
    { _id: "current", _openid: "me", items: { "d-old1": 2 }, checked: {}, extras: {}, createdAt: t0 + 4 },
    { _id: "pantry", _openid: "partner", items: { salt: { name: "盐", inStock: true } }, createdAt: t0 + 5 },
  ];
  devices.me.dev_cloud_cache = { categories: [], dishes: [], logs: [], meals: [] }; // 旧版本留下的不分本本的缓存
  devices.me.dev_plan_cache = { items: {} };
  testBookId = "legacy";
  const welcomes = () => calls.filter((c) => c[0] === "modal" && c[1] === "小本本来啦");
  const welcomeBefore = welcomes().length;
  launchApp("me");
  const legacyMenu = newPage("pages/menu/index");
  await legacyMenu.onLoad();
  await flush();
  const legacyBook = cloudDB.books.find((b) => b._id === "legacy");
  assert.ok(legacyBook && legacyBook.type === "family" && legacyBook.name === "我们家的小本本", JSON.stringify(legacyBook));
  assert.deepStrictEqual(Object.keys(legacyBook.members).sort(), ["me", "partner"], "旧数据里加过东西的人都在里面，不用申请");
  assert.strictEqual(legacyBook.owner, "me", "打开新版本的人当本主");
  assert.strictEqual(svc("book").currentId(), "legacy", "第一次打开就进这本，跟以前一样");
  assert.deepStrictEqual(legacyMenu.allDishes.map((d) => d.name), ["可乐鸡翅", "番茄炒蛋"]);
  assert.deepStrictEqual([legacyMenu.data.basketCount, svc("pantry").list().inStock.map((i) => i.name)], [2, ["盐"]], "菜篮、库存也还在");
  assert.strictEqual((await dishNow("番茄炒蛋")).cookCount, 1, "做菜记录也还在");
  assert.ok(["categories", "dishes", "cook_logs"].every((n) => cloudDB[n].every((r) => r.bookId === "legacy")), "旧记录顺手补上了 bookId");
  assert.strictEqual(welcomes().length, welcomeBefore + 1, "第一次打开说一声数据去哪了");
  assert.ok(/都放进了「我们家的小本本」，你和 TA 都已经在里面[\s\S]*「我的小本本」/.test(welcomes().pop()[2]), welcomes().pop()[2]);
  assert.ok(!("dev_cloud_cache" in dev()) && !("dev_plan_cache" in dev()), "以前不分本本的缓存清掉了");
  assert.deepStrictEqual(svc("book").list().map((b) => b.name), ["我的小本本", "我们家的小本本"], "另外还有一本自己的个人本本");
  const oldImg = newComponent(IMG, { src: oldThumb });
  await settle();
  assert.ok(/^https:\/\/tmp\.tcb\//.test(oldImg.data.url), "以前的照片（路径里没有 books/）算这本的，本里的人都看得到");
  // 对方（旧数据里也加过东西）：直接进这本，不用输家庭码
  launchApp("partner");
  const herLegacy = newPage("pages/menu/index");
  await herLegacy.onLoad();
  await flush();
  assert.strictEqual(svc("book").currentId(), "legacy");
  assert.deepStrictEqual(herLegacy.allDishes.map((d) => d.name), ["可乐鸡翅", "番茄炒蛋"]);
  assert.strictEqual(welcomes().length, welcomeBefore + 2, "对方第一次打开也说一声");
  assert.strictEqual(cloudDB.books.filter((b) => b.legacy).length, 1, "只建了一本");
  // 没在旧数据里加过东西的体验成员：只有自己的本本，读不到这本
  launchApp("third");
  const thirdMenu = newPage("pages/menu/index");
  await thirdMenu.onLoad();
  await flush();
  assert.deepStrictEqual([svc("book").current().name, thirdMenu.data.status, welcomes().length], ["我的小本本", "welcome", welcomeBefore + 2]);
  assert.strictEqual(thirdMenu.data.welcomeHint, "这是只有你能看的「我的小本本」。想和家人一起记，点左上角新建或者加入家庭本本");
  await assert.rejects(svc("api").call("load", { bookId: "legacy" }), (e) => e.code === "NOT_MEMBER");
  const thirdImg = newComponent(IMG, { src: oldThumb });
  await settle();
  assert.strictEqual(thirdImg.data.url, "", "也看不到这本的照片");
  // 过渡期间：还没更新的手机（旧版本）直接写数据库，新加的菜没有 bookId，也算这本的；菜篮还是同一条
  partnerWrites(() => {
    cloudDB.dishes.push({ _id: "d-old3", _openid: "partner", name: "清蒸鲈鱼", categoryId: "c-old", createdAt: Date.now(), updatedAt: Date.now() });
    cloudDB.plans.find((p) => p._id === "current").items["d-old3"] = 1;
  });
  launchApp("me");
  const meLegacy = newPage("pages/menu/index");
  await meLegacy.onLoad();
  await flush();
  assert.ok(meLegacy.allDishes.some((d) => d.name === "清蒸鲈鱼"), "旧版本加的菜也看得到");
  assert.strictEqual(welcomes().length, welcomeBefore + 2, "只说一次");
  assert.strictEqual(meLegacy.data.basketCount, 3, "旧版本点的菜，菜篮里也有");
  assert.strictEqual(rowOf("清蒸鲈鱼").bookId, "legacy", "读到的时候补上了 bookId");
  meLegacy.onPlus(ev({ id: "d-old2" }));
  await flush();
  assert.deepStrictEqual(planItems(), { "d-old1": 2, "d-old3": 1, "d-old2": 1 }, "新版本点的菜写进原来那条菜篮，旧版本也看得到");
  ok("旧数据变成家庭本本：大家自动在里面、本主是先打开的人、菜篮库存记录照片都在、只说一次；别人进不来；旧版本新加的也算这本");

  // 两台手机同时第一次打开新版本：也只建一本
  Object.keys(cloudDB).forEach((k) => delete cloudDB[k]);
  cloudDB.dishes = [
    { _id: "x1", _openid: "partner", name: "老菜", createdAt: 1 },
    { _id: "x2", _openid: "me", name: "另一道老菜", createdAt: 2 },
  ];
  const both = await Promise.all([callAs("me", { action: "boot" }), callAs("partner", { action: "boot" })]);
  assert.ok(both.every((r) => r.ok && r.data.openBookId === "legacy"), JSON.stringify(both));
  assert.strictEqual(cloudDB.books.filter((b) => b._id === "legacy").length, 1);
  assert.deepStrictEqual(Object.keys(cloudDB.books.find((b) => b._id === "legacy").members).sort(), ["me", "partner"]);
  assert.strictEqual(cloudDB.books.filter((b) => b.type === "personal").length, 2, "每人一本个人本本");
  const again2 = await callAs("me", { action: "boot" });
  assert.strictEqual(cloudDB.books.length, 3, "再打开不会多建");
  assert.strictEqual(again2.data.welcome, null);
  // 没有旧数据（新装的）：不建这本
  Object.keys(cloudDB).forEach((k) => delete cloudDB[k]);
  const fresh = await callAs("me", { action: "boot" });
  assert.deepStrictEqual([fresh.data.books.map((b) => b.name), fresh.data.openBookId === fresh.data.me.personalBookId], [["我的小本本"], true]);
  ok("两台手机同时第一次打开也只建一本；新装的没有旧数据就不建");
}

staticChecks();
smoke()
  .then(() => {
    console.log(failures ? `\n${failures} static check(s) failed` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.log("FAIL smoke test:", e.stack);
    process.exit(1);
  });
