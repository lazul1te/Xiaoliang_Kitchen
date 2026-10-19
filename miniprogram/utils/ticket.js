// 把点菜单画成图片：「存成图片」是一张长条小票，「发给 TA」的小程序卡片用 5:4 的封面。
// 页面里放一个看不见的画布 <canvas type="2d" id="ticket-canvas" class="ticket-canvas" />，
// 用 getCanvas(page) 拿到它，再交给 ticketImage / cardImage，返回手机上的临时图片路径。
// 要画的内容（data）：
//   { title: "点菜单", noText: "No.012", lines: ["10月19日 周一 · 晚饭", "点菜 小鱼 · 掌勺 大熊"],
//     items: [{ name, right: "×2", tag: "加" }], notes: ["共 4 道菜 5 份", "备注：少辣"], stamp: "已下单",
//     photo: 画布上加载好的图片（可选，画在最上面） }
const C = {
  cream: "#FFF8EE",
  white: "#FFFFFF",
  pan: "#3B3B42",
  text2: "#6E6E76",
  text3: "#A0A0A8",
  wood: "#A0693F",
  line: "#D9CFC1",
  red: "#E5534B",
};
const SANS = "sans-serif";
const MONO = "monospace";

const TICKET_W = 360; // 小票宽度（逻辑像素），导出时放大 2 倍
const TICKET_SCALE = 2;
const CARD_W = 500; // 卡片 5:4
const CARD_H = 400;
const CARD_SCALE = 1.6;

function getCanvas(page, selector) {
  return new Promise((resolve, reject) => {
    page
      .createSelectorQuery()
      .select(selector || "#ticket-canvas")
      .fields({ node: true, size: true })
      .exec((res) => {
        const node = res && res[0] && res[0].node;
        if (node) resolve(node);
        else reject(new Error("画布还没准备好，稍后再试"));
      });
  });
}

function setFont(ctx, size, weight, family) {
  ctx.font = `${weight || "normal"} ${size}px ${family || SANS}`;
}

// 一行写不下就截短，加省略号
function fit(ctx, str, maxWidth) {
  const s = String(str || "");
  if (ctx.measureText(s).width <= maxWidth) return s;
  let cut = s;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// 按宽度折行，中文一个字一个字地断
function wrap(ctx, str, maxWidth) {
  const lines = [];
  let line = "";
  for (const ch of String(str || "")) {
    if (line && ctx.measureText(line + ch).width > maxWidth) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

// 斜着盖的红色印章：「已下单」「已开饭」
function stamp(ctx, label, cx, cy, size) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.21);
  setFont(ctx, size, "bold");
  const w = ctx.measureText(label).width + size * 1.1;
  const h = size * 1.7;
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = C.red;
  ctx.lineWidth = Math.max(2, size / 7);
  roundRect(ctx, -w / 2, -h / 2, w, h, size / 3);
  ctx.stroke();
  ctx.fillStyle = C.red;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 0, 1);
  ctx.restore();
}

// 画（或者只量一下）小票，返回总高度。draw 为 false 时只算高度
function paintTicket(ctx, data, draw, height) {
  const M = 20; // 小票外面留的奶白边
  const P = 22; // 小票里面的边距
  const left = M + P;
  const right = TICKET_W - M - P;
  const inner = right - left;
  const text = (str, x, y, size, opt) => {
    const o = opt || {};
    setFont(ctx, size, o.weight, o.family);
    if (!draw) return;
    ctx.fillStyle = o.color || C.pan;
    ctx.textAlign = o.align || "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(str, x, y);
  };
  const dash = (y) => {
    if (!draw) return;
    ctx.save();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.restore();
  };

  if (draw) {
    // 奶白底 + 白色小票（带一点阴影），底边是一排半圆的锯齿
    ctx.fillStyle = C.cream;
    ctx.fillRect(0, 0, TICKET_W, height);
    ctx.save();
    ctx.shadowColor = "rgba(59, 59, 66, 0.10)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = C.white;
    ctx.fillRect(M, M, TICKET_W - M * 2, height - M * 2);
    ctx.restore();
    ctx.fillStyle = C.cream;
    for (let x = M + 7; x < TICKET_W - M; x += 14) {
      ctx.beginPath();
      ctx.arc(x, height - M, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  let y = M + P;
  if (data.photo) {
    const h = Math.round(inner * 0.66);
    if (draw) {
      const img = data.photo;
      const scale = Math.max(inner / img.width, h / img.height);
      const sw = inner / scale;
      const sh = h / scale;
      ctx.save();
      roundRect(ctx, left, y, inner, h, 8);
      ctx.clip();
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, left, y, inner, h);
      ctx.restore();
    }
    y += h + 16;
  }
  y += 20;
  text("拿手菜小本本", TICKET_W / 2, y, 20, { weight: "bold", align: "center" });
  y += 16;
  dash(y);
  y += 30;
  text(data.title, left, y, 18, { weight: "bold" });
  text(data.noText || "", right, y, 15, { family: MONO, color: C.wood, align: "right" });
  (data.lines || []).forEach((line) => {
    y += 22;
    setFont(ctx, 13);
    text(fit(ctx, line, inner), left, y, 13, { color: C.text2 });
  });
  y += 16;
  dash(y);
  y += 8;
  (data.items || []).forEach((item) => {
    y += 28;
    setFont(ctx, 15, "normal", MONO);
    const rightW = ctx.measureText(item.right || "").width;
    setFont(ctx, 12);
    const tagW = item.tag ? ctx.measureText(item.tag).width + 12 : 0;
    setFont(ctx, 16);
    const name = fit(ctx, item.name, inner - rightW - tagW - 16);
    text(name, left, y, 16);
    if (item.tag) {
      setFont(ctx, 16);
      const x = left + ctx.measureText(name).width + 6;
      text(item.tag, x, y - 1, 12, { color: C.wood, weight: "bold" });
    }
    text(item.right || "", right, y, 15, { family: MONO, color: C.text2, align: "right" });
  });
  y += 18;
  dash(y);
  y += 6;
  const stampY = y + 26;
  (data.notes || []).forEach((note) => {
    setFont(ctx, 13);
    wrap(ctx, note, inner).forEach((line) => {
      y += 21;
      text(line, left, y, 13, { color: C.text2 });
    });
  });
  y += 34;
  text("好好做饭，也好好记录", TICKET_W / 2, y, 12, { color: C.text3, align: "center" });
  if (draw && data.stamp) stamp(ctx, data.stamp, right - 40, stampY, 16);
  return y + P + M + 6;
}

// 5:4 的卡片封面：编号、哪一顿和前几道菜
function paintCard(ctx, data) {
  ctx.fillStyle = C.cream;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.fillStyle = C.white;
  roundRect(ctx, 24, 24, CARD_W - 48, CARD_H - 48, 20);
  ctx.fill();
  const left = 56;
  const right = CARD_W - 56;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  setFont(ctx, 30, "bold");
  ctx.fillStyle = C.pan;
  ctx.fillText(fit(ctx, data.cardTitle, right - left), left, 90);
  const items = data.items || [];
  const shown = items.length > 4 ? items.slice(0, 3) : items;
  let y = 90;
  shown.forEach((item) => {
    y += 50;
    setFont(ctx, 26, "normal", MONO);
    const rightW = ctx.measureText(item.right || "").width;
    setFont(ctx, 28);
    ctx.fillStyle = C.pan;
    ctx.textAlign = "left";
    ctx.fillText(fit(ctx, item.name, right - left - rightW - 20), left, y);
    setFont(ctx, 26, "normal", MONO);
    ctx.fillStyle = C.text2;
    ctx.textAlign = "right";
    ctx.fillText(item.right || "", right, y);
  });
  if (items.length > shown.length) {
    y += 46;
    setFont(ctx, 24);
    ctx.fillStyle = C.text3;
    ctx.textAlign = "left";
    ctx.fillText(`…还有 ${items.length - shown.length} 道`, left, y);
  }
  setFont(ctx, 20);
  ctx.fillStyle = C.text3;
  ctx.textAlign = "left";
  ctx.fillText("拿手菜小本本", left, CARD_H - 52);
  if (data.stamp) stamp(ctx, data.stamp, right - 50, CARD_H - 70, 26);
}

function toImage(canvas) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
      destWidth: canvas.width,
      destHeight: canvas.height,
      fileType: "png",
      success: (res) => resolve(res.tempFilePath),
      fail: reject,
    });
  });
}

// 长条小票，返回临时图片路径
function ticketImage(canvas, data) {
  const ctx = canvas.getContext("2d");
  const height = Math.ceil(paintTicket(ctx, data, false));
  canvas.width = TICKET_W * TICKET_SCALE;
  canvas.height = height * TICKET_SCALE;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(TICKET_SCALE, TICKET_SCALE);
  paintTicket(ctx, data, true, height);
  return toImage(canvas);
}

// 小程序卡片的封面（5:4），返回临时图片路径
function cardImage(canvas, data) {
  const ctx = canvas.getContext("2d");
  canvas.width = CARD_W * CARD_SCALE;
  canvas.height = CARD_H * CARD_SCALE;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(CARD_SCALE, CARD_SCALE);
  paintCard(ctx, data);
  return toImage(canvas);
}

// 照片画到画布上之前要先加载；加载不了返回 null（图片里就不放照片）
function loadImage(canvas, src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const img = canvas.createImage();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

module.exports = { getCanvas, ticketImage, cardImage, loadImage };
