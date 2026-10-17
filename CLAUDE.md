# CLAUDE.md

## 项目

「拿手菜小本本」：用户和女朋友共用的微信小程序菜谱本，两个人都能看、都能改同一份数据。原生小程序（JavaScript）+ 微信云开发。品牌、文案、主题色见 `design/brand.md`；页面结构、首次运行步骤和里程碑进度见 `README.md`。

- 用户不愿意付费：不要引入任何收费的服务。云开发用的是官方免费环境，小程序不发布上线就不收费（活动写的截止 2026-12-31，之后的规则未知），所以只用体验版，不提交审核、不发布。
- 个人主体小程序，体验成员最多 15 人。

## 协作方式

- 用户第一次做微信小程序：每次改完用通俗的中文说明改了什么、在开发者工具里怎么看效果，涉及后台/控制台的操作要写清楚点哪里。
- 微信开发者工具跑在 Windows 上，项目在 `D:\project\Xiaoliang_Kitchen`（WSL 里是 `/mnt/d/project/Xiaoliang_Kitchen`）。这边没法运行小程序，改完用 node 加假的 `wx` / `wx.cloud`（内存里的云数据库，模拟两台手机和几种权限设置）/ `Page` 把页面流程跑一遍做冒烟测试，界面效果要请用户在模拟器里看。
- 开发者工具和体验版用同一个云环境，用户在开发者工具里测试会改到自己的真实数据。
- 开发者工具建了 git 仓库；用户没要求就不要提交。

## 代码约定

- 2 空格缩进、双引号、分号，中文注释；样式单位用 rpx。
- 页面不直接访问数据源，统一走 `miniprogram/services/`：
  - 读：`store.js` 在内存里放一份共用的分类和菜品，并缓存到本地（先显示缓存，后台再同步云上的）。页面用 `dishService.getVersion()` 判断数据有没有变；页面 `onShow` 调 `dishService.refreshIfStale()`（隔 15 秒以上才去云上查），菜单右侧支持下拉刷新。
  - 写：先写云数据库，成功后再更新 `store`。`update` 里的数组字段要用 `cloud.command().set()` 整个替换；返回「改了 0 条」要当失败处理（`cloud.notWritten()`）。
  - 改菜品前先读云上的记录，`updatedAt` 跟打开编辑页时不一样就是对方改过，页面会问要不要覆盖（`saveDish` 的 `baseUpdatedAt` / `force`）。
  - 云数据库集合 `categories`、`dishes`、`plans`、`cook_logs`，权限是自定义安全规则 `{ "read": "auth.openid != null", "write": "auth.openid != null" }`（所有能打开小程序的人共用；只有体验成员能打开）。控制台不接受 `"write": true`，会报 `InvalidParameter, rule invalid`。小程序端一次最多读 20 条，`cloud.fetchAll()` 会分页读完。
  - 云存储用默认权限：都能看，只有上传的人能删，所以删不掉对方传的旧照片时直接忽略。
  - 照片：`image.js` 先压缩再传云存储；成品照传大图（`cover`）和小图（`coverThumb`），菜单卡片用小图。
- 菜品数据存进去、读出来都过一遍 `utils/dish.js` 的 `normalizeDish()`，保证字段齐全。
- 主题色用 `app.wxss` 里的 CSS 变量（`--yolk`、`--pan`、`--danger` 等），黄色底上一律用深色字。
- 共用的菜品卡片是 WXML 模板 `templates/dish-card.wxml`，样式放在 `app.wxss`；用到它的页面要提供 `onOpenDish` / `onPlus` / `onMinus`。
- `plans` 集合里放几条两个人共用的记录，读写都走 `services/shared-doc.js`（先改本地再按顺序写云上，每次只改对应字段 `_.inc` / `_.set` / `_.remove`，不会互相覆盖；读用 `cloud.findOne`，不用 `doc(id).get()`，后者找不到时报错文字不固定）：
  - `current` 菜篮（Tab 叫「菜篮」，页面路径还是 `pages/today`）和买菜清单的勾选 → `services/plan.js`。每个 Tab 页的 `onShow` 都调用 `planService.updateBadge()` 刷新角标
  - `pantry` 家里的库存 → `services/pantry.js`
  - `wishes` 想吃清单 → `services/wish.js`；「开始学」进 `dish-edit?wish=key`，存好后从清单里拿掉，照片沿用
- 云开发报错统一用 `cloud.explain(err, 集合名)` 翻成人话，写明是哪个集合；「我的 → 检查云数据库」会挨个读四个集合。
- 做菜记录在 `services/log.js`（集合 `cook_logs`，`store.js` 一起同步；集合没建时当作没有记录）。菜的 `cookCount` / `lastCookedAt` 由 `store.js` 按记录现算（用户反馈过次数和记录对不上），云上菜品记录里的这两个字段不再用。打卡照片要当菜的封面时另外传一份，删记录不会删掉封面。
- 烹饪模式 `pages/cook`：计时器按结束时间算（切到后台再回来也准），到点震动 + `utils/sound.js` 的提示音 + 弹窗。提示音以 base64 写在代码里，因为单独的音频文件可能被「过滤无依赖文件」漏掉。
- 数据导入 `services/import.js` 读的是导出的同一种格式（`app: "nashoucai-xiaobenben"`、`format: 1`，`photos` 里是 base64），按菜名跳过已有的菜，分类按名字对上；做菜记录按「同一道菜 + 同一分钟」去重，导完把菜的次数取「文件里写的」和「实际记录数」里大的那个。要批量加菜，就生成这种文件放到 `imports/`（不进 git），让用户在「我的 → 数据导入」里选；照片原图处理好放 `design/dishes/`。
- 买菜清单的合并规则在 `utils/shopping.js`：同名原料合在一起，数字用量 × 份数相加，单位不同或「适量」原样列出；再对比库存（名字去掉括号说明后对）：库存里有的放「家里有」，用完了的放「要买的」，库存里没记录的调料单独一组。
- 弹窗、提示用 `utils/ui.js`（Promise 形式，可以 await）。
- Tab 图标和头像的源文件在 `design/`（SVG），PNG 放在 `miniprogram/images/`。
- 云开发环境 ID 写在 `miniprogram/config.js`。
- 开发者工具的问题先看它在 Windows 上的日志：`C:\Users\<用户>\AppData\Local\微信开发者工具\User Data\<id>\WeappLog\logs`（比如导航栏图标裂图，是工具自己的 403，重启就好）。
