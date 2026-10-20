// 小本本：每个人自动有一本「我的小本本」（只有自己能看），还能建家庭本本、用家庭码申请加入别人的家庭本本。
//   users  每人一条，_id 就是 openid：个人本本是哪本、默认进哪本（空的是上次用的那本）、上次用的哪本、
//          输错家庭码的时间、给 TA 的通知（申请通过了 / 没通过 / 被移出了）
//   books  每本一条：名字、type（personal / family）、本主 owner、成员 members { openid: { name, joinedAt } }、
//          加入申请 requests { openid: { name, at } }、家庭码 code
// 加入家庭本本要先申请，本主同意了才算加入；退出不用谁同意。小程序里看不到别人的 openid，成员用 memberId 称呼。
const crypto = require("crypto");
const legacy = require("./legacy");
const { removeBook } = require("./data");
const {
  db,
  _,
  LEGACY_ID,
  CODE_LENGTH,
  fail,
  hash,
  randomId,
  writing,
  findOne,
  fetchAll,
  countOf,
  addOnce,
  scopeOf,
  memberBook,
  uniqueCode,
} = require("./common");

const PERSONAL_NAME = "我的小本本";
const MAX_FAMILY = 5; // 一个人最多加几本家庭本本
const MAX_REQUESTS = 20; // 一本最多攒几个还没处理的申请
const MAX_FAILS = 10; // 一小时内输错 10 次家庭码，要等一会儿再试
const FAIL_WINDOW = 60 * 60 * 1000;
const BOOK_NAME_MAX = 12;
const MEMBER_NAME_MAX = 10;

const personalIdOf = (openid) => `p${hash(openid).slice(0, 20)}`;
const memberIdOf = (bookId, openid) => hash(`${bookId}:${openid}`).slice(0, 12);
const now = () => Date.now();

function bookName(value) {
  const name = String(value || "").trim();
  if (!name) throw fail("BAD_INPUT", "名字不能是空的");
  if (name.length > BOOK_NAME_MAX) throw fail("BAD_INPUT", `名字最多 ${BOOK_NAME_MAX} 个字`);
  return name;
}

function memberName(value) {
  const name = String(value || "").trim();
  if (name.length > MEMBER_NAME_MAX) throw fail("BAD_INPUT", `名字最多 ${MEMBER_NAME_MAX} 个字`);
  return name;
}

// ---------- 用户 ----------

async function createUser(openid) {
  // 第一次用新版本：先把旧数据变成家庭本本（已经变过就跳过），再建这个人的个人本本。
  // 用户记录最后建：中途失败了，下次打开会从头再来一遍（每一步都不会重复建）
  const old = await legacy.migrate(openid);
  const time = now();
  const personalBookId = personalIdOf(openid);
  await addOnce("books", {
    _id: personalBookId,
    name: PERSONAL_NAME,
    type: "personal",
    owner: openid,
    members: { [openid]: { name: "", joinedAt: time } },
    requests: {},
    code: "",
    createdAt: time,
    updatedAt: time,
  });
  await addOnce("users", {
    _id: openid,
    personalBookId,
    defaultBook: "",
    lastBook: "",
    fails: [],
    notices: {},
    welcomed: !(old && old.members && old.members[openid]), // 旧数据那本的成员，第一次打开时说一声数据去哪了
    createdAt: time,
    updatedAt: time,
  });
  return findOne("users", openid);
}

function ensureUser(ctx) {
  if (!ctx.userTask) ctx.userTask = findOne("users", ctx.openid).then((user) => user || createUser(ctx.openid));
  return ctx.userTask;
}

const updateUser = (openid, data) => db.collection("users").doc(openid).update({ data: Object.assign(data, { updatedAt: now() }) });

// 给 TA 留一条通知，TA 下次打开时看到
async function notify(openid, notice) {
  const key = `n${now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  try {
    await updateUser(openid, { [`notices.${key}`]: _.set(Object.assign({ key, at: now() }, notice)) });
  } catch (err) {} // 通知没留上不影响别的
}

// ---------- 本本 ----------

const isMember = (book, openid) => !!(book && book.members && book.members[openid]);

// 给小程序看的样子：成员按加入的先后排；家庭码成员都能看到；加入申请只给本主看
function view(book, openid) {
  const members = Object.keys(book.members || {})
    .map((id) => ({
      id: memberIdOf(book._id, id),
      name: book.members[id].name || "",
      owner: id === book.owner,
      me: id === openid,
      joinedAt: book.members[id].joinedAt || 0,
    }))
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const owner = book.owner === openid;
  const family = book.type === "family";
  const requests =
    family && owner
      ? Object.keys(book.requests || {})
          .map((id) => ({ id: memberIdOf(book._id, id), name: book.requests[id].name || "", at: book.requests[id].at || 0 }))
          .sort((a, b) => a.at - b.at)
      : [];
  return {
    _id: book._id,
    name: book.name || "",
    type: family ? "family" : "personal",
    owner,
    myName: (book.members[openid] || {}).name || "",
    members,
    code: family ? book.code || "" : "",
    requests,
  };
}

// 你的本本、你在等着通过的申请、给你的通知（拿走以后就删掉）
async function summary(ctx) {
  const user = (await findOne("users", ctx.openid)) || (await ensureUser(ctx));
  const [books, pending] = await Promise.all([
    fetchAll("books", { [`members.${ctx.openid}`]: _.exists(true) }),
    fetchAll("books", { [`requests.${ctx.openid}`]: _.exists(true) }),
  ]);
  const joinedAt = (b) => b.members[ctx.openid].joinedAt || 0;
  books.sort((a, b) => (a.type === "personal" ? 0 : 1) - (b.type === "personal" ? 0 : 1) || joinedAt(a) - joinedAt(b));
  const notes = user.notices || {};
  const keys = Object.keys(notes);
  if (keys.length) {
    const data = {};
    keys.forEach((k) => {
      data[`notices.${k}`] = _.remove();
    });
    await updateUser(ctx.openid, data);
  }
  return {
    me: { personalBookId: user.personalBookId, defaultBook: user.defaultBook || "" },
    books: books.map((b) => view(b, ctx.openid)),
    pending: pending.filter((b) => !isMember(b, ctx.openid)).map((b) => ({ _id: b._id, name: b.name || "", at: b.requests[ctx.openid].at || 0 })),
    notices: keys.map((k) => notes[k]).sort((a, b) => a.at - b.at),
  };
}

// 本主才能做的事（同意申请、换家庭码、移出成员）
async function ownedBook(ctx, bookId) {
  const book = await memberBook(ctx, bookId);
  if (book.type !== "family") throw fail("PERSONAL", "个人本本只有自己，不能邀请别人");
  if (book.owner !== ctx.openid) throw fail("NOT_OWNER", "只有本主能做这件事");
  return book;
}

const familyCount = (openid) => countOf("books", { [`members.${openid}`]: _.exists(true), type: "family" });

// ---------- 打开小程序 ----------

// 打开小程序时调一次：有哪些本本、这次进哪本（指定的默认那本 → 上次用的 → 旧数据那本 → 个人本本）、要不要说一声旧数据去哪了
async function boot(ctx) {
  const user = await ensureUser(ctx);
  const result = await summary(ctx);
  const ids = result.books.map((b) => b._id);
  const openBookId = [user.defaultBook, user.lastBook, LEGACY_ID, user.personalBookId].find((id) => id && ids.indexOf(id) >= 0) || user.personalBookId;
  let welcome = null;
  if (!user.welcomed) {
    const old = result.books.find((b) => b._id === LEGACY_ID);
    if (old) welcome = { bookId: old._id, name: old.name, memberCount: old.members.length };
    await updateUser(ctx.openid, { welcomed: true });
  }
  return Object.assign(result, { openBookId, welcome });
}

async function books(ctx) {
  await ensureUser(ctx);
  return summary(ctx);
}

// 切到另一本：记下来，下次打开默认进它
async function switchBook(ctx, { bookId }) {
  await memberBook(ctx, bookId);
  await ensureUser(ctx);
  await updateUser(ctx.openid, { lastBook: bookId });
  return {};
}

// 打开小程序时进哪本：空的是「上次用的那本」
async function setDefault(ctx, { bookId }) {
  if (bookId) await memberBook(ctx, bookId);
  await ensureUser(ctx);
  await updateUser(ctx.openid, { defaultBook: bookId || "" });
  return summary(ctx);
}

// ---------- 新建、改名、我在这本里叫什么 ----------

async function createBook(ctx, { name, myName }) {
  await ensureUser(ctx);
  const book = {
    _id: randomId("b"),
    name: bookName(name),
    type: "family",
    owner: ctx.openid,
    members: { [ctx.openid]: { name: memberName(myName), joinedAt: now() } },
    requests: {},
    code: "",
    createdAt: now(),
    updatedAt: now(),
  };
  if ((await familyCount(ctx.openid)) >= MAX_FAMILY) throw fail("LIMIT", `最多加 ${MAX_FAMILY} 本家庭本本，先退出一本再建`);
  book.code = await uniqueCode();
  await writing("books", () => db.collection("books").add({ data: book }));
  return Object.assign({ bookId: book._id }, await summary(ctx));
}

async function renameBook(ctx, { bookId, name }) {
  await memberBook(ctx, bookId);
  await db.collection("books").doc(bookId).update({ data: { name: bookName(name), updatedAt: now() } });
  return summary(ctx);
}

async function setMyName(ctx, { bookId, name }) {
  await memberBook(ctx, bookId);
  await db.collection("books").doc(bookId).update({ data: { [`members.${ctx.openid}.name`]: memberName(name), updatedAt: now() } });
  return summary(ctx);
}

// ---------- 家庭码和加入申请 ----------

const cleanCode = (code) => String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");

// 按家庭码找一本。输错了记一笔，一小时内错 10 次就先不让试了
async function lookup(ctx, rawCode) {
  const user = await ensureUser(ctx);
  const time = now();
  const fails = (user.fails || []).filter((t) => time - t < FAIL_WINDOW);
  if (fails.length >= MAX_FAILS) throw fail("TOO_MANY", "家庭码输错太多次了，过一个小时再试");
  const code = cleanCode(rawCode);
  const found = code.length === CODE_LENGTH ? (await fetchAll("books", { code, type: "family" }))[0] : null;
  if (found) return found;
  fails.push(time);
  user.fails = fails;
  await updateUser(ctx.openid, { fails: _.set(fails) });
  const left = MAX_FAILS - fails.length;
  if (left <= 0) throw fail("TOO_MANY", "家庭码输错太多次了，过一个小时再试");
  throw fail("BAD_CODE", `没找到这个家庭码，再核对一下（还能试 ${left} 次）`);
}

function statusOf(book, openid) {
  if (isMember(book, openid)) return "member";
  return book.requests && book.requests[openid] ? "pending" : "";
}

// 加入前先看看是哪一本、有几个人
async function peekCode(ctx, { code }) {
  const book = await lookup(ctx, code);
  const owner = book.members[book.owner] || {};
  return {
    bookId: book._id,
    name: book.name || "",
    memberCount: Object.keys(book.members || {}).length,
    dishCount: await countOf("dishes", scopeOf(book)),
    ownerName: owner.name || "",
    status: statusOf(book, ctx.openid),
  };
}

// 申请加入：本主同意以后才算加入
async function requestJoin(ctx, { code, myName }) {
  const book = await lookup(ctx, code);
  const name = memberName(myName);
  const status = statusOf(book, ctx.openid);
  if (status !== "member") {
    if ((await familyCount(ctx.openid)) >= MAX_FAMILY) throw fail("LIMIT", `你已经加了 ${MAX_FAMILY} 本家庭本本，先退出一本再申请`);
    if (!status && Object.keys(book.requests || {}).length >= MAX_REQUESTS) throw fail("FULL", "这本的加入申请太多了，让本主先处理一下");
    await db.collection("books").doc(book._id).update({ data: { [`requests.${ctx.openid}`]: _.set({ name, at: now() }), updatedAt: now() } });
  }
  return Object.assign({ status: status === "member" ? "member" : "pending", bookId: book._id }, await summary(ctx));
}

// 撤回自己的申请
async function cancelRequest(ctx, { bookId }) {
  const book = await findOne("books", String(bookId || ""));
  if (book && book.requests && book.requests[ctx.openid]) {
    await db.collection("books").doc(book._id).update({ data: { [`requests.${ctx.openid}`]: _.remove(), updatedAt: now() } });
  }
  return summary(ctx);
}

function openidOf(map, bookId, memberId) {
  return Object.keys(map || {}).find((id) => memberIdOf(bookId, id) === memberId) || "";
}

// 本主同意 / 不同意
async function approve(ctx, { bookId, memberId }) {
  const book = await ownedBook(ctx, bookId);
  const openid = openidOf(book.requests, bookId, memberId);
  if (!openid) throw fail("GONE", "这个申请已经没有了，可能 TA 撤回了");
  if ((await familyCount(openid)) >= MAX_FAMILY) throw fail("LIMIT", `TA 已经加了 ${MAX_FAMILY} 本家庭本本，加不进来了`);
  const request = book.requests[openid];
  await db.collection("books").doc(bookId).update({
    data: {
      [`requests.${openid}`]: _.remove(),
      [`members.${openid}`]: _.set({ name: request.name || "", joinedAt: now() }),
      updatedAt: now(),
    },
  });
  await notify(openid, { type: "approved", bookId, name: book.name });
  return summary(ctx);
}

async function reject(ctx, { bookId, memberId }) {
  const book = await ownedBook(ctx, bookId);
  const openid = openidOf(book.requests, bookId, memberId);
  if (openid) {
    await db.collection("books").doc(bookId).update({ data: { [`requests.${openid}`]: _.remove(), updatedAt: now() } });
    await notify(openid, { type: "rejected", bookId, name: book.name });
  }
  return summary(ctx);
}

// 换一个家庭码，旧的马上不能用了
async function newCode(ctx, { bookId }) {
  await ownedBook(ctx, bookId);
  await db.collection("books").doc(bookId).update({ data: { code: await uniqueCode(), updatedAt: now() } });
  return summary(ctx);
}

// ---------- 成员 ----------

// 本主移出别人
async function removeMember(ctx, { bookId, memberId }) {
  const book = await ownedBook(ctx, bookId);
  const openid = openidOf(book.members, bookId, memberId);
  if (!openid) throw fail("GONE", "TA 已经不在这本里了");
  if (openid === ctx.openid) throw fail("BAD_INPUT", "要离开这本，点「退出这本」");
  await db.collection("books").doc(bookId).update({ data: { [`members.${openid}`]: _.remove(), updatedAt: now() } });
  await notify(openid, { type: "removed", bookId, name: book.name });
  return summary(ctx);
}

// 自己退出（不用谁同意）。本主退出了，最早加入的人接着当本主；最后一个人退出，这本连同里面的东西一起删掉
async function leaveBook(ctx, { bookId }) {
  const book = await memberBook(ctx, bookId);
  if (book.type !== "family") throw fail("PERSONAL", "个人本本不能退出");
  const others = Object.keys(book.members).filter((id) => id !== ctx.openid);
  if (others.length) {
    const data = { [`members.${ctx.openid}`]: _.remove(), updatedAt: now() };
    if (book.owner === ctx.openid) {
      data.owner = others.sort((a, b) => (book.members[a].joinedAt || 0) - (book.members[b].joinedAt || 0))[0];
    }
    await db.collection("books").doc(bookId).update({ data });
  } else {
    await removeBook(book);
    await Promise.all(Object.keys(book.requests || {}).map((id) => notify(id, { type: "deleted", bookId, name: book.name })));
  }
  const user = await ensureUser(ctx);
  const patch = {};
  if (user.defaultBook === bookId) patch.defaultBook = "";
  if (user.lastBook === bookId) patch.lastBook = "";
  if (Object.keys(patch).length) await updateUser(ctx.openid, patch);
  return Object.assign({ deleted: !others.length }, await summary(ctx));
}

module.exports = {
  actions: {
    boot,
    books,
    switchBook,
    setDefault,
    createBook,
    renameBook,
    setMyName,
    peekCode,
    requestJoin,
    cancelRequest,
    approve,
    reject,
    newCode,
    removeMember,
    leaveBook,
  },
};
