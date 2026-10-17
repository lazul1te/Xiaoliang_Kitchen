// app.js：启动时初始化云开发（环境 ID 在 config.js 里）
const cloud = require("./services/cloud");

App({
  onLaunch() {
    try {
      cloud.init();
    } catch (e) {
      console.error(e);
    }
  },
});
