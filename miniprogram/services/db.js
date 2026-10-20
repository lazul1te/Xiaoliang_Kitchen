// 读写一本小本本里的数据，写法跟云数据库差不多：collection(集合名).add({ data })、.doc(id).update({ data })、.doc(id).remove()，
// 只是都交给云函数 api 去做：它会检查你是不是这本的成员，给新记录加上 bookId。
// plans 集合里每本各有一条菜篮（current）、库存（pantry）、想吃清单（wishes），用这三个名字称呼就行。
// bookId 不传就是正在用的那本。
const api = require("./api");
const book = require("./book");

// 更新操作符（只能用在 update 的第一层字段）：set(值) 整个替换、inc(数) 加减、remove() 删掉这个字段
const COMMAND = {
  set: (value) => ({ $op: "set", value }),
  inc: (value) => ({ $op: "inc", value }),
  remove: () => ({ $op: "remove" }),
};

function command() {
  return COMMAND;
}

// 还不知道正在用哪本（第一次打开新版本）就先问一下
async function target(bookId) {
  if (bookId) return bookId;
  if (!book.currentId()) await book.ready();
  return book.currentId();
}

function collection(name, bookId) {
  return {
    add: async ({ data }) => {
      const res = await api.call("add", { bookId: await target(bookId), collection: name, data });
      return { _id: res._id };
    },
    doc: (id) => ({
      update: async ({ data }) => {
        const res = await api.call("update", { bookId: await target(bookId), collection: name, id, data });
        return { stats: { updated: res.updated } };
      },
      remove: async () => {
        const res = await api.call("remove", { bookId: await target(bookId), collection: name, id });
        return { stats: { removed: res.removed } };
      },
    }),
  };
}

// 按 _id 找一条，找不到（或者不是这本的）返回 null
async function findOne(name, id, bookId) {
  return api.call("get", { bookId: await target(bookId), collection: name, id });
}

// 一本里的分类、菜、做菜记录、每一顿，全部读回来（数据多了云函数会分几次给）
async function loadBook(bookId) {
  const all = { categories: [], dishes: [], cook_logs: [], meals: [] };
  const seen = {};
  let cursor = null;
  for (let i = 0; i < 100; i++) {
    const res = await api.call("load", { bookId, cursor });
    Object.keys(all).forEach((name) => {
      (res[name] || []).forEach((doc) => {
        const key = `${name}:${doc._id}`;
        if (seen[key]) return;
        seen[key] = true;
        all[name].push(doc);
      });
    });
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  return all;
}

module.exports = { command, collection, findOne, loadBook };
