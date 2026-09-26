#!/usr/bin/env node
// 改完程式、commit 之前跑一次：  node tools/check.js
//
// 給接手的 AI 用的安全網。會檢查：
//   1. 所有 JS 檔語法有沒有壞（檔案被寫到一半截斷也會在這裡抓到）
//   2. data.js 的資料格式：id 重複、缺欄位、分類不存在、座標超出關西範圍（例如經緯度寫反）
//   3. 分類有沒有同時加進 data.js 的 CATEGORY_META 和 app.js 的 TABS
//   4. 有沒有混進簡體字（網站內容一律繁體中文）
//   5. index.html 載入順序（logger.js 必須第一個）、sw.js 快取清單的檔案都存在
//   6. 跟上一次 commit 比較：景點數有沒有變少、檔案有沒有突然縮水（整份重寫失敗的徵兆）、
//      前端檔案改了但 sw.js 的 VERSION 沒加 1
//
// 不需要安裝任何套件。結束代碼：0 = 全部通過，1 = 有錯誤要修。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const JS_FILES = ['logger.js', 'data.js', 'kyoto-border.js', 'app.js', 'tv.js', 'sw.js'];
const TOOL_FILES = fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).map(f => 'tools/' + f);
const FRONTEND = ['index.html', 'tv.html', 'tv.css', 'styles.css', ...JS_FILES.filter(f => f !== 'sw.js'), 'manifest.json'];

// ---------- 1. 語法 ----------
for (const f of [...JS_FILES, ...TOOL_FILES]) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
  } catch (e) {
    err(`${f} 語法錯誤：\n${String(e.stderr || e.message).trim().split('\n').slice(0, 6).join('\n')}`);
  }
}

// ---------- 2. data.js 內容 ----------
let D = null;
try {
  D = vm.runInNewContext(read('data.js') + '\n;({ SPOTS, CATEGORY_META, BOOKING_META, TRIP_PREP, PHRASES, TAX_REFUND })');
} catch (e) {
  err(`data.js 無法執行：${e.message}`);
}

const SHAPES = ['triangle', 'star', 'ingot', 'buddha', 'diamond', 'invtriangle', 'heart', 'heartstill'];
if (D) {
  const seen = new Map();
  D.SPOTS.forEach((s, i) => {
    const where = `SPOTS 第 ${i + 1} 筆（id=${s && s.id}）`;
    if (!s || typeof s !== 'object') { err(`${where} 不是物件`); return; }
    if (typeof s.id !== 'string' || !/^[a-z]\d+$/.test(s.id)) err(`${where}：id 格式要是「小寫字母+數字」，例如 t65`);
    if (seen.has(s.id)) err(`${where}：id 跟第 ${seen.get(s.id)} 筆重複`);
    seen.set(s.id, i + 1);
    for (const k of ['name', 'area', 'desc']) {
      if (typeof s[k] !== 'string' || !s[k].trim()) err(`${where}：缺少 ${k}`);
    }
    if (!Array.isArray(s.categories) || !s.categories.length) err(`${where}：categories 要是非空陣列`);
    else s.categories.forEach(c => { if (!D.CATEGORY_META[c]) err(`${where}：分類「${c}」沒有定義在 CATEGORY_META`); });
    if (typeof s.lat !== 'number' || typeof s.lng !== 'number') err(`${where}：lat/lng 要是數字（不要加引號）`);
    else if (s.lat < 34.3 || s.lat > 35.8 || s.lng < 134.9 || s.lng > 136.1) {
      err(`${where}：座標 ${s.lat}, ${s.lng} 不在關西範圍，是不是經緯度寫反或少打一位？`);
    }
    if (s.booking && !D.BOOKING_META[s.booking.level]) err(`${where}：booking.level「${s.booking.level}」不存在`);
    if (s.shape && !SHAPES.includes(s.shape)) err(`${where}：shape「${s.shape}」不存在（可用：${SHAPES.join('/')}）`);
    if (s.labelSide && !['left', 'right'].includes(s.labelSide)) err(`${where}：labelSide 只能是 left 或 right`);
  });
}

// ---------- 3. 分類要兩邊都加 ----------
try {
  const app = read('app.js');
  const m = app.match(/const TABS = \[([\s\S]*?)\];/);
  if (!m) err('app.js 找不到 const TABS = [...]');
  else if (D) {
    const tabCats = [...m[1].matchAll(/cat:\s*'([^']+)'/g)].map(x => x[1]).filter(c => c !== 'all');
    Object.keys(D.CATEGORY_META).forEach(k => { if (!tabCats.includes(k)) err(`分類「${k}」在 data.js 的 CATEGORY_META 有，但 app.js 的 TABS 沒有（下拉選單不會出現）`); });
    tabCats.forEach(c => { if (!D.CATEGORY_META[c]) err(`app.js 的 TABS 有「${c}」，但 data.js 的 CATEGORY_META 沒有定義（畫面會壞掉）`); });
  }
} catch (e) { err(`檢查 TABS 失敗：${e.message}`); }

// ---------- 4. 簡體字 ----------
// 只列「簡體專用、日文也不用」的常見字，避免日文地址（区、会、点、写…）被誤判
const SIMPLIFIED =
  '这们个为发时说车门东过还进对语该应资关开间问题线边场图际头馆买卖张长书网页电话读风飞乐药园远运选连钱铁银险验钟级约经给统总热爱认让识详请谁调贵费贴轻较辆迟逻邮锁锅闭阅队陆阳难须顾预领额驾骑鱼鸟龙齐龟缘闻务动办华业丽专两严义习乡亚产亲众优传伤' +
  '侧儿兴农况净则刚创别剧劳势协单卫历压厅县变听启员响围坏块处备复夺奋妇妈实审宽寻导层岁岛币师带帮广庆库庙废异弃弹归录彻忆态怀恶悬惊惯战户执扩扫扬护报担拥择挂换据损摄无显晓暂术杂权杨极构标样桥检欢气汉汤沟泽洁济浓涂润涨渐满滨灵灾烟烦烧牵犹狭猎环现畅疗盖盘础确离种积称稳穷签简类粮纪纯纸练组细终绍结绝绿编罗罚职联聪肃胜脑节苏荐获营虽虾补见观规视览觉计订讨训议记讲许论设访证评诉词译试诗诚误课谈谢贝负财责败货质购贸赏赛赞赵趋践轨转轮软载输辞辽达迁违适递遗邻郑酱释钢钥链销错闪闲闹阴阶陈隐雾韩顶项顺频颜饭饮饰饼驶驻骤鲜鸡鸭麦';
for (const f of ['data.js', 'app.js', 'index.html', 'logger.js', 'tv.js', 'tv.html']) {
  read(f).split('\n').forEach((line, i) => {
    if (line.includes('簡繁檢查：刻意')) return;
    const hits = [...new Set([...line].filter(ch => SIMPLIFIED.includes(ch)))];
    if (hits.length) err(`${f}:${i + 1} 有簡體字「${hits.join('')}」，請改成繁體：${line.trim().slice(0, 60)}`);
  });
}

// ---------- 5. 載入順序與快取清單 ----------
try {
  const html = read('index.html');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(x => x[1]);
  if (srcs[0] !== 'logger.js') err(`index.html 第一個 <script> 必須是 logger.js（目前是 ${srcs[0]}），不然前面的錯誤記不到`);
  const appIdx = srcs.indexOf('app.js');
  const dataIdx = srcs.indexOf('data.js');
  if (appIdx < 0 || dataIdx < 0 || dataIdx > appIdx) err('index.html 裡 data.js 必須在 app.js 前面載入');
  srcs.forEach(s => { if (!/^https?:/.test(s) && !fs.existsSync(path.join(ROOT, s))) err(`index.html 載入的 ${s} 不存在`); });

  const sw = read('sw.js');
  const core = sw.match(/const CORE = \[([\s\S]*?)\];/);
  if (core) {
    [...core[1].matchAll(/'\.\/([^']*)'/g)].map(x => x[1]).filter(Boolean).forEach(f => {
      if (!fs.existsSync(path.join(ROOT, f))) err(`sw.js 的 CORE 清單有 ${f}，但檔案不存在（離線快取會少抓）`);
    });
    srcs.filter(s => !/^https?:/.test(s)).forEach(s => {
      if (!core[1].includes(`'./${s}'`)) warn(`index.html 有載入 ${s}，但 sw.js 的 CORE 清單沒有它（離線時可能打不開）`);
    });
  }
} catch (e) { err(`檢查 index.html / sw.js 失敗：${e.message}`); }

// ---------- 5b. Hermes Agent 讀的 .hermes.md 要跟 HANDOFF-9B.md 一樣 ----------
// Hermes 每次只自動讀一個說明檔（.hermes.md 優先於 AGENTS.md），所以把 9B 快速卡複製一份給它
if (fs.existsSync(path.join(ROOT, '.hermes.md')) && read('.hermes.md') !== read('HANDOFF-9B.md')) {
  err('.hermes.md 跟 HANDOFF-9B.md 內容不一樣。改完 HANDOFF-9B.md 要再執行：cp HANDOFF-9B.md .hermes.md');
}

// ---------- 6. 跟上一次 commit 比 ----------
function gitShow(file) {
  try { return execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, stdio: 'pipe' }).toString(); }
  catch (e) { return null; }
}
const hasGit = gitShow('index.html') !== null;
if (hasGit) {
  const oldData = gitShow('data.js');
  if (oldData && D) {
    try {
      const oldSpots = vm.runInNewContext(oldData + '\n;SPOTS');
      if (D.SPOTS.length < oldSpots.length) {
        const gone = oldSpots.map(s => s.id).filter(id => !D.SPOTS.some(s => s.id === id));
        warn(`景點從 ${oldSpots.length} 個變成 ${D.SPOTS.length} 個，少了：${gone.join(', ')}。如果不是故意刪的，data.js 可能被截斷了！`);
      }
    } catch (e) { /* 舊版讀不了就不比 */ }
  }

  const changed = [];
  for (const f of [...FRONTEND, 'sw.js']) {
    const old = gitShow(f);
    if (old === null) { if (fs.existsSync(path.join(ROOT, f))) changed.push(f); continue; }
    const now = read(f);
    if (old !== now) changed.push(f);
    const oldLines = old.split('\n').length;
    const nowLines = now.split('\n').length;
    if (oldLines > 50 && nowLines < oldLines * 0.8) {
      err(`${f} 從 ${oldLines} 行變成 ${nowLines} 行（少了超過 20%）。很可能是整份重寫時被截斷，請用 git diff 確認，不要 commit！`);
    }
  }

  const frontendChanged = changed.filter(f => f !== 'sw.js');
  if (frontendChanged.length) {
    const ver = (s) => ((s || '').match(/const VERSION = '([^']+)'/) || [])[1];
    const oldVer = ver(gitShow('sw.js'));
    const nowVer = ver(read('sw.js'));
    if (oldVer && oldVer === nowVer) err(`改了 ${frontendChanged.join('、')}，但 sw.js 的 VERSION 還是 '${nowVer}'，要加 1，不然家人手機會一直用舊版`);
    const top = (s) => (s || '').split('\n')[0];
    if (top(gitShow('VERSION.txt')) === top(read('VERSION.txt'))) warn('VERSION.txt 最上面還沒有加這次的更新紀錄');
  }
} else {
  warn('找不到 git 紀錄，跳過「跟上一次 commit 比較」的檢查');
}

// ---------- 結果 ----------
console.log(`檢查 ${D ? D.SPOTS.length + ' 個景點、' + Object.keys(D.CATEGORY_META).length + ' 個分類' : '（data.js 讀不到）'}`);
warnings.forEach(w => console.log('⚠️  ' + w));
errors.forEach(e => console.log('❌ ' + e));
if (!errors.length) console.log(warnings.length ? '✅ 沒有錯誤（上面的 ⚠️ 請確認是不是故意的）' : '✅ 全部通過');
process.exit(errors.length ? 1 : 0);
