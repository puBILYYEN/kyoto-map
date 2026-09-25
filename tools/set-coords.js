#!/usr/bin/env node
// 修改景點座標（使用者從 Google 地圖長按複製的座標，照抄貼上）。
//   node tools/set-coords.js t65 35.001872205038815, 135.74336623943248
// 只會改那一個景點的 lat/lng，其他內容完全不動；改壞會自動還原。
const { read, spotBlocks, inKansai, parseNum, safeWriteData } = require('./lib');

const [id, ...rest] = process.argv.slice(2);
const nums = rest.join(' ').split(/[,，\s]+/).filter(Boolean).map(parseNum);
const [lat, lng] = nums;

if (!id || nums.length !== 2 || nums.some(Number.isNaN)) {
  console.error('用法：node tools/set-coords.js <景點id> <緯度> <經度>\n例如：node tools/set-coords.js t65 35.0018, 135.7433');
  process.exit(1);
}
if (!inKansai(lat, lng)) {
  console.error(`❌ ${lat}, ${lng} 不在關西範圍。Google 地圖複製出來是「緯度, 經度」（35 開頭在前、135 開頭在後），請確認沒有寫反。`);
  process.exit(1);
}

const src = read('data.js');
const { lines, blocks } = spotBlocks(src);
const b = blocks[id];
if (!b) { console.error(`❌ 找不到 id「${id}」，先用 node tools/find.js 查正確的 id`); process.exit(1); }

const RE = /lat:\s*-?[\d.]+,\s*lng:\s*-?[\d.]+/;
let changedLine = -1;
let before = '';
for (let i = b.start; i <= b.end; i++) {
  const m = lines[i].match(RE);
  if (m) { before = m[0]; lines[i] = lines[i].replace(RE, `lat:${lat}, lng:${lng}`); changedLine = i; break; }
}
if (changedLine < 0) { console.error(`❌ ${id} 裡找不到 lat/lng，請人工檢查`); process.exit(1); }

const d = safeWriteData(lines.join('\n'), (data) => {
  const s = data.SPOTS.find(x => x.id === id);
  return (s && s.lat === lat && s.lng === lng) ? null : '寫入後讀回來的座標不一致';
});
const s = d.SPOTS.find(x => x.id === id);
console.log(`✅ ${id} ${s.name}（data.js 第 ${changedLine + 1} 行）`);
console.log(`   原本：${before}`);
console.log(`   改成：lat:${lat}, lng:${lng}`);
console.log('下一步：node tools/bump.js "修正 ' + s.name + ' 座標"，再 node tools/check.js');
