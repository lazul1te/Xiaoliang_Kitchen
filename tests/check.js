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
// permission 模拟集合权限：
//   shared        自定义安全规则 { read: true, write: true }（正确设置）
//   readAll       基础权限「所有用户可读，仅创建者可写」：能看到对方的，改对方的会「改了 0 条」
//   creatorOnly   基础权限「仅创建者可读写」：只看得到自己的
//   rulesCreator  自定义安全规则只允许创建者：查询不带 _openid 条件直接拒绝
let permission = "shared";
let currentUser = "me"; // 当前是哪台手机
const devices = { me: {}, partner: {} }; // 每台手机自己的本地缓存
const dev = () => devices[currentUser];
const cloudDB = {}; // 集合名 → 记录数组；没有这个 key = 集合不存在
const cloudFiles = {}; // fileID → { owner, path }
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

function rowsOf(name) {
  if (!cloudInits) throw new Error("请先调用 wx.cloud.init() 完成初始化后再调用其他云 API");
  if (offline) throw cloudError("request:fail timeout");
  if (!cloudDB[name]) {
    throw cloudError(
      `collection.count:fail -502005 database collection not exists. [ResourceNotFound] Db or Table not exist: ${name}`,
      -502005
    );
  }
  return cloudDB[name];
}

const canSee = (row) => (permission === "creatorOnly" || permission === "rulesCreator" ? row._openid === currentUser : true);
const canWrite = (row) => permission === "shared" || row._openid === currentUser;

function makeQuery(name, opts) {
  const next = (patch) => makeQuery(name, Object.assign({}, opts, patch));
  const visible = () => {
    const rows = rowsOf(name);
    if (permission === "rulesCreator" && !(opts.where && opts.where._openid === "{openid}")) throw permissionDenied();
    let list = rows.filter(canSee);
    if (opts.where) {
      list = list.filter((r) =>
        Object.keys(opts.where).every((k) => r[k] === (opts.where[k] === "{openid}" ? currentUser : opts.where[k]))
      );
    }
    return list;
  };
  return {
    where: (cond) => next({ where: cond }),
    orderBy: (field, dir) => next({ orders: opts.orders.concat([[field, dir]]) }),
    skip: (n) => next({ skip: n }),
    limit: (n) => next({ limit: Math.min(n, 20) }),
    get: async () => {
      const list = visible().slice();
      list.sort((a, b) => {
        for (const [f, d] of opts.orders) {
          if (a[f] < b[f]) return d === "asc" ? -1 : 1;
          if (a[f] > b[f]) return d === "asc" ? 1 : -1;
        }
        return 0;
      });
      return { data: clone(list.slice(opts.skip, opts.skip + Math.min(opts.limit, 20))) };
    },
    count: async () => ({ total: visible().length }),
  };
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

function makeCollection(name) {
  const findRow = (id) => rowsOf(name).find((r) => r._id === id);
  // 改 / 删一条记录前的权限判断：返回 false 表示「改了 0 条」
  const writable = (row) => {
    if (!row || !canSee(row)) {
      if (row && permission === "rulesCreator") throw permissionDenied();
      return false;
    }
    if (canWrite(row)) return true;
    if (permission === "rulesCreator") throw permissionDenied();
    return false;
  };
  return Object.assign(makeQuery(name, { skip: 0, limit: 20, orders: [] }), {
    add: async ({ data }) => {
      if ("_openid" in data) throw new Error("add() 的 data 里不该有 _openid");
      if ("_id" in data && !data._id) throw new Error("add() 的 _id 不能是空的");
      const rows = rowsOf(name);
      if (data._id && rows.some((r) => r._id === data._id)) {
        throw cloudError("collection.add:fail -502001 database request fail. duplicate key error, dup key: { _id }");
      }
      const _id = data._id || `id${++idSeq}`;
      rows.push(Object.assign(clone(data), { _id, _openid: currentUser }));
      return { _id };
    },
    doc: (id) => ({
      get: async () => {
        const row = findRow(id);
        if (!row || !canSee(row)) throw cloudError(`document.get:fail document with _id ${id} does not exist`);
        return { data: clone(row) };
      },
      update: async ({ data }) => {
        const row = findRow(id);
        if (!writable(row)) return { stats: { updated: 0 } };
        Object.keys(data).forEach((k) => {
          const v = data[k];
          if (k === "_id" || k === "_openid") throw new Error("update() 不能改 _id / _openid");
          if (Array.isArray(v)) throw new Error(`update() 的数组字段 ${k} 要用 _.set() 包起来`);
          applyUpdate(row, k, v);
        });
        return { stats: { updated: 1 } };
      },
      remove: async () => {
        const row = findRow(id);
        if (!writable(row)) return { stats: { removed: 0 } };
        const list = rowsOf(name);
        list.splice(list.indexOf(row), 1);
        return { stats: { removed: 1 } };
      },
    }),
  });
}

// ---------------- 假的 wx、Page、App ----------------
const calls = [];
const modalAnswers = []; // 依次弹出的 showModal 怎么回答：{ confirm, content }
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
      return {
        collection: makeCollection,
        command: {
          set: (value) => ({ __op: "set", value }),
          inc: (value) => ({ __op: "inc", value }),
          remove: () => ({ __op: "remove" }),
        },
      };
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
  showToast: (o) => calls.push(["toast", o.title]),
  showLoading: (o) => calls.push(["loading", o.title]),
  hideLoading: () => calls.push(["hideLoading"]),
  navigateTo: (o) => calls.push(["navigateTo", o.url]),
  redirectTo: (o) => {
    calls.push(["redirectTo", o.url]);
    if (o.success) o.success();
  },
  navigateBack: (o = {}) => {
    calls.push(["navigateBack", o.delta || 1]);
    if (o.success) o.success();
  },
  switchTab: (o) => calls.push(["switchTab", o.url]),
  setNavigationBarTitle: (o) => calls.push(["title", o.title]),
  enableAlertBeforeUnload: () => calls.push(["alertOn"]),
  disableAlertBeforeUnload: (o) => {
    calls.push(["alertOff"]);
    if (o && o.complete) o.complete();
  },
  showModal: (o) => {
    const answer = modalAnswers.length ? modalAnswers.shift() : { confirm: true };
    calls.push(["modal", o.title, o.content || ""]);
    const res = { confirm: !!answer.confirm, cancel: !answer.confirm, content: answer.content || "" };
    if (o.success) o.success(res);
    if (o.complete) o.complete(res);
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
});
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

// 云函数端的 wx-server-sdk：管理员身份，不受存储权限限制
let tempUrlSeq = 0;
const fakeServerSdk = {
  DYNAMIC_CURRENT_ENV: "current-env",
  init: () => {},
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
    return { fileContent: Buffer.from(`照片内容:${fileID}`), statusCode: 200 };
  },
};
const Module = require("module");
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "wx-server-sdk") return fakeServerSdk;
  return realLoad.call(this, request, parent, isMain);
};
const photoFunctionFile = path.join(root, "../cloudfunctions/photo/index.js");
let photoFunctionDeployed = true; // 云函数 photo 上传部署了没有
global.wx.cloud.callFunction = async ({ name, data }) => {
  if (!cloudInits) throw new Error("请先调用 wx.cloud.init()");
  calls.push(["callFunction", name, data.action, (data.fileIDs || []).length]);
  if (name !== "photo" || !photoFunctionDeployed) {
    throw cloudError("cloud.callFunction:fail -501000 [ResourceNotFound.Function] 未找到指定的Function，请创建后再试。", -501000);
  }
  return { result: clone(await require(photoFunctionFile).main(clone(data), {})) };
};
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
    const q = {
      select: () => q,
      selectAll: () => q,
      boundingClientRect: () => q,
      exec: (cb) => cb([{ top: 100 }, page.data.sections.map((s, i) => ({ top: 100 + i * 400 }))]),
    };
    return q;
  };
  return page;
}

const lastCall = (type) => calls.filter((c) => c[0] === type).pop();
const countCalls = (type) => calls.filter((c) => c[0] === type).length;
const ev = (dataset, detail) => ({ currentTarget: { dataset }, detail: detail || {} });
// 按 WXML 里写的 class 表达式，算出某个元素实际有哪些 class（{{ }} 里是普通的 JS 表达式）
function classOf(pagePath, marker, scope) {
  const wxml = fs.readFileSync(path.join(root, pagePath + ".wxml"), "utf8");
  const m = wxml.match(new RegExp(`class="(${marker}[^"]*)"`));
  assert.ok(m, `${pagePath}.wxml 里找不到 class="${marker}…"`);
  const names = Object.keys(scope);
  const value = (expr) => new Function(...names, `return (${expr});`)(...names.map((k) => scope[k]));
  return m[1].replace(/\{\{(.+?)\}\}/g, (_, expr) => String(value(expr) || "")).split(/\s+/).filter(Boolean);
}
const rowOf = (name) => cloudDB.dishes.find((d) => d.name === name);
const planDoc = () => (cloudDB.plans || []).find((p) => p._id === "current") || {};
const sharedDoc = (id) => (cloudDB.plans || []).find((p) => p._id === id) || {};
const svc = (name) => require(path.join(root, "services", name)); // 这次打开的模块（页面用的是同一份）
const dishNow = async (name) => (await svc("dish").listDishes()).find((d) => d.name === name);
const planItems = () => planDoc().items || {};
const idOf = (name) => rowOf(name)._id;
const catOf = (name) => cloudDB.categories.find((c) => c.name === name)._id;

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
  wxmlFiles.push(path.join(root, "templates/dish-card.wxml"));
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
  assert.ok(dev().dev_cloud_cache && dev().dev_cloud_cache.dishes.length === 11, "云上数据要缓存到本地（开发版 key 带 dev_）");
  ok("welcome → 放示例菜 → 5 个分类、11 道菜");

  // ---- 点菜、搜索、左右联动 ----
  menu.onPlus(ev({ id: idOf("番茄炒蛋") }));
  menu.onPlus(ev({ id: idOf("番茄炒蛋") }));
  menu.onPlus(ev({ id: idOf("可乐鸡翅") }));
  assert.strictEqual(menu.data.basketCount, 3);
  assert.deepStrictEqual(menu.data.basketByCat, { [catOf("家常菜")]: 2, [catOf("硬菜")]: 1 });
  assert.deepStrictEqual(lastCall("badge"), ["badge", "3"]);
  await flush();
  assert.deepStrictEqual(planItems(), { [idOf("番茄炒蛋")]: 2, [idOf("可乐鸡翅")]: 1 }, "今日菜单存到云上");
  menu.onMinus(ev({ id: idOf("番茄炒蛋") }));
  assert.strictEqual(menu.data.basketCount, 2);
  await flush();
  assert.deepStrictEqual(planItems(), { [idOf("番茄炒蛋")]: 1, [idOf("可乐鸡翅")]: 1 });
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
  assert.strictEqual(edit.data.timerStep, -1, "选好就收起来");
  // 自定义时长：写「1分30秒」；写不明白的提示一下；「不计时」清掉
  edit.onOpenTimer(ev({ i: 0 }));
  modalAnswers.push({ confirm: true, content: "1分30秒" });
  await edit.onCustomTimer();
  assert.deepStrictEqual([edit.data.form.steps[0].timer, edit.data.form.steps[0].timerText, edit.data.timerStep], [90, "1 分 30 秒", -1]);
  edit.onOpenTimer(ev({ i: 0 }));
  assert.strictEqual(edit.data.timerCurrent, 90, "打开时标出现在的时长");
  modalAnswers.push({ confirm: true, content: "一会儿" });
  await edit.onCustomTimer();
  assert.deepStrictEqual(lastCall("toast"), ["toast", "没看懂，写成「25分钟」「1分30秒」这样"]);
  assert.strictEqual(edit.data.timerStep, 0, "没看懂就先不关面板");
  edit.onNoTimer();
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
  assert.deepStrictEqual(Object.keys(cloudFiles), [], "删菜时照片一起删");
  await flush();
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

  // ---- 今日：点的菜 + 买菜清单 ----
  const today = newPage("pages/today/index");
  today.onShow();
  await flush();
  assert.deepStrictEqual(today.data.items.map((i) => i.name), ["番茄炒蛋"]);
  assert.deepStrictEqual(show(today.data.shopping.buy), ["鸡蛋 3个", "番茄 2个", "葱 1根"]);
  await today.onPlus(ev({ id: idOf("番茄炒蛋") }));
  await flush();
  assert.strictEqual(today.data.count, 2);
  assert.deepStrictEqual(show(today.data.shopping.buy), ["鸡蛋 6个", "番茄 4个", "葱 2根"], "份数变了，用量跟着变");
  const eggKey = today.data.shopping.buy[0].key;
  await today.onToggleItem(ev({ key: eggKey }));
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
  modalAnswers.push({ confirm: true });
  await today.onClear();
  await flush();
  assert.strictEqual(today.data.hasPlan, false);
  assert.deepStrictEqual(planItems(), {});
  newPage("pages/logs/index").onShow();
  ok("today：份数变了用量跟着变、勾选、自己加的、清空，都存到云上");

  // ======== 烹饪模式 ========
  const tomatoId = idOf("番茄炒蛋");
  pageStack = [menu];
  const det2 = newPage("pages/dish-detail/index");
  det2.onLoad({ id: tomatoId });
  await flush();
  pageStack.push(det2);
  det2.onStartCook();
  assert.deepStrictEqual(lastCall("navigateTo"), ["navigateTo", `/pages/cook/index?id=${tomatoId}`]);
  const cook = newPage("pages/cook/index");
  await cook.onLoad({ id: tomatoId });
  cook.onShow();
  assert.deepStrictEqual(lastCall("keepScreenOn"), ["keepScreenOn", true], "做菜时屏幕常亮");
  assert.deepStrictEqual([cook.data.total, cook.data.stepLabel, cook.data.steps[0].timerText], [5, "第 1 / 5 步", "00:30"]);
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
  assert.deepStrictEqual(cook.data.running.map((r) => r.label), ["第 1 步 00:20", "第 4 步 01:50"]);
  cook.onTimerMain(ev({ i: 3 })); // 暂停第 4 步
  cook.stopTicking();
  assert.deepStrictEqual([cook.data.steps[3].timerState, cook.data.steps[3].timerAction], ["paused", "继续"]);
  timeOffset += 25 * 1000;
  cook.tick();
  assert.deepStrictEqual([cook.data.steps[0].timerState, cook.data.steps[0].timerText], ["done", "00:00"]);
  assert.ok(lastCall("vibrate") && lastCall("sound"), "时间到了要震动、响铃");
  assert.strictEqual(lastCall("sound")[1], "http://usr/ding.wav");
  assert.strictEqual(lastCall("modal")[1], "⏰ 时间到了");
  assert.strictEqual(cook.data.steps[3].timerText, "01:50", "暂停的计时不再走");
  cook.onTimerReset(ev({ i: 3 }));
  assert.deepStrictEqual([cook.data.steps[3].timerState, cook.data.steps[3].timerText], ["idle", "02:00"]);
  assert.strictEqual(lastCall("alertOff")[0], "alertOff");
  cook.onToggleIngredients();
  assert.deepStrictEqual(cook.data.dish.ingredientGroups.map((g) => g.label), ["主料", "辅料", "调料"]);
  cook.onToggleIngredients();
  cook.go(5);
  assert.strictEqual(cook.data.stepLabel, "做好啦");
  cook.onFinish();
  assert.deepStrictEqual(lastCall("redirectTo"), ["redirectTo", `/pages/log-edit/index?dishId=${tomatoId}`]);
  cook.onHide();
  cook.onUnload();
  assert.deepStrictEqual(lastCall("keepScreenOn"), ["keepScreenOn", false]);
  ok("cook：翻页、两个计时同时走、暂停/重置、到点响铃震动、看原料、做好了去打卡");

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
  assert.deepStrictEqual(logsPage.data.stats, { thisMonth: 1, total: 2, dishCount: 1 });
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
  assert.ok(/^拿手菜小本本备份-\d{8}\.json$/.test(lastCall("shareFile")[1]), lastCall("shareFile")[1]);
  ok(`导出：不带照片 / 带 2 张照片，发到聊天（${exp.data.file.sizeText}）`);

  // ======== 两个人共用 ========

  // 我先点一道菜，等会儿看对方那边能不能看到
  menu.onPlus(ev({ id: idOf("番茄炒蛋") }));
  await flush();

  // 对方的手机：第一次打开就看到同一本菜谱、同一份今日菜单，能加菜，也能改我加的菜
  launchApp("partner");
  const pMenu = newPage("pages/menu/index");
  await pMenu.onLoad();
  await flush();
  assert.strictEqual(pMenu.data.status, "ready", "对方打开看到的是同一本菜谱，不是欢迎页");
  assert.deepStrictEqual(pMenu.allDishes.map((d) => d.name), ["番茄炒蛋"]);
  assert.strictEqual(pMenu.data.basketCount, 1, "今日菜单两个人共用");
  const pLogs = newPage("pages/logs/index");
  pLogs.onShow();
  await flush();
  assert.deepStrictEqual(
    [pLogs.data.stats.total, pLogs.data.months[0].days[0].logs[0].cook],
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
  assert.strictEqual(rowOf("红糖糍粑")._openid, "partner");
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
    cloudDB.dishes.push({ _id: "p1", _openid: "partner", name: "酸辣土豆丝", categoryId: catOf("家常菜"), createdAt: Date.now() })
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
  assert.deepStrictEqual(lastCall("modal").slice(1), ["保存失败", "这道菜已经被删掉了，可能是对方刚删的"]);
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

  // ======== 集合权限设错的几种情况 ========

  // 「所有用户可读，仅创建者可写」：看得到对方的菜，但改不了，要提示原因而不是假装保存成功
  permission = "readAll";
  launchApp("partner");
  const pEdit3 = newPage("pages/dish-edit/index");
  await pEdit3.onLoad({ id: idOf("番茄炒蛋") });
  pEdit3.onInput(ev({ field: "tips" }, { value: "改不了的" }));
  await pEdit3.onSave();
  assert.strictEqual(lastCall("modal")[1], "保存失败");
  assert.ok(/^没改成/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  assert.strictEqual(rowOf("番茄炒蛋").tips, "我改的");
  modalAnswers.push({ confirm: true });
  await pEdit3.onDelete();
  assert.strictEqual(lastCall("modal")[1], "删除失败");
  assert.ok(rowOf("番茄炒蛋"), "删不掉对方的菜时，菜还在");

  // 「仅创建者可读写」：对方只看得到自己加的菜，看不到我的（菜单是空的时候，欢迎页上有提示）
  permission = "creatorOnly";
  devices.partner = {};
  launchApp("partner");
  const pMenu2 = newPage("pages/menu/index");
  await pMenu2.onLoad();
  assert.deepStrictEqual(pMenu2.allDishes.map((d) => d.name), ["醋溜土豆丝"]);

  // 自定义安全规则只允许创建者：直接报权限错误，提示怎么改
  permission = "rulesCreator";
  devices.partner = {};
  launchApp("partner");
  const pMenu3 = newPage("pages/menu/index");
  await pMenu3.onLoad();
  assert.strictEqual(pMenu3.data.status, "error");
  assert.ok(/自定义安全规则/.test(pMenu3.data.errorText), pMenu3.data.errorText);
  permission = "shared";
  ok("权限设错时：改不了会提示原因、读不到会提示怎么改");

  // 没缓存、集合没建：给出能照着做的提示；建好后点重试
  devices.me = {};
  delete cloudDB.dishes;
  launchApp("me");
  const menu4 = newPage("pages/menu/index");
  await menu4.onLoad();
  assert.strictEqual(menu4.data.status, "error");
  assert.ok(/还没有 dishes 集合/.test(menu4.data.errorText), "报错里写明是哪个集合：" + menu4.data.errorText);
  const missingText = menu4.data.errorText;
  cloudDB.dishes = [];
  menu4.onRetry();
  await flush();
  assert.strictEqual(menu4.data.status, "ready");
  ok(`集合没建：提示「${missingText.slice(0, 20)}…」，建好后重试正常`);

  // 「我的 → 检查一下云开发」：一眼看出哪个集合没建
  delete cloudDB.plans;
  const mineCheck = newPage("pages/mine/index");
  await mineCheck.onCheckDatabase();
  assert.strictEqual(lastCall("modal")[1], "云开发检查");
  assert.ok(/✅ dishes：正常/.test(lastCall("modal")[2]) && /❌ plans：还没建/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  // 下拉刷新时 plans 没建：弹窗写明是 plans
  const menuPull = newPage("pages/menu/index");
  await menuPull.onLoad();
  await menuPull.onPullRefresh();
  assert.strictEqual(lastCall("modal")[1], "云数据库有点问题");
  assert.ok(/还没有 plans 集合/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  cloudDB.plans = [];
  ok("检查一下云开发：列出每个集合的状态；下拉刷新出错时写明是哪个集合");

  // 只有 plans 集合没建：菜单照样能看；点菜时弹窗说明怎么建，同样的问题只弹一次，之后是轻提示
  delete cloudDB.plans;
  devices.me = {};
  launchApp("me");
  const menu5 = newPage("pages/menu/index");
  await menu5.onLoad();
  await flush();
  assert.strictEqual(menu5.data.status, "ready");
  menu5.onPlus(ev({ id: "x1" }));
  await flush();
  assert.strictEqual(lastCall("modal")[1], "菜篮没存上");
  assert.ok(/plans/.test(lastCall("modal")[2]), lastCall("modal")[2]);
  const modalCount = countCalls("modal");
  menu5.onPlus(ev({ id: "x1" }));
  await flush();
  assert.strictEqual(countCalls("modal"), modalCount, "同样的问题只弹一次窗");
  assert.deepStrictEqual(lastCall("toast"), ["toast", "菜篮没同步上，稍后再试"]);
  ok("plans 集合没建：菜单照样能用，点菜时提示怎么建");

  // 只有 cook_logs 集合没建：菜单、记录页照样能打开；打卡时提示怎么建
  cloudDB.plans = [];
  delete cloudDB.cook_logs;
  cloudDB.dishes.push({ _id: "d-x", _openid: "me", name: "清炒时蔬", categoryId: catOf("家常菜"), createdAt: Date.now() });
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

  // cook_logs 集合没建：菜照样导进来，提示记录没导进去；建好集合再导一次，记录补上、次数不会多算
  cloudDB.categories = [];
  cloudDB.dishes = [];
  delete cloudDB.cook_logs;
  devices.me = {};
  launchApp("me");
  const imp3 = newPage("pages/import/index");
  imp3.onChoose();
  await flush();
  await imp3.onImport();
  assert.deepStrictEqual([imp3.data.result.added, imp3.data.result.logsAdded], [6, 0]);
  assert.strictEqual(lastCall("modal")[1], "菜谱导进来了，做菜记录没导进去");
  cloudDB.cook_logs = [];
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
  assert.strictEqual(calPage.data.calSummary, "这个月下厨 3 次 · 做了 2 道菜 · 最常做「经典小梁汤面」", "本月小结");
  calPage.onPrevMonth();
  assert.strictEqual(calPage.data.calSummary, "这个月还没下厨");
  calPage.onNextMonth();
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

  // ======== 对方看不到我传的照片：免费环境的云存储只有上传的人能读，照片交给云函数 photo 换链接 ========
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
  const goneId = "cloud://test-env.1234/covers/gone.jpg";
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
  photoFunctionDeployed = false;
  launchApp("partner");
  const herMine = newPage("pages/mine/index");
  await herMine.onCheckDatabase();
  const report = lastCall("modal")[2];
  assert.ok(/❌ 照片：云函数 photo 还没部署/.test(report), report);
  assert.ok(/右键 photo 文件夹.*上传并部署：云端安装依赖/.test(report), "告诉对方怎么部署");
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
  photoFunctionDeployed = true;
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
