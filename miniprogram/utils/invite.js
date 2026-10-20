// 邀请家人：发一张小程序卡片，对方点开就是「加入家庭本本」页面，家庭码已经填好；封面是 utils/ticket.js 画的邀请卡片。
// 页面里要放看不见的画布 <canvas type="2d" id="ticket-canvas" class="ticket-canvas" />：
// 显示时 prepare(page, book) 先把封面画好，onShareAppMessage 里返回 share(page, book)
const ticketUtil = require("./ticket");

function cardData(book) {
  return { name: book.name, code: book.code, from: book.myName };
}

function shareOf(book) {
  const title = book.myName ? `${book.myName}邀请你加入「${book.name}」` : `邀请你加入「${book.name}」一起记菜`;
  return { title, path: `/pages/join/index?code=${book.code}` };
}

// 先把封面画好（本本名字、家庭码变了才重画；没画成下次再画）
function prepare(page, book) {
  const data = cardData(book);
  const key = JSON.stringify(data);
  if (page.inviteKey === key) return page.invitePromise;
  page.inviteKey = key;
  page.inviteImage = "";
  page.invitePromise = ticketUtil
    .getCanvas(page)
    .then((canvas) => ticketUtil.inviteImage(canvas, data))
    .then((path) => {
      if (page.inviteKey === key) page.inviteImage = path;
      return path;
    })
    .catch(() => {
      if (page.inviteKey === key) page.inviteKey = "";
      return "";
    });
  return page.invitePromise;
}

// 封面画好了直接带上；还没画好先给默认的，画好了换上（微信最多等 3 秒）
function share(page, book) {
  const result = shareOf(book);
  if (page.inviteImage && page.inviteKey === JSON.stringify(cardData(book))) return Object.assign({ imageUrl: page.inviteImage }, result);
  return Object.assign({}, result, {
    promise: prepare(page, book).then((imageUrl) => (imageUrl ? Object.assign({ imageUrl }, result) : result)),
  });
}

module.exports = { prepare, share };
