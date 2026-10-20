// 想吃清单：先记个菜名和一张图（再加一句备注），以后慢慢学。
// 这本小本本里的人共用，存在 plans 集合里这本的 wishes 那条：items { key: { name, photo, photoThumb, note, createdAt } }
// 「开始学」会把它写成正式菜谱（照片直接沿用），然后从清单里拿掉。
const { createSharedDoc } = require("./shared-doc");
const imageService = require("./image");
const { newId } = require("../utils/id");

const text = (v) => (v === undefined || v === null ? "" : String(v)).trim();

function normalize(doc) {
  const p = { items: {} };
  const items = (doc && doc.items) || {};
  Object.keys(items).forEach((key) => {
    const w = items[key];
    if (w && w.name) {
      p.items[key] = {
        name: text(w.name),
        photo: text(w.photo),
        photoThumb: text(w.photoThumb),
        note: text(w.note),
        createdAt: Number(w.createdAt) || 0,
      };
    }
  });
  return p;
}

const doc = createSharedDoc({ id: "wishes", cacheKey: "wish_cache", label: "想吃清单", normalize });

// 新加的在前
function list() {
  const items = doc.current().items;
  return Object.keys(items)
    .map((key) => Object.assign({ key }, items[key]))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function get(key) {
  const w = doc.current().items[key];
  return w ? Object.assign({ key }, w) : null;
}

// 保存（新增或修改）。新选的照片还在手机上，先传到云存储
async function save(input) {
  const old = input.key ? get(input.key) : null;
  const key = old ? old.key : `w${newId()}`;
  const wish = {
    name: text(input.name),
    photo: text(input.photo),
    photoThumb: old && input.photo === old.photo ? old.photoThumb : "",
    note: text(input.note),
    createdAt: old ? old.createdAt : Date.now(),
  };
  if (!wish.name) throw new Error("写个菜名");
  if (wish.photo && !imageService.isCloudFile(wish.photo)) {
    const files = await imageService.uploadCover(wish.photo, "wishes");
    wish.photo = files.cover;
    wish.photoThumb = files.thumb;
  }
  await doc.write(
    (p) => {
      p.items[key] = wish;
    },
    (_) => ({ [`items.${key}`]: _.set(wish) })
  );
  if (old && old.photo && old.photo !== wish.photo) imageService.remove([old.photo, old.photoThumb]);
  return Object.assign({ key }, wish);
}

// 删掉。keepPhoto：照片已经给菜谱用了，就别删
function remove(key, options = {}) {
  const old = get(key);
  if (!old) return;
  doc.write(
    (p) => {
      delete p.items[key];
    },
    (_) => ({ [`items.${key}`]: _.remove() })
  );
  if (!options.keepPhoto) imageService.remove([old.photo, old.photoThumb]);
}

module.exports = {
  getVersion: doc.getVersion,
  sync: doc.sync,
  whenFresh: doc.whenFresh,
  syncIfStale: doc.syncIfStale,
  list,
  get,
  save,
  remove,
};
