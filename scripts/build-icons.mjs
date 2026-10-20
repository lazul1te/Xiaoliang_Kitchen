// 把 design/ 里的 SVG 图标导出成小程序用的 PNG：改了 SVG 以后跑 npm run icons（第一次先 npm install）。
// 用法: node scripts/build-icons.mjs [输出目录]，默认直接写进 miniprogram/images
import { createRequire } from "node:module";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sharp = createRequire(import.meta.url)("sharp");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] || join(root, "miniprogram/images"));
const design = (name) => join(root, "design", name);

// 先按高密度渲染再缩小，边缘更平滑
async function svgToPng(src, dest, size, density, png = {}) {
  mkdirSync(dirname(dest), { recursive: true });
  await sharp(src, { density }).resize(size, size).png(png).toFile(dest);
}

// 界面小图标：48 格、3.2 粗线、圆头，导出 64px
for (const file of readdirSync(design("icons")).filter((f) => f.endsWith(".svg"))) {
  await svgToPng(design(`icons/${file}`), join(out, "icons", file.replace(".svg", ".png")), 64, 192, { compressionLevel: 9 });
}

// Tab 图标：每个有没选中 / 选中（-active）两张，导出 81px（today 是「点菜单」）
for (const name of ["menu", "today", "logs", "mine"]) {
  for (const suffix of ["", "-active"]) {
    await svgToPng(design(`tabbar/${name}${suffix}.svg`), join(out, "tabbar", `${name}${suffix}.png`), 81, 288);
  }
}

// 菜单底部点菜栏的菜篮（深色底上用）、「点菜单」页还没点菜时的大图
await svgToPng(design("tabbar/basket-bar.svg"), join(out, "basket.png"), 96, 288);
await svgToPng(design("tabbar/basket-big.svg"), join(out, "basket-big.png"), 240, 600);

// 「我的」页顶部的小头像
await sharp(design("avatar/avatar-b-egg.png")).resize(200, 200).png().toFile(join(out, "logo.png"));

console.log("图标已导出到", out);
