// 生成不重复的 id：时间 + 随机数，自己一个人用足够了
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = { newId };
