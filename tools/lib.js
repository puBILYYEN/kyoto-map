// tools/ 裡各個指令共用的小工具。不需要安裝任何套件。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const file = (f) => path.join(ROOT, f);
const read = (f) => fs.readFileSync(file(f), 'utf8');
const write = (f, s) => fs.writeFileSync(file(f), s, 'utf8');

function loadData(src) {
  return vm.runInNewContext((src == null ? read('data.js') : src) +
    '\n;({ SPOTS, CATEGORY_META, BOOKING_META, FOOD_TAGS: typeof FOOD_TAGS === "undefined" ? {} : FOOD_TAGS })');
}

// 每個景點在 data.js 裡是從「{ id:'x01'」那行開始、到第一個以「},」結尾的行為止
function spotBlocks(src) {
  const lines = src.split('\n');
  const blocks = {};
  lines.forEach((l, i) => {
    const m = l.match(/^\s*\{\s*id:'([a-z]\d+)'/);
    if (!m) return;
    let end = i;
    while (end < lines.length && !lines[end].trimEnd().endsWith('},')) end++;
    blocks[m[1]] = { start: i, end };
  });
  return { lines, blocks };
}

function inKansai(lat, lng) {
  return lat >= 34.3 && lat <= 35.8 && lng >= 134.9 && lng <= 136.1;
}

// 使用者常直接貼 Google 地圖複製的「35.0018, 135.7433」，逗號黏在數字後面也要能吃
function parseNum(v) {
  const n = Number(String(v == null ? '' : v).replace(/[,，\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// --key value 形式的參數
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// 字串放進 data.js 的單引號裡要跳脫，換行改成空白（data.js 一個欄位一行）
function jsStr(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ').trim() + "'";
}

// 改檔案前先備份，改完驗證失敗就還原，保證不會留下壞掉的 data.js
function safeWriteData(newSrc, check) {
  const oldSrc = read('data.js');
  write('data.js', newSrc);
  try {
    const d = loadData(newSrc);
    const problem = check ? check(d) : null;
    if (problem) throw new Error(problem);
    return d;
  } catch (e) {
    write('data.js', oldSrc);
    console.error('❌ 修改後驗證失敗，data.js 已還原成原本的樣子：' + e.message);
    process.exit(1);
  }
}

module.exports = { ROOT, file, read, write, loadData, spotBlocks, inKansai, parseNum, parseArgs, jsStr, safeWriteData };
