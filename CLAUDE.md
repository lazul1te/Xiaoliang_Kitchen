# CLAUDE.md

## 项目

「拿手菜小本本」：两个人（或一家人）共用的微信小程序菜谱本，能打开小程序的人都能看、都能改同一份数据。原生小程序（JavaScript）+ 微信云开发。品牌、文案、主题色见 `design/brand.md`；功能、部署步骤和目录结构见 `README.md`。

- 不花钱：只用云开发免费环境里有的能力，不要引入收费的服务。小程序不发布上线就不收费（免费环境的活动写的截止 2026-12-31，之后的规则未知）。
- 只给自己人用：靠体验版分发，不提交审核、不发布。数据库规则允许所有能打开小程序的人读写，要改这个前提得先改数据权限。
- 个人主体小程序，体验成员最多 15 人。

## 开发和测试

- 这边跑不了小程序。改完跑 `npm test`（`tests/check.js`，不用装依赖）：先做静态检查，再用假的 `wx` / `wx.cloud`（内存里的云数据库，模拟两台手机和几种权限设置）/ `Page` 把页面流程跑一遍。界面效果要在微信开发者工具里看。
- 测试用的导入文件在 `tests/fixtures/`（照片换成了很小的图）。加了新功能，在 `tests/check.js` 里补一段流程。
- 开发者工具和体验版用同一个云环境，在开发者工具里测试会改到真实数据。
- 改了 `design/` 里的 SVG 图标，跑 `npm run icons` 重新导出 PNG（第一次先 `npm install`）。
- `imports/` 放生成的导入文件（整本菜谱和照片），不进 git。

## 代码约定

- 2 空格缩进、双引号、分号，中文注释；样式单位用 rpx。
- 页面不直接访问数据源，统一走 `miniprogram/services/`：
  - 读：`store.js` 在内存里放一份共用的分类和菜品，并缓存到本地（先显示缓存，后台再同步云上的）。页面用 `dishService.getVersion()` 判断数据有没有变；页面 `onShow` 调 `dishService.refreshIfStale()`（隔 15 秒以上才去云上查），菜单右侧支持下拉刷新。
  - 写：先写云数据库，成功后再更新 `store`。`update` 里的数组字段要用 `cloud.command().set()` 整个替换；返回「改了 0 条」要当失败处理（`cloud.notWritten()`）。
  - 改菜品前先读云上的记录，`updatedAt` 跟打开编辑页时不一样就是对方改过，页面会问要不要覆盖（`saveDish` 的 `baseUpdatedAt` / `force`）。
  - 云数据库集合 `categories`、`dishes`、`plans`、`cook_logs`、`meals`，权限是自定义安全规则 `{ "read": "auth.openid != null", "write": "auth.openid != null" }`（所有能打开小程序的人共用；只有体验成员能打开）。控制台不接受 `"write": true`，会报 `InvalidParameter, rule invalid`。小程序端一次最多读 20 条，`cloud.fetchAll()` 会分页读完。
  - 云存储：免费环境的权限是「仅创建者可读写」，用户确认过改不了（要升级付费版）。所以小程序里**不要直接读云文件**（`<image src="cloud://">`、`wx.cloud.downloadFile`、`wx.cloud.deleteFile` 对对方传的文件都会失败）：
    - 显示照片一律用全局组件 `<cloud-image>`（`components/cloud-image`，用法同 `<image>`），它通过 `services/photo.js` 请云函数 `photo`（`cloudfunctions/photo`，管理员身份）换临时链接。同一屏的照片攒一批换，链接缓存 9 分钟（私有文件的链接 10 分钟有效），加载失败会换新链接重试一次，还不行就发 `error` 事件。
    - 删照片用 `photo.remove`，导出读不到的照片用 `photo.read`，都走云函数；云函数没部署时退回客户端接口（自己传的照片照样能用）。
    - 改了 `cloudfunctions/photo` 要提醒用户在开发者工具里右键「上传并部署：云端安装依赖」。
    - 卡片照片加载失败换成占位图（`broken` 按照片地址记，下拉刷新清空）；「我的 → 检查一下云开发」（`services/diagnose.js`）用 `photo.check` 检查云函数和照片。
  - 照片：`image.js` 先压缩再传云存储；成品照传大图（`cover`）和小图（`coverThumb`），菜单卡片用小图。
- 菜品数据存进去、读出来都过一遍 `utils/dish.js` 的 `normalizeDish()`，保证字段齐全。
- 主题色用 `app.wxss` 里的 CSS 变量（`--yolk`、`--pan`、`--danger` 等），黄色底上一律用深色字。
- 界面统一的写法（都在 `app.wxss`）：
  - 字号用 `--fs-xl / lg / title / body / sub / small / tiny` 这几档；说明文字用 `.para`，小提示用 `.hint`，「还没有……」用 `.none`，页面里不要再各写一份。
  - 图标用 `images/icons/*.png`（48 格、3.2 粗线、圆头，和 Tab 图标同一种画法；SVG 源文件在 `design/icons`，`npm run icons` 导出），写成 `<image class="ic" src="/images/icons/xxx.png" />`，大小用 `.ic.sm / .lg / .xl`。按钮上不用 emoji；空状态、庆祝页可以用。
  - 看着小的按钮加 `.hit` 扩大点击范围（`::after` 往外扩一圈）。不要加在绝对定位的元素上，也不要加在紧挨着别的可点元素的地方（会盖住对方）。
  - 加载中用 `.sk` 灰色占位块（菜单页第一次读取时）。
  - 选项不要用 `<picker>` 滚轮（日期选择除外）：选项少的直接摆成 `.chip`（分类、熟练度、标签、今天/昨天、掌勺），选菜用 `<dish-picker>` 弹出面板（能搜、按分类），选时长用常用时长 + 「自定义」（`parseDuration` 认「25分钟」「1分30秒」）。从底部弹出的面板用 app.wxss 的 `.sheet-mask / .sheet`。
  - 没有照片时，用菜名第一个字当占位（菜品卡片、记录、想吃清单都一样）。
- 记录页一直要有加记录的入口（「＋ 记一笔」，点开某天时「＋ 这天再记一道」）：点日历只对没记录的日子才会问要不要补记，同一天可以记好几道。
- 导入导出给用户「本地」的办法（`utils/file.js`）：手机上小程序打不开系统文件管理器，所以导入是「从微信聊天选文件」或「粘贴复制的内容」，导出是「发到微信」、电脑版微信「存到电脑」（`wx.saveFileToDisk`）、不带照片时「复制成文字」。剪贴板要在隐私指引里声明「剪切板」，失败都走 `ui.apiFail`。
- 「我的」页只放常用的：想吃清单、库存是两个大方块；不常用的收进二级页（`pages/backup` 备份与导入）；「检查云开发」（`services/diagnose.js`）放在底部小字链接，菜单页读不到数据时也有入口。
- 共用的菜品卡片是 WXML 模板 `templates/dish-card.wxml`，样式放在 `app.wxss`；用到它的页面要提供 `onOpenDish` / `onPlus` / `onMinus`。
- `plans` 集合里放几条两个人共用的记录，读写都走 `services/shared-doc.js`（先改本地再按顺序写云上，每次只改对应字段 `_.inc` / `_.set` / `_.remove`，不会互相覆盖；读用 `cloud.findOne`，不用 `doc(id).get()`，后者找不到时报错文字不固定）：
  - `current` 菜篮（Tab 叫「菜篮」，页面路径还是 `pages/today`）、点菜单（`order`、`orderSeq`）和买菜清单的勾选 → `services/plan.js`。每个 Tab 页的 `onShow` 都调用 `planService.updateBadge()` 刷新角标
  - `pantry` 家里的库存 → `services/pantry.js`
  - `wishes` 想吃清单 → `services/wish.js`；「开始学」进 `dish-edit?wish=key`，存好后从清单里拿掉，照片沿用
- 云开发报错统一用 `cloud.explain(err, 集合名)` 翻成人话，写明是哪个集合；「检查一下云开发」会挨个读每个集合（`cloud.js` 的 `NAMES`）。
- 做菜记录在 `services/log.js`（集合 `cook_logs`，`store.js` 一起同步；集合没建时当作没有记录）。菜的 `cookCount` / `lastCookedAt` 由 `store.js` 按记录现算（用户反馈过次数和记录对不上），云上菜品记录里的这两个字段不再用。打卡照片要当菜的封面时另外传一份，删记录不会删掉封面。
- 烹饪模式 `pages/cook`：计时器按结束时间算（切到后台再回来也准），到点震动 + `utils/sound.js` 的提示音 + 弹窗。提示音以 base64 写在代码里，因为单独的音频文件可能被「过滤无依赖文件」漏掉。
- 数据导入 `services/import.js` 读的是导出的同一种格式（`app: "nashoucai-xiaobenben"`、`format: 1`，`photos` 里是 base64），按菜名跳过已有的菜，分类按名字对上；做菜记录按「同一道菜 + 同一分钟」去重（次数按记录现算，不用改菜）。也认手写的导入模板 `docs/菜谱导入模板.json`（顶层有 `菜谱` 数组，中文字段，`fromTemplate` 转成同一种格式）；改模板的字段要同步改 `fromTemplate` 和测试。要批量加菜，就生成这种文件放到 `imports/`（不进 git），在「我的 → 备份与导入 → 从文件导入」里选；照片原图处理好放 `design/dishes/`。
- 点菜单：菜篮页下单前是「确认点菜单」（哪天、哪一顿、口味、谁点的、谁掌勺），下单以后最上面是点菜单。
  - 点菜单存在 `current` 的 `order` 里（格式见 `utils/order.js` 的 `normalizeOrder`），`items` 是下单时点的菜，之后再点的显示「加」。编号 `orderSeq` 每次下单 +1，撤单的编号不再用；菜篮空了点菜单也一起去掉。
  - 「存成图片」「发给 TA」的卡片封面用 `utils/ticket.js` 画在页面里看不见的 `<canvas type="2d" id="ticket-canvas">` 上；存成图片用 `wx.showShareImageMenu`，卡片封面在 `onShareAppMessage` 前先画好（5:4）。
- 开饭（`pages/meal`、`services/meal.js`）：一顿饭一条 `meals` 记录（格式见 `utils/meal.js`），每道做了的菜在 `cook_logs` 里各记一条，带 `mealId`；整桌照片只存在 `meals` 上（放在云存储 `logs/`），记录自己没照片时显示整桌照片。
  - 先存记录、最后存这一顿，`_id` 都是开饭页打开时定好的（`meal…`、`meal…-1`），重试时已经存上的跳过，不会多记。
  - 做了的菜从菜篮拿掉、点菜单收起来（`plan.finishMeal`）；菜篮空了，勾选清空，自己加的只留没买的。
  - 记录页同一顿的合成一张卡片（`entriesOf`），能「再来一单」（`plan.addMany`）、「分享这顿饭」（小票盖「已开饭」）。一顿的记录删光了，这一顿和照片也删掉（`meal.removeIfEmpty`）。
  - 点菜单上的日子过了还没开饭，菜篮页会问「做了吗」，按那天记（`/pages/meal/index?date=`）。
  - 导出带上 `meals`，导入时按 `createdAt` 去重，记录的 `mealId` 换成新的那一顿。
- 买菜清单的合并规则在 `utils/shopping.js`：同名原料合在一起，数字用量 × 份数相加，单位不同或「适量」原样列出；再对比库存（名字去掉括号说明后对）：库存里有的放「家里有」，用完了的放「要买的」，库存里没记录的调料单独一组。
- 弹窗、提示用 `utils/ui.js`（Promise 形式，可以 await）。
- Tab 图标和头像的源文件在 `design/`（SVG），PNG 放在 `miniprogram/images/`，都用 `npm run icons` 导出。
- 云开发环境 ID 写在 `miniprogram/config.js`。
- 开发者工具的问题先看它在 Windows 上的日志：`C:\Users\<用户>\AppData\Local\微信开发者工具\User Data\<id>\WeappLog\logs`（比如导航栏图标裂图，是工具自己的 403，重启就好）。
