# 拿手菜小本本

好好做饭，也好好记录。

一个自用的菜谱小程序：像翻餐厅菜单一样挑今天要做的菜，每道菜记下原料和详细做法。原生小程序（JavaScript）+ 微信云开发。

## 怎么运行

用微信开发者工具打开本目录（`D:\project\Xiaoliang_Kitchen`），点「编译」。目前用的是 `miniprogram/mock/data.js` 里的示例菜谱，还没接云开发。

## 目录

```
miniprogram/
├── app.js / app.json / app.wxss   全局：云开发初始化、页面和 Tab、主题色
├── pages/
│   ├── menu/          菜单：点单式首页（左分类、右菜品、底部点菜栏）
│   ├── dish-detail/   菜品详情：原料、做法、小贴士
│   ├── today/         今日：点好的菜
│   ├── logs/          做菜记录（M4）
│   └── mine/          我的
├── templates/         菜品卡片模板，多个页面共用
├── services/dish.js   数据读取：现在读假数据，M2 换成云数据库
├── store/basket.js    点菜篮，存在手机本地
├── utils/dish.js      菜品显示格式化、搜索
├── mock/data.js       示例菜谱
└── images/            Tab 图标、Logo
design/                头像、Tab 图标源文件、品牌信息（不会打包进小程序）
cloudfunctions/        云函数（暂时没有）
```

## 进度

- [x] M1 静态原型：菜单页、详情页、点菜篮（示例数据）
- [ ] M2 接入云数据库：分类和菜品的增删改查、新增/编辑表单、图片上传
- [ ] M3 今日菜单 + 购物清单合并
- [ ] M4 烹饪模式 + 打卡记录
- [ ] M5 打磨，发体验版
