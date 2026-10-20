// 显示云存储里的照片，用法和 <image> 一样：
//   <cloud-image class="cover" src="{{fileID}}" mode="aspectFill" binderror="onCoverError" />
// 先请云函数换成这本里的人都能看的临时链接（见 services/photo.js）。链接过期了自动换新的再试一次，
// 还是不行就发出 error 事件，页面可以换成占位图。手机上刚选的临时照片直接显示。
const photo = require("../../services/photo");

Component({
  properties: {
    src: { type: String, value: "" },
    mode: { type: String, value: "scaleToFill" },
  },

  data: {
    url: "",
  },

  observers: {
    src(src) {
      this.show(src);
    },
  },

  lifetimes: {
    attached() {
      this.show(this.data.src);
    },
  },

  methods: {
    show(src) {
      if (src === this.shown) return Promise.resolve();
      this.shown = src;
      this.retried = false;
      return this.load(src, false);
    },

    async load(src, fresh) {
      const url = await photo.urlOf(src, fresh);
      if (src !== this.shown) return; // 已经换成别的照片了
      // 重试时没换到新地址（比如云函数没部署）：图片不会重新加载，直接告诉页面
      if (fresh && url === this.data.url) {
        this.triggerEvent("error", { src });
        return;
      }
      this.setData({ url });
      if (!url && src) this.triggerEvent("error", { src });
    },

    onError() {
      const src = this.shown;
      if (!this.retried && photo.isCloudFile(src)) {
        this.retried = true;
        return this.load(src, true);
      }
      this.triggerEvent("error", { src });
      return Promise.resolve();
    },
  },
});
