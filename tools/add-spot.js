#!/usr/bin/env node
// 新增一個景點，自動挑下一個 id、自動插在同分類的最後面，不用自己改 data.js。
//
//   node tools/add-spot.js --cat temple --name "壬生寺" --area "市中心・壬生" \
//     --lat 35.001872205038815 --lng 135.74336623943248 \
//     --desc "介紹文字" [--address "地址"] [--hours "8:30–17:00"]
//
//   --cat 可以寫多個分類，用逗號分開：--cat temple,enmusubi（第一個決定 id 開頭字母）
//   --prefix x   選填。全新分類會自動挑一個沒用過的 id 開頭字母，通常不用寫
//   --force      名稱跟既有景點重複時仍然新增
//   美食店另外要加（小類 key 見 data.js 的 FOOD_TAGS，可多個用逗號分開）：
//     --tags japan,photo --talk "回台灣可以這樣聊的一句話（只寫查證過的事實）"
// 查分類 key：node tools/find.js（不加關鍵字）
const { read, loadData, spotBlocks, inKansai, parseNum, parseArgs, jsStr, safeWriteData } = require('./lib');

const a = parseArgs(process.argv.slice(2));
const need = ['cat', 'name', 'area', 'lat', 'lng', 'desc'];
const missing = need.filter(k => a[k] === undefined || a[k] === true);
if (missing.length) {
  console.error(`❌ 缺少：${missing.map(k => '--' + k).join(' ')}\n用法見檔案開頭說明：node tools/add-spot.js --cat temple --name "名稱" --area "地區" --lat 35.0 --lng 135.7 --desc "介紹"`);
  process.exit(1);
}

const src = read('data.js');
const d = loadData(src);
const cats = String(a.cat).split(/[,，]/).map(s => s.trim()).filter(Boolean);
const badCat = cats.filter(c => !d.CATEGORY_META[c]);
if (badCat.length) {
  console.error(`❌ 分類不存在：${badCat.join(', ')}。可用的分類：\n${Object.entries(d.CATEGORY_META).map(([k, v]) => `  ${k}（${v.label}）`).join('\n')}`);
  process.exit(1);
}
const lat = parseNum(a.lat);
const lng = parseNum(a.lng);
if (Number.isNaN(lat) || Number.isNaN(lng) || !inKansai(lat, lng)) {
  console.error(`❌ 座標 ${a.lat}, ${a.lng} 不正確或不在關西範圍（緯度 35 開頭、經度 135 開頭，不要寫反）`);
  process.exit(1);
}
const dup = d.SPOTS.find(s => s.name === a.name);
if (dup && !a.force) {
  console.error(`❌ 已經有同名景點：${dup.id} ${dup.name}。要改它的內容請不要新增；確定要新增再加 --force`);
  process.exit(1);
}

// id 開頭字母：沿用同一個主分類既有景點最常用的字母
const sameCat = d.SPOTS.filter(s => s.categories[0] === cats[0]);
let prefix = a.prefix && a.prefix !== true ? String(a.prefix) : null;
const usedLetters = new Set(d.SPOTS.map(s => s.id[0]));
if (prefix) {
  if (!/^[a-z]$/.test(prefix)) { console.error('❌ --prefix 只能是一個小寫英文字母'); process.exit(1); }
  if (usedLetters.has(prefix) && !sameCat.some(s => s.id[0] === prefix) && !a.force) {
    console.error(`❌ 字母 ${prefix} 已經被其他分類用了，換一個，或不要加 --prefix 讓程式自動挑`);
    process.exit(1);
  }
} else if (sameCat.length) {
  const count = {};
  sameCat.forEach(s => { count[s.id[0]] = (count[s.id[0]] || 0) + 1; });
  prefix = Object.keys(count).sort((x, y) => count[y] - count[x])[0];
} else {
  // 全新分類的第一個景點：自動挑一個還沒被用過的字母
  prefix = 'abcdefghijklmnopqrstuvwxyz'.split('').find(c => !usedLetters.has(c));
  if (!prefix) { console.error('❌ 26 個字母都用完了，請人工處理'); process.exit(1); }
  console.log(`ℹ️ ${cats[0]} 是新分類，id 開頭自動用字母 ${prefix}`);
}
const nums = d.SPOTS.filter(s => s.id[0] === prefix).map(s => Number(s.id.slice(1)));
const id = prefix + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0');

const foodTags = a.tags && a.tags !== true ? String(a.tags).split(/[,，]/).map(t => t.trim()).filter(Boolean) : [];
const badTag = foodTags.filter(t => !(d.FOOD_TAGS || {})[t]);
if (badTag.length) {
  console.error(`❌ 美食小類不存在：${badTag.join(', ')}。可用：${Object.entries(d.FOOD_TAGS || {}).map(([k, v]) => `${k}（${v}）`).join('、')}`);
  process.exit(1);
}
const foodPart = (foodTags.length ? ` foodTags:[${foodTags.map(t => `'${t}'`).join(',')}],` : '')
  + (a.talk && a.talk !== true ? ` talk:${jsStr(a.talk)},` : '');
const parts = [`  { id:'${id}', categories:[${cats.map(c => `'${c}'`).join(',')}],${foodPart} name:${jsStr(a.name)}, area:${jsStr(a.area)}, lat:${lat}, lng:${lng},`];
if (a.address && a.address !== true) parts.push(`    address:${jsStr(a.address)},`);
if (a.hours && a.hours !== true) parts.push(`    hours:${jsStr(a.hours)},`);
parts.push(`    desc:${jsStr(a.desc)} },`);

// 插在同開頭字母的最後一個景點後面；都沒有就插在整個 SPOTS 陣列最後
const { lines, blocks } = spotBlocks(src);
const samePrefix = Object.keys(blocks).filter(k => k[0] === prefix);
let insertAt;
if (samePrefix.length) {
  insertAt = Math.max(...samePrefix.map(k => blocks[k].end)) + 1;
} else {
  insertAt = lines.findIndex((l, i) => i > Math.max(...Object.values(blocks).map(b => b.end)) && l.trim() === '];');
}
if (insertAt < 0) { console.error('❌ 找不到插入位置，請人工處理'); process.exit(1); }
lines.splice(insertAt, 0, ...parts);

const before = d.SPOTS.length;
safeWriteData(lines.join('\n'), (nd) => {
  if (nd.SPOTS.length !== before + 1) return `景點數應該是 ${before + 1}，實際是 ${nd.SPOTS.length}`;
  const s = nd.SPOTS.find(x => x.id === id);
  return (s && s.name === String(a.name).trim()) ? null : '新景點讀不回來';
});
console.log(`✅ 新增 ${id} ${a.name}（data.js 第 ${insertAt + 1} 行），共 ${before + 1} 個景點`);
console.log(`下一步：node tools/bump.js "新增景點：${a.name}"，再 node tools/check.js`);
