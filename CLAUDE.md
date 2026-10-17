# CLAUDE.md

## 项目

「拿手菜小本本」：自用的微信小程序菜谱本，原生小程序（JavaScript）+ 微信云开发。品牌、文案、主题色见 `design/brand.md`；页面结构和里程碑进度见 `README.md`。只用体验版自用，不备案、不上架。

## 协作方式

- 用户第一次做微信小程序：每次改完用通俗的中文说明改了什么、在开发者工具里怎么看效果，涉及后台/控制台的操作要写清楚点哪里。
- 微信开发者工具跑在 Windows 上，项目在 `D:\project\Xiaoliang_Kitchen`（WSL 里是 `/mnt/d/project/Xiaoliang_Kitchen`）。这边没法运行小程序，改完可以用 node 加假的 `wx` / `Page` 对象跑一遍页面逻辑做冒烟测试，界面效果要请用户在模拟器里看。

## 代码约定

- 2 空格缩进、双引号、分号，中文注释；样式单位用 rpx。
- 页面不直接访问数据源，统一走 `miniprogram/services/`：M1 读 `mock/data.js`，接入云数据库时只改 services。
- 主题色用 `app.wxss` 里的 CSS 变量（`--yolk`、`--pan` 等），黄色底上一律用深色字。
- 共用的菜品卡片是 WXML 模板 `templates/dish-card.wxml`，样式放在 `app.wxss`；用到它的页面要提供 `onOpenDish` / `onPlus` / `onMinus`。
- 点菜篮在 `store/basket.js`，存在本地缓存；每个 Tab 页的 `onShow` 都调用 `updateBadge()` 刷新「今日」角标。
- Tab 图标和头像的源文件在 `design/`（SVG），PNG 放在 `miniprogram/images/`。
- 云开发环境 ID 写在 `miniprogram/app.js` 的 `globalData.env`（M2 时填）。
