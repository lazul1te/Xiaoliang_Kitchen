// 旧数据变成家庭本本：以前所有能打开小程序的人共用一份数据（记录上没有 bookId）。
// 新版本第一次有人打开时，建一本「我们家的小本本」（_id 固定是 legacy）：
// - 旧数据里加过东西的人都是成员，不用申请；打开新版本的人在里面就是本主，不然是最早开始记的那个人
// - 旧记录不用改：没有 bookId 的都算这本的（读到的时候顺手补上，见 data.js），所以中途断了也没关系
// - 两台手机同时打开：_id 固定，只建得出一本
const { _, findOne, fetchAll, addOnce, uniqueCode, DATA, LEGACY_ID } = require("./common");

const NAME = "我们家的小本本";

// 返回旧数据那本（已经有了就直接返回）；没有旧数据返回 null
async function migrate(openid) {
  const existing = await findOne("books", LEGACY_ID);
  if (existing) return existing;
  const lists = await Promise.all(DATA.concat("plans").map((name) => fetchAll(name, { bookId: _.exists(false) }, { _openid: true, createdAt: true })));
  const docs = [].concat(...lists);
  if (!docs.length) return null;
  const first = {}; // openid → 最早加东西的时间
  docs.forEach((d) => {
    if (!d._openid) return;
    const at = Number(d.createdAt) || Date.now();
    if (!first[d._openid] || at < first[d._openid]) first[d._openid] = at;
  });
  const now = Date.now();
  if (!Object.keys(first).length) first[openid] = now; // 旧记录上都没有是谁加的：就算打开新版本的这个人
  const ids = Object.keys(first).sort((a, b) => first[a] - first[b]);
  const members = {};
  ids.forEach((id) => {
    members[id] = { name: "", joinedAt: first[id] };
  });
  await addOnce("books", {
    _id: LEGACY_ID,
    name: NAME,
    type: "family",
    legacy: true,
    owner: members[openid] ? openid : ids[0],
    members,
    requests: {},
    code: await uniqueCode(),
    createdAt: now,
    updatedAt: now,
  });
  return findOne("books", LEGACY_ID);
}

module.exports = { migrate };
