// 一本小本本里的数据：分类、菜、做菜记录、每一顿（每条带 bookId），还有 plans 里每本各一条的菜篮、库存、想吃清单。
// 每个操作都先查你是不是这本的成员（memberBook）。写法跟云数据库差不多：get / add / update / remove，
// update 里的 { $op: "set" | "inc" | "remove" } 换成数据库的 _.set / _.inc / _.remove（只认第一层的字段）
const photos = require("./photos");
const {
  db,
  _,
  DATA,
  PLAN_KINDS,
  LEGACY_ID,
  fail,
  writing,
  createCollection,
  isCollectionMissing,
  isDuplicate,
  errorText,
  findOne,
  fetchAll,
  countOf,
  addOnce,
  scopeOf,
  belongs,
  planId,
  present,
  memberBook,
} = require("./common");

const LOAD_BUDGET = 512 * 1024; // 一次最多回这么多字节，数据多了分几次给
const COPY_BATCH = 3; // 复制菜一次复制几道（带照片，3 秒内做得完）
const ID = /^[\w-]{1,64}$/;

function checkCollection(name, withPlans) {
  if (DATA.indexOf(name) >= 0 || (withPlans && name === "plans")) return;
  throw fail("BAD_INPUT", `不认识的集合：${name}`);
}

// 小程序传来的字段：不能改 _id、_openid、bookId；$op 换成数据库的操作符
function decode(data) {
  const out = {};
  Object.keys(data || {}).forEach((key) => {
    const root = key.split(".")[0];
    if (root === "_id" || root === "_openid" || root === "bookId") throw fail("BAD_INPUT", `不能改 ${key}`);
    const v = data[key];
    if (v && typeof v === "object" && v.$op) {
      if (v.$op === "set") out[key] = _.set(v.value);
      else if (v.$op === "inc") out[key] = _.inc(Number(v.value) || 0);
      else if (v.$op === "remove") out[key] = _.remove();
      else throw fail("BAD_INPUT", `不认识的操作：${v.$op}`);
    } else {
      out[key] = v;
    }
  });
  return out;
}

// 旧数据那本：读到还没有 bookId 的旧记录（旧版本刚加的），顺手补上
async function tagLegacy(lists) {
  await Promise.all(
    DATA.map((name, i) =>
      lists[i].some((d) => d.bookId === undefined)
        ? db.collection(name).where({ bookId: _.exists(false) }).update({ data: { bookId: LEGACY_ID } }).catch(() => {})
        : null
    )
  );
}

// 打开一本：分类、菜、做菜记录、每一顿全部给小程序。太多了分几次给（cursor：从哪接着给）
async function load(ctx, { bookId, cursor }) {
  const book = await memberBook(ctx, bookId);
  const lists = await Promise.all(DATA.map((name) => fetchAll(name, scopeOf(book))));
  if (book.legacy) await tagLegacy(lists);
  const out = { cursor: null };
  DATA.forEach((name) => {
    out[name] = [];
  });
  const from = cursor && typeof cursor.c === "number" ? cursor : { c: 0, skip: 0 };
  let budget = LOAD_BUDGET;
  for (let c = from.c; c < DATA.length; c++) {
    const docs = lists[c] || [];
    for (let i = c === from.c ? from.skip : 0; i < docs.length; i++) {
      const doc = present(docs[i]);
      const size = Buffer.byteLength(JSON.stringify(doc));
      if (size > budget && budget < LOAD_BUDGET) {
        out.cursor = { c, skip: i };
        return out;
      }
      budget -= size;
      out[DATA[c]].push(doc);
    }
  }
  return out;
}

// 读一条：plans 用 current / pantry / wishes 称呼这本的那条
async function get(ctx, { bookId, collection, id }) {
  const book = await memberBook(ctx, bookId);
  checkCollection(collection, true);
  if (collection === "plans") {
    const doc = await findOne("plans", planId(book, id));
    return doc ? Object.assign(present(doc), { _id: id }) : null;
  }
  const doc = await findOne(collection, id);
  return belongs(book, doc) ? present(doc) : null;
}

async function add(ctx, { bookId, collection, data }) {
  const book = await memberBook(ctx, bookId);
  checkCollection(collection, true);
  const doc = Object.assign({}, data);
  delete doc._openid;
  doc.bookId = book._id;
  if (collection === "plans") doc._id = planId(book, data && data._id);
  else if (doc._id !== undefined && !ID.test(doc._id)) throw fail("BAD_INPUT", "记录的 _id 不对");
  try {
    const res = await writing(collection, () => db.collection(collection).add({ data: doc }));
    return { _id: collection === "plans" ? data._id : res._id };
  } catch (err) {
    if (isDuplicate(err)) throw fail("DUPLICATE", "duplicate：这条记录已经有了");
    throw err;
  }
}

async function update(ctx, { bookId, collection, id, data }) {
  const book = await memberBook(ctx, bookId);
  checkCollection(collection, true);
  const patch = decode(data);
  if (collection === "plans") {
    // 这本的菜篮、库存、想吃清单还没有：先建一条空的再改
    const docId = planId(book, id);
    const run = () => db.collection("plans").doc(docId).update({ data: patch });
    let res = await writing("plans", run);
    if (res.stats.updated === 0 && !(await findOne("plans", docId))) {
      await addOnce("plans", { _id: docId, bookId: book._id, createdAt: Date.now() });
      res = await run();
    }
    return { updated: res.stats.updated };
  }
  if (!belongs(book, await findOne(collection, id))) return { updated: 0 };
  const res = await db.collection(collection).doc(String(id)).update({ data: patch });
  return { updated: res.stats.updated };
}

async function remove(ctx, { bookId, collection, id }) {
  const book = await memberBook(ctx, bookId);
  checkCollection(collection, false);
  if (!belongs(book, await findOne(collection, id))) return { removed: 0 };
  const res = await db.collection(collection).doc(String(id)).remove();
  return { removed: res.stats.removed };
}

async function count(ctx, { bookId, collection }) {
  const book = await memberBook(ctx, bookId);
  checkCollection(collection, false);
  return { total: await countOf(collection, scopeOf(book)) };
}

// ---------- 复制菜到另一本 ----------

// 一道菜复制过去：照片也复制一份（放到那本的文件夹里，那本的人才看得到）
async function copyDish(dish, to, categoryId) {
  const steps = Array.isArray(dish.steps) ? dish.steps : [];
  const [cover, coverThumb, images] = await Promise.all([
    photos.copy(dish.cover, to._id),
    photos.copy(dish.coverThumb, to._id),
    Promise.all(steps.map((s) => photos.copy(s && s.image, to._id))),
  ]);
  const now = Date.now();
  const doc = Object.assign(present(dish), {
    categoryId,
    cover,
    coverThumb: cover ? coverThumb : "",
    steps: steps.map((s, i) => Object.assign({}, s, { image: images[i] })),
    bookId: to._id,
    createdAt: now,
    updatedAt: now,
  });
  delete doc._id;
  await writing("dishes", () => db.collection("dishes").add({ data: doc }));
}

// 把 bookId 这本的菜复制到 toBookId（两本你都得是成员）。dishIds 不传就是整本：先按顺序补齐分类。
// 一次复制几道，返回 { copied, skipped（那本里已经有同名的）, done, total, next }，next 不是空的就接着调（after: next）
async function copyDishes(ctx, { bookId, toBookId, dishIds, after }) {
  if (bookId === toBookId) throw fail("BAD_INPUT", "已经在这本里了");
  const [from, to] = await Promise.all([memberBook(ctx, bookId), memberBook(ctx, toBookId)]);
  const [fromCats, toCats, fromDishes, toDishes] = await Promise.all([
    fetchAll("categories", scopeOf(from)),
    fetchAll("categories", scopeOf(to)),
    fetchAll("dishes", scopeOf(from)),
    fetchAll("dishes", scopeOf(to), { name: true }),
  ]);
  const wanted = Array.isArray(dishIds) ? fromDishes.filter((d) => dishIds.indexOf(d._id) >= 0) : fromDishes;
  const start = after ? wanted.findIndex((d) => d._id === after) + 1 : 0;
  const batch = wanted.slice(start, start + COPY_BATCH);

  // 分类按名字对上，那本里没有就新建
  const catName = {};
  fromCats.forEach((c) => {
    catName[c._id] = c.name;
  });
  const catId = {};
  toCats.forEach((c) => {
    catId[c.name] = c._id;
  });
  let sort = toCats.reduce((max, c) => Math.max(max, Number(c.sort) || 0), 0);
  const ensureCategory = async (name) => {
    if (!name) return "";
    if (!catId[name]) {
      sort += 1;
      const res = await writing("categories", () =>
        db.collection("categories").add({ data: { name, sort, createdAt: Date.now(), bookId: to._id } })
      );
      catId[name] = res._id;
    }
    return catId[name];
  };
  if (!dishIds && !after) {
    const ordered = fromCats.slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
    for (const c of ordered) await ensureCategory(c.name);
  }

  const names = {};
  toDishes.forEach((d) => {
    names[d.name] = true;
  });
  let copied = 0;
  let skipped = 0;
  for (const dish of batch) {
    if (names[dish.name]) {
      skipped += 1;
      continue;
    }
    await copyDish(dish, to, await ensureCategory(catName[dish.categoryId]));
    names[dish.name] = true;
    copied += 1;
  }
  const done = start + batch.length;
  return { copied, skipped, done, total: wanted.length, next: done < wanted.length && batch.length ? batch[batch.length - 1]._id : "" };
}

// ---------- 删掉一本（最后一个人退出时） ----------

function filesOf(name, doc) {
  if (name === "dishes") return [doc.cover, doc.coverThumb].concat((doc.steps || []).map((s) => s && s.image));
  if (name === "cook_logs" || name === "meals") return [doc.photo, doc.photoThumb];
  return [];
}

// 先删照片和记录，最后删这本：中途超时了再调一次接着删
async function removeBook(book) {
  const where = scopeOf(book);
  const lists = await Promise.all(DATA.map((name) => fetchAll(name, where)));
  const wishes = await findOne("plans", planId(book, "wishes"));
  const files = [];
  lists.forEach((docs, i) => docs.forEach((d) => files.push(...filesOf(DATA[i], d))));
  Object.keys((wishes && wishes.items) || {}).forEach((k) => files.push(wishes.items[k].photo, wishes.items[k].photoThumb));
  await photos.removeAll(files.filter(Boolean));
  await Promise.all(
    DATA.map((name, i) => (lists[i].length ? db.collection(name).where(where).remove() : null)).concat(
      PLAN_KINDS.map((kind) => db.collection("plans").doc(planId(book, kind)).remove().catch(() => {}))
    )
  );
  await db.collection("books").doc(book._id).remove();
}

// ---------- 检查云开发（「我的」底部） ----------

// 每个集合读一下；没建的试着建上
async function check() {
  const names = DATA.concat("plans", "users", "books");
  const collections = await Promise.all(
    names.map(async (name) => {
      const read = () => db.collection(name).limit(1).get();
      try {
        await read();
        return { name, ok: true, text: "正常" };
      } catch (err) {
        if (!isCollectionMissing(err)) return { name, ok: false, text: errorText(err) };
      }
      await createCollection(name);
      try {
        await read();
        return { name, ok: true, text: "刚刚自动建好了" };
      } catch (err) {
        return { name, ok: false, text: "还没建" };
      }
    })
  );
  return { collections };
}

module.exports = {
  removeBook,
  actions: { load, get, add, update, remove, count, copyDishes, check },
};
