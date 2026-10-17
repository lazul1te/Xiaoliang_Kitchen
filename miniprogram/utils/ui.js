// 弹窗和提示。包成 Promise，页面里可以直接 await
const PAN = "#3B3B42";
const DANGER = "#E5534B";

function toast(title) {
  wx.showToast({ title, icon: "none" });
}

function alert(title, content) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content: content || "",
      showCancel: false,
      confirmText: "知道了",
      confirmColor: PAN,
      complete: () => resolve(),
    });
  });
}

// 点「确定」返回 true，取消返回 false。danger: 确定按钮用红色（删除之类的操作）
function confirm({ title, content, confirmText, danger }) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content: content || "",
      confirmText: confirmText || "确定",
      confirmColor: danger ? DANGER : PAN,
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false),
    });
  });
}

// 带输入框的弹窗。确定返回输入的文字（去掉了首尾空格），取消返回 null
function prompt({ title, placeholder, value }) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      editable: true,
      placeholderText: placeholder || "",
      content: value || "",
      confirmColor: PAN,
      success: (res) => resolve(res.confirm ? String(res.content || "").trim() : null),
      fail: () => resolve(null),
    });
  });
}

// 微信接口调用失败时给个看得懂的说明；自己点了取消的不提示
function apiFail(action, err) {
  const msg = (err && (err.errMsg || err.message)) || String(err || "");
  const errno = err && err.errno;
  if (/cancel/.test(msg)) return;
  if (errno === 112 || /privacy agreement/.test(msg)) {
    alert(`暂时不能${action}`, "小程序后台的「用户隐私保护指引」里还没声明这项用途，或者声明还没审核通过。");
  } else if (errno === 103 || errno === 104 || /privacy/.test(msg)) {
    alert(`暂时不能${action}`, "需要先同意隐私保护指引。");
  } else {
    alert(`${action}失败`, msg);
  }
}

// 把 Error 或微信接口的报错对象变成一句话
function errorText(err) {
  return (err && (err.message || err.errMsg)) || String(err);
}

module.exports = { toast, alert, confirm, prompt, apiFail, errorText };
