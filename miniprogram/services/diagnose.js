// 「检查云开发」：每个集合挨个读一下、试几张照片，把结果和该怎么改写成一段话弹出来。
// 「我的」页底部和菜单页读不到数据时都用这个
const cloud = require("./cloud");
const photo = require("./photo");
const dishService = require("./dish");
const ui = require("../utils/ui");

async function run() {
  wx.showLoading({ title: "检查中", mask: true });
  const photos = [];
  try {
    (await dishService.listDishes()).forEach((d) => photos.push(d.coverThumb || d.cover));
  } catch (e) {}
  const results = (await cloud.checkCollections()).concat(await photo.check(photos));
  wx.hideLoading();
  const lines = results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}：${r.text}`);
  const tips = [];
  if (results.some((r) => !r.ok && r.name !== "照片")) {
    tips.push(`数据库：没建的集合在云开发控制台「数据库」里新建，每个集合的权限都设成自定义安全规则 ${cloud.SHARED_RULE}`);
  }
  if (results.some((r) => r.needsFunction)) {
    tips.push("照片：在开发者工具左边的 cloudfunctions 里右键 photo 文件夹，选「上传并部署：云端安装依赖」，部署好以后重新打开小程序");
  }
  const tip = tips.length ? `\n\n${tips.join("\n\n")}` : "\n\n都正常";
  return ui.alert("云开发检查", lines.join("\n") + tip);
}

module.exports = { run };
