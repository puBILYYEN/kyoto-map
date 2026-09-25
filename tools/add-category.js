#!/usr/bin/env node
// 新增一個分類，一次把 data.js 的 CATEGORY_META 和 app.js 的 TABS 兩邊都加好。
//   node tools/add-category.js food "美食之旅"            ← 顏色自動挑
//   node tools/add-category.js food "美食之旅" "#7b3f00"   ← 自己指定顏色（要深色，白字才看得清楚）
// key 只能用小寫英文字母。新增後再用 add-spot.js --cat food ... 加景點。
const { read, write, loadData } = require('./lib');

const [key, label, colorArg] = process.argv.slice(2);
if (!key || !label) {
  console.error('用法：node tools/add-category.js <英文key> "<中文名稱>" [顏色]\n例如：node tools/add-category.js food "美食之旅"');
  process.exit(1);
}
if (!/^[a-z]+$/.test(key)) { console.error('❌ key 只能用小寫英文字母，例如 food、onsen'); process.exit(1); }

const dataSrc = read('data.js');
const appSrc = read('app.js');
const d = loadData(dataSrc);
if (d.CATEGORY_META[key]) { console.error(`❌ 分類「${key}」已經存在（${d.CATEGORY_META[key].label}）`); process.exit(1); }
if (Object.values(d.CATEGORY_META).some(c => c.label === label)) { console.error(`❌ 已經有叫「${label}」的分類`); process.exit(1); }

// 白字要看得清楚的深色，挑一個還沒用過的
const PALETTE = ['#6a1b9a', '#00695c', '#4e342e', '#283593', '#ad1457', '#33691e', '#bf360c', '#37474f', '#4a148c', '#004d40', '#880e4f', '#1a237e'];
const used = Object.values(d.CATEGORY_META).map(c => c.color.toLowerCase());
const color = colorArg || PALETTE.find(c => !used.includes(c));
if (!/^#[0-9a-fA-F]{6}$/.test(color || '')) { console.error('❌ 顏色格式要像 #7b3f00'); process.exit(1); }

const labelJs = "'" + label.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

// data.js：插在 CATEGORY_META 的結尾 }; 前面
const metaStart = dataSrc.indexOf('const CATEGORY_META = {');
const metaEnd = dataSrc.indexOf('\n};', metaStart);
if (metaStart < 0 || metaEnd < 0) { console.error('❌ data.js 找不到 CATEGORY_META'); process.exit(1); }
const newData = dataSrc.slice(0, metaEnd) + `\n  ${key}: { label: ${labelJs}, color: '${color}' },` + dataSrc.slice(metaEnd);

// app.js：插在 TABS 的結尾 ]; 前面
const tabsStart = appSrc.indexOf('const TABS = [');
const tabsEnd = appSrc.indexOf('\n];', tabsStart);
if (tabsStart < 0 || tabsEnd < 0) { console.error('❌ app.js 找不到 const TABS'); process.exit(1); }
const newApp = appSrc.slice(0, tabsEnd) + `\n  { cat: '${key}', label: CATEGORY_META.${key}.label },` + appSrc.slice(tabsEnd);

write('data.js', newData);
write('app.js', newApp);
try {
  const nd = loadData(newData);
  if (!nd.CATEGORY_META[key] || nd.SPOTS.length !== d.SPOTS.length) throw new Error('讀回來不對');
} catch (e) {
  write('data.js', dataSrc);
  write('app.js', appSrc);
  console.error('❌ 修改後驗證失敗，兩個檔案都已還原：' + e.message);
  process.exit(1);
}
console.log(`✅ 新增分類 ${key}「${label}」（顏色 ${color}），data.js 與 app.js 都加好了`);
console.log(`下一步：用 node tools/add-spot.js --cat ${key} ... 加景點，最後 node tools/bump.js "新增分類：${label}" 再 node tools/check.js`);
