#!/usr/bin/env node
// 查景點，不用讀整個 data.js。
//   node tools/find.js 壬生寺        → 用名稱、地區或 id 搜尋
//   node tools/find.js t65           → 用 id 查
//   node tools/find.js               → 列出所有分類、數量與 id 開頭字母
const { read, loadData, spotBlocks } = require('./lib');

const q = process.argv.slice(2).join(' ').trim();
const src = read('data.js');
const d = loadData(src);
const { blocks } = spotBlocks(src);

if (!q) {
  console.log('分類 key ｜ 中文名稱 ｜ 景點數 ｜ id 開頭');
  Object.entries(d.CATEGORY_META).forEach(([k, v]) => {
    const list = d.SPOTS.filter(s => s.categories.includes(k));
    const prefixes = [...new Set(list.filter(s => s.categories[0] === k).map(s => s.id[0]))].join('/') || '（跟別的分類共用）';
    console.log(`${k} ｜ ${v.label} ｜ ${list.length} ｜ ${prefixes}`);
  });
  console.log(`共 ${d.SPOTS.length} 個景點`);
  process.exit(0);
}

const hits = d.SPOTS.filter(s => s.id === q || s.name.includes(q) || s.area.includes(q) || (s.address || '').includes(q));
if (!hits.length) { console.log(`找不到「${q}」`); process.exit(1); }
hits.slice(0, 30).forEach(s => {
  const b = blocks[s.id];
  const lines = b ? `data.js 第 ${b.start + 1}${b.end > b.start ? '–' + (b.end + 1) : ''} 行` : '';
  console.log(`${s.id} ｜ ${s.name} ｜ ${s.categories.map(c => d.CATEGORY_META[c].label).join('、')} ｜ ${s.area} ｜ ${s.lat}, ${s.lng} ｜ ${lines}`);
});
if (hits.length > 30) console.log(`……還有 ${hits.length - 30} 筆，請用更精確的關鍵字`);
