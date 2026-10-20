// 云函数 api 里共用的：数据库、报错、按本本筛选记录、几个小工具。
// 云函数默认 3 秒超时，所以每个操作都只做一小块活，大的活（复制整本菜、删一本）分几次由小程序一趟趟发
const crypto = require("crypto");
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 每本小本本里的数据，每条记录都带 bookId
const DATA = ["categories", "dishes", "cook_logs", "meals"];
// plans 集合里每本各一条：菜篮和点菜单（current）、库存（pantry）、想吃清单（wishes）
const PLAN_KINDS = ["current", "pantry", "wishes"];
// 以前所有人共用一份数据，新版本第一次打开时变成这本家庭本本（见 legacy.js）
const LEGACY_ID = "legacy";
const MAX_READ = 1000; // 云函数里一次最多读 1000 条
// 家庭码：6 位，去掉了容易看错的 0、O、1、I、L
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

const errorText = (err) => (err && (err.errMsg || err.message)) || String(err);
const isCollectionMissing = (err) => /-502005|collection not exist|table not exist/i.test(errorText(err));
const isDuplicate = (err) => /duplicate|dup key|E11000/i.test(errorText(err));

// 给小程序的报错：code 说明是哪种情况，message 直接显示给人看
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  e.expected = true;
  return e;
}

const hash = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");
const randomId = (prefix) => `${prefix}${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
const missingText = (name) => `云数据库里还没有 ${name} 集合：在云开发控制台「数据库」里新建一个，权限选「所有用户不可读写」`;

async function createCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {} // 已经有了，或者建不了（后面会报出来）
}

// 写数据：集合还没建就先建一个再写（读的时候没建的集合当作是空的）
async function writing(name, task) {
  try {
    return await task();
  } catch (err) {
    if (!isCollectionMissing(err)) throw err;
  }
  await createCollection(name);
  try {
    return await task();
  } catch (err) {
    if (isCollectionMissing(err)) throw fail("COLLECTION_MISSING", missingText(name));
    throw err;
  }
}

// 按 _id 找一条，找不到返回 null（doc(id).get() 找不到会报错，报错文字还不固定）
async function findOne(name, id) {
  try {
    const res = await db.collection(name).where({ _id: String(id) }).limit(1).get();
    return res.data[0] || null;
  } catch (err) {
    if (isCollectionMissing(err)) return null;
    throw err;
  }
}

// 满足条件的都读出来，按创建时间排。field：只要哪几个字段
async function fetchAll(name, where, field) {
  const all = [];
  try {
    for (;;) {
      let query = db.collection(name).where(where);
      if (field) query = query.field(field);
      const res = await query.orderBy("createdAt", "asc").orderBy("_id", "asc").skip(all.length).limit(MAX_READ).get();
      all.push(...res.data);
      if (res.data.length < MAX_READ) return all;
    }
  } catch (err) {
    if (isCollectionMissing(err)) return all;
    throw err;
  }
}

async function countOf(name, where) {
  try {
    return (await db.collection(name).where(where).count()).total;
  } catch (err) {
    if (isCollectionMissing(err)) return 0;
    throw err;
  }
}

// 加一条 _id 固定的记录；已经有了（两台手机同时在建，或者上次其实存上了）返回 false
async function addOnce(name, data) {
  try {
    await writing(name, () => db.collection(name).add({ data }));
    return true;
  } catch (err) {
    if (isDuplicate(err)) return false;
    throw err;
  }
}

// 这本的记录：带着这本的 bookId。旧数据变成的那本，没有 bookId 的旧记录也算它的
function scopeOf(book) {
  return book.legacy ? _.or([{ bookId: book._id }, { bookId: _.exists(false) }]) : { bookId: book._id };
}

function belongs(book, doc) {
  return !!doc && (doc.bookId === book._id || (!!book.legacy && doc.bookId === undefined));
}

// plans 里这本的菜篮 / 库存 / 想吃清单是哪一条。旧数据那本还用原来的 current、pantry、wishes
function planId(book, kind) {
  if (PLAN_KINDS.indexOf(kind) < 0) throw fail("BAD_INPUT", `不认识的记录：${kind}`);
  return book.legacy ? kind : `${book._id}-${kind}`;
}

// 给小程序的记录：去掉 bookId、_openid
function present(doc) {
  const d = Object.assign({}, doc);
  delete d.bookId;
  delete d._openid;
  return d;
}

// 读一本，并且确认你是这本的成员。同一次调用里读过的不再读
async function memberBook(ctx, bookId) {
  if (!bookId || typeof bookId !== "string") throw fail("BAD_INPUT", "没说是哪本小本本");
  if (!ctx.bookTasks[bookId]) ctx.bookTasks[bookId] = findOne("books", bookId);
  const book = await ctx.bookTasks[bookId];
  if (!book || !book.members || !book.members[ctx.openid]) throw fail("NOT_MEMBER", "你已经不在这本小本本里了");
  return book;
}

// 你是成员的那几本：{ bookId: true }
async function myBookIds(ctx) {
  if (!ctx.myBookIds) {
    ctx.myBookIds = fetchAll("books", { [`members.${ctx.openid}`]: _.exists(true) }, { _id: true }).then((list) => {
      const ids = {};
      list.forEach((b) => {
        ids[b._id] = true;
      });
      return ids;
    });
  }
  return ctx.myBookIds;
}

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return code;
}

// 新的家庭码，跟别的本本不重复
async function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    if (!(await countOf("books", { code }))) return code;
  }
  throw fail("BUSY", "家庭码没生成好，再试一次");
}

module.exports = {
  cloud,
  db,
  _,
  DATA,
  PLAN_KINDS,
  LEGACY_ID,
  CODE_CHARS,
  CODE_LENGTH,
  errorText,
  isDuplicate,
  fail,
  hash,
  randomId,
  writing,
  createCollection,
  isCollectionMissing,
  findOne,
  fetchAll,
  countOf,
  addOnce,
  scopeOf,
  belongs,
  planId,
  present,
  memberBook,
  myBookIds,
  uniqueCode,
};
