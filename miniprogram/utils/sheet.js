// 从底部弹出的面板（app.wxss 的 .sheet-mask / .sheet）：打开时自己会滑出来；
// 收起时先给 .sheet-mask 加上 closing，播 0.18 秒滑下去的动画，再真的关掉
const CLOSE_MS = 180;

// ctx：页面或组件；closingKey：data 里控制 closing 的字段；done：动画播完以后真的关掉
function closeSheet(ctx, closingKey, done) {
  if (ctx.data[closingKey]) return;
  ctx.setData({ [closingKey]: true });
  setTimeout(() => {
    done(); // 先关掉再去掉 closing：反过来的话，面板会先弹回来一下
    ctx.setData({ [closingKey]: false });
  }, CLOSE_MS);
}

module.exports = { CLOSE_MS, closeSheet };
