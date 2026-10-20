// 「检查云开发」：云函数 api 部署了没有、每个集合在不在、试几张照片、数据库权限有没有收紧，把结果和该怎么改写成一段话弹出来。
// 「我的」页底部和菜单页读不到数据时都用这个
const cloud = require("./cloud");
const api = require("./api");
const photo = require("./photo");
const dishService = require("./dish");
const ui = require("../utils/ui");

// 小程序自己还能不能直接读数据库：能读就说明权限还没改成「所有用户不可读写」（别人改了小程序代码就能看到所有本本）
function databaseOpen() {
  return new Promise((resolve) => {
    try {
      cloud.init();
      wx.cloud
        .database()
        .collection("dishes")
        .limit(1)
        .get()
        .then(
          () => resolve(true),
          () => resolve(false)
        );
    } catch (e) {
      resolve(false);
    }
  });
}

async function run() {
  wx.showLoading({ title: "检查中", mask: true });
  const lines = [];
  const tips = [];
  let deployed = true;
  try {
    const res = await api.call("check", {});
    lines.push("✅ 云函数 api：正常");
    res.collections.forEach((r) => lines.push(`${r.ok ? "✅" : "❌"} ${r.name}：${r.text}`));
    if (res.collections.some((r) => !r.ok)) tips.push("数据库：没建好的集合在云开发控制台「数据库」里新建，权限选「所有用户不可读写」");
  } catch (err) {
    deployed = false;
    const e = cloud.explain(err);
    lines.push(`❌ 云函数 api：${e.code === "NO_API" ? "还没部署" : e.message}`);
    if (e.code === "NO_API") tips.push(`云函数：${cloud.DEPLOY_TIP}`);
  }
  if (deployed) {
    const photos = [];
    try {
      await dishService.refresh(); // 用云上最新的菜（手机上的缓存里可能有已经删掉的照片）
      (await dishService.listDishes()).forEach((d) => photos.push(d.coverThumb || d.cover));
    } catch (e) {}
    const r = await photo.check(photos);
    lines.push(`${r.ok ? "✅" : "❌"} ${r.name}：${r.text}`);
  }
  if (await databaseOpen()) {
    lines.push("⚠️ 数据库权限：还是谁都能直接读写");
    tips.push("数据库权限：大家都换成新版本以后，在云开发控制台把每个集合的权限都改成「所有用户不可读写」（见 README），别人改了小程序代码也看不到你们的本本");
  } else {
    lines.push("🔒 数据库权限：只有云函数能读写");
  }
  wx.hideLoading();
  const tip = tips.length ? `\n\n${tips.join("\n\n")}` : "\n\n都正常";
  return ui.alert("云开发检查", lines.join("\n") + tip);
}

module.exports = { run };
