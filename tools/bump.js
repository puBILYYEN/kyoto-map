#!/usr/bin/env node
// 每次部署前的例行公事，一個指令做完：
//   node tools/bump.js "這次改了什麼（一句話）"
// 1. sw.js 的 VERSION 加 1（家人手機才會拿到新版）
// 2. VERSION.txt 最上面加一筆紀錄（版號自動加 1、日期用台灣時間）
const { read, write } = require('./lib');

const msg = process.argv.slice(2).join(' ').trim();
if (!msg) { console.error('用法：node tools/bump.js "這次改了什麼"'); process.exit(1); }

const sw = read('sw.js');
const m = sw.match(/const VERSION = 'v(\d+)';/);
if (!m) { console.error("❌ sw.js 裡找不到 const VERSION = 'vN';"); process.exit(1); }
const swNext = `v${Number(m[1]) + 1}`;
write('sw.js', sw.replace(m[0], `const VERSION = '${swNext}';`));

const vt = read('VERSION.txt');
const vm = vt.match(/^版本：v(\d+)/);
if (!vm) { console.error('❌ VERSION.txt 第一行不是「版本：vN」，sw.js 已經改了，VERSION.txt 請人工補'); process.exit(1); }
const next = Number(vm[1]) + 1;
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
write('VERSION.txt', `版本：v${next}\n更新時間：${date}\n\n${msg}\n\n---\n\n` + vt);

console.log(`✅ sw.js VERSION → '${swNext}'，VERSION.txt 新增 v${next}（${date}）`);
console.log('下一步：node tools/check.js');
