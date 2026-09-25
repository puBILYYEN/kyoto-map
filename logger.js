// 京都行程景點地圖 — 系統記錄（.log）
//
// 目的：出問題時，不用靠家人口頭描述「剛剛突然怎樣」，而是直接下載一份
// .log 檔交給 AI（Claude、Gemini 或其他接手的 AI）看，就能知道當時發生什麼事。
//
// 設計重點：
//   1. 這支檔案在 index.html 裡排在所有程式「最前面」載入，
//      這樣連 app.js 本身載入就當掉（例如 TDZ 錯誤）也記得到。
//   2. 自動攔截 console.warn / console.error、未捕捉的錯誤、未處理的 Promise
//      失敗、以及 <script>/<link> 載入失敗——app.js 裡原本就有的
//      console.warn('[跳棋] ...') 這類訊息全部會自動進記錄，不用逐一修改。
//   3. 記錄存在這台裝置的 localStorage（最多 MAX 筆，舊的自動丟掉），
//      重新整理頁面也還在；不會上傳到任何伺服器，每個人的手機各自一份。
//   4. 連續出現一模一樣的訊息只記一筆、後面加「×次數」，避免地圖圖磚
//      載入失敗之類的錯誤一次灌爆整份記錄。
//   5. 任何一步失敗都吞掉，記錄功能壞掉絕對不能拖垮網站本身。
//
// 其他程式呼叫方式：sysLog('info' | 'warn' | 'error', '標籤', '訊息')
// app.js 裡是透過 appLog()（找不到 sysLog 時自動變成什麼都不做）呼叫。

(function () {
  const KEY = 'kyotoMapSysLog';
  const MAX = 600;
  const MSG_LIMIT = 600;
  const SESSION = Math.random().toString(36).slice(2, 7);   // 區分每一次開網頁
  let entries = [];

  try {
    const raw = localStorage.getItem(KEY);
    if (raw) entries = JSON.parse(raw) || [];
    if (!Array.isArray(entries)) entries = [];
  } catch (e) { entries = []; }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(entries)); }
    catch (e) {
      // 空間不夠就砍掉一半舊記錄再試一次
      try { entries = entries.slice(-Math.floor(MAX / 2)); localStorage.setItem(KEY, JSON.stringify(entries)); }
      catch (e2) { /* 私密瀏覽等情況存不了，就只留在記憶體裡 */ }
    }
  }

  function fmt(v) {
    if (v instanceof Error) {
      const stack = (v.stack || '').split('\n').slice(1, 4).map(s => s.trim()).join(' | ');
      return `${v.name}: ${v.message}${v.code ? ' (code ' + v.code + ')' : ''}${stack ? ' ⟨' + stack + '⟩' : ''}`;
    }
    if (v && typeof v === 'object') {
      if (v.code || v.message) return `${v.name || 'Error'}: ${v.message || ''}${v.code ? ' (code ' + v.code + ')' : ''}`;
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  function sysLog(level, tag, msg) {
    try {
      const text = String(msg == null ? '' : msg).slice(0, MSG_LIMIT);
      const last = entries[entries.length - 1];
      if (last && last.s === SESSION && last.l === level && last.g === tag && last.m === text) {
        last.n = (last.n || 1) + 1;
        last.t2 = new Date().toISOString();
      } else {
        entries.push({ t: new Date().toISOString(), s: SESSION, l: level, g: tag || '', m: text });
        if (entries.length > MAX) entries = entries.slice(-MAX);
      }
      save();
    } catch (e) { /* 記錄失敗不影響網站 */ }
  }

  // ---- 自動攔截 ----
  ['warn', 'error'].forEach(level => {
    const orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function (...args) {
      try {
        let tag = 'console';
        let parts = args;
        // app.js 慣例：console.warn('[跳棋] 訊息', err) → 把 [跳棋] 拆成標籤
        if (typeof args[0] === 'string') {
          const m = args[0].match(/^\[([^\]]+)\]\s*/);
          if (m) { tag = m[1]; parts = [args[0].slice(m[0].length), ...args.slice(1)]; }
        }
        sysLog(level, tag, parts.map(fmt).join(' '));
      } catch (e) { /* ignore */ }
      orig(...args);
    };
  });

  window.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      // 資源載入失敗（例如 vendor/maplibre-gl.js 或 Firebase 模組抓不到）
      sysLog('error', 'resource', `載入失敗：<${(t.tagName || '').toLowerCase()}> ${t.src || t.href}`);
      return;
    }
    const where = e.filename ? ` @ ${e.filename.split('/').pop()}:${e.lineno}:${e.colno}` : '';
    sysLog('error', 'uncaught', `${e.message || fmt(e.error)}${where}${e.error && e.error.stack ? ' ⟨' + e.error.stack.split('\n').slice(1, 4).map(s => s.trim()).join(' | ') + '⟩' : ''}`);
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    sysLog('error', 'promise', fmt(e.reason));
  });

  window.addEventListener('online', () => sysLog('info', 'network', '恢復連線（online）'));
  window.addEventListener('offline', () => sysLog('warn', 'network', '失去連線（offline）'));
  document.addEventListener('visibilitychange', () => {
    sysLog('info', 'page', document.visibilityState === 'hidden' ? '切到背景' : '回到前景');
  });

  sysLog('info', 'page', `開啟網頁 ${location.pathname}${location.search}${location.hash} ｜ ` +
    `${window.innerWidth}x${window.innerHeight} ｜ online=${navigator.onLine} ｜ ` +
    `PWA=${window.matchMedia && window.matchMedia('(display-mode: standalone)').matches}`);

  // ---- 匯出 .log ----
  // 時間一律換成「這支手機的當地時間」，不讓看記錄的 AI 自己換算時區（小模型很容易算錯）
  const p2 = (n) => String(n).padStart(2, '0');
  function localTime(iso, short) {
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const hms = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    return short ? `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${hms}` : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hms}`;
  }
  function tzLabel() {
    const off = -new Date().getTimezoneOffset() / 60;
    const name = off === 9 ? '日本時間' : off === 8 ? '台灣時間' : '當地時間';
    return `${name}（UTC${off >= 0 ? '+' : ''}${off}）`;
  }

  // 自動比對已知的故障模式，讓看記錄的 AI 不用自己從幾百行裡找
  function diagnose(list) {
    const hints = [];
    const uniq = (arr) => [...new Set(arr)];
    const last = (arr) => arr[arr.length - 1];

    const tdz = list.filter(e => /before initialization/.test(e.m));
    if (tdz.length) hints.push(`❗ app.js 有 TDZ 錯誤：${tdz[0].m.slice(0, 120)}\n#     → renderMarkers() 很早就執行，它用到的 const/let 要搬到 app.js 最上面。這會讓地圖標記全部消失。`);

    const uncaught = list.filter(e => e.g === 'uncaught' && !/before initialization/.test(e.m));
    if (uncaught.length) hints.push(`❗ 程式錯誤 ${uncaught.length} 種：\n` + uniq(uncaught.map(e => e.m.split(' ⟨')[0].slice(0, 140))).slice(0, 5).map(m => `#     - ${m}`).join('\n'));

    const zero = list.filter(e => e.g === '地圖' && /標記已畫出 0 \//.test(e.m));
    if (zero.length) hints.push(`❗ 地圖標記畫出 0 個（${localTime(last(zero).t, true)}）→ 景點資料或 renderMarkers() 出錯`);

    const perm = list.filter(e => /permission-denied|insufficient permissions/i.test(e.m));
    if (perm.length) hints.push(`❗ Firestore 權限被擋 ${perm.length} 次（最後 ${localTime(last(perm).t, true)}）\n#     → 請使用者到 Firebase Console 確認安全規則已「發布」（規則全文在 README）。AI 改不了這個，要人去按。`);

    const res = list.filter(e => e.g === 'resource');
    if (res.length) {
      const urls = uniq(res.map(e => e.m.replace(/^載入失敗：<[^>]*>\s*/, '')));
      hints.push(`⚠️ 檔案載入失敗：${urls.slice(0, 4).join('、')}` +
        (urls.some(u => /vendor\//.test(u)) ? '\n#     → 地圖函式庫載不到，地圖會出不來（景點清單仍可用）' : '') +
        (urls.some(u => /gstatic\.com\/firebasejs/.test(u)) ? '\n#     → Firebase 載不到，跳棋同步與登入不能用（通常是沒網路）' : ''));
    }
    const fbFail = list.filter(e => e.g === '跳棋' && /dynamically imported module|無法初始化登入狀態|無法載入登入功能/.test(e.m));
    if (fbFail.length && !res.some(e => /firebasejs/.test(e.m))) hints.push(`⚠️ 跳棋／登入功能載不到 ${fbFail.length} 次（通常是當時沒網路，恢復連線後重新整理即可）`);

    const drop = list.filter(e => e.g === '跳棋' && /\d+→0/.test(e.m));
    if (drop.length) hints.push('⚠️ 家人選點變成 0：\n' + drop.slice(-5).map(e => `#     - ${localTime(e.t, true)} ${e.m.replace('家人選點變化：', '')}`).join('\n') +
      '\n#     → 對照同一時間前後的記錄：是那個人自己按了清除（要看他手機的記錄），還是其他異常寫入');

    const cleared = list.filter(e => e.g === 'select' && /清除選取/.test(e.m));
    if (cleared.length) hints.push(`ℹ️ 這支手機按過「清除選取」${cleared.length} 次（最後 ${localTime(last(cleared).t, true)}）→ 選點變 0 可能就是這個`);

    const replaced = list.filter(e => e.g === 'select' && /從分享連結載入清單/.test(e.m) && !/原本 0 個/.test(e.m));
    if (replaced.length) hints.push(`ℹ️ 用分享連結開網頁 ${replaced.length} 次，原本的選點被連結裡的清單取代（最後 ${localTime(last(replaced).t, true)}）`);

    const guide = list.filter(e => e.g === '導遊' && /代號/.test(e.m));
    if (guide.length) {
      const codes = {};
      guide.forEach(e => { const c = (e.m.match(/代號 (\S+)/) || [])[1] || '?'; codes[c] = (codes[c] || 0) + (e.n || 1); });
      hints.push(`⚠️ 線上導遊失敗：${Object.entries(codes).map(([c, n]) => `${c}×${n}`).join('、')}\n#     （E1 沒網路、E2 沒設定後端、E3 連不上後端、E4 等太久、E4xx/E5xx 後端回傳錯誤）`);
    }

    const offline = list.filter(e => e.g === 'network' && /offline/.test(e.m));
    if (offline.length) hints.push(`ℹ️ 斷線 ${offline.length} 次（最後 ${localTime(last(offline).t, true)}）`);

    const sw = list.filter(e => e.g === 'sw' && /新版/.test(e.m));
    if (sw.length) hints.push(`ℹ️ 新版網站在 ${localTime(last(sw).t, true)} 接管 → 如果問題是這之後才出現，先看最近一次更新改了什麼（VERSION.txt）`);

    return hints;
  }

  async function buildLogText(opts) {
    const short = !!(opts && opts.short);
    const lines = [];
    const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

    let siteVersion = '（讀不到）';
    try {
      const res = await fetch('VERSION.txt', { cache: 'no-store' });
      if (res.ok) siteVersion = (await res.text()).split('\n')[0].replace(/^版本：/, '').trim();
    } catch (e) { /* 離線時讀不到沒關係 */ }

    let cacheNames = '（讀不到）';
    try { if (window.caches) cacheNames = (await caches.keys()).join(', ') || '（沒有）'; } catch (e) { /* ignore */ }

    // app.js 的全域變數：用 typeof 判斷，app.js 若根本沒載入成功也不會出錯
    const g = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };
    const selected = g(() => (typeof selectedIds !== 'undefined' ? selectedIds.join(',') : '（app.js 未載入）'), '?');
    const loggedIn = g(() => (typeof memberIdentity !== 'undefined' ? (memberIdentity ? `是（顯示名稱：${memberIdentity.name}）` : '否') : '（app.js 未載入）'), '?');
    // 注意：頁面上有 id="map" 的 <div>，瀏覽器會自動產生同名的全域變數 map 指向它，
    // 所以不能只看 map 存不存在，要確認它真的是 MapLibre 地圖物件
    const mapOk = g(() => {
      if (typeof selectedIds === 'undefined') return '（app.js 未載入）';
      return (map && typeof map.flyTo === 'function') ? '有' : '沒有（初始化失敗）';
    }, '?');
    const spotCount = g(() => (typeof SPOTS !== 'undefined' ? SPOTS.length : '（data.js 未載入）'), '?');

    lines.push(`# 京都行程景點地圖 — 系統記錄${short ? '（精簡版）' : ' (.log)'}`);
    lines.push('#');
    if (!short) {
      lines.push('# 【給接手的 AI】讀得到 GitHub 的話，先讀 repo puBILYYEN/kyoto-map 的 HANDOFF.md');
      lines.push('#   （9B 等小模型讀 HANDOFF-9B.md）。上下文不夠的話，只讀到「完整時間軸」之前的「診斷摘要」就好。');
      lines.push('# 讀不到 GitHub 的話（例如在手機上離線使用），至少先知道這幾件事：');
      lines.push('#   - 純靜態網頁：logger.js → maplibre → data.js（景點資料）→ app.js（所有功能），沒有 build');
      lines.push('#   - 「Cannot access X before initialization」＝ app.js 的 TDZ，地圖標記 0 個通常就是這個');
      lines.push('#   - 「permission-denied」＝ Firestore 安全規則擋住，規則要使用者自己到 Firebase Console 發布');
      lines.push('#   - 回答使用者一律用繁體中文、台灣用語');
      lines.push('#');
      lines.push('# 格式：時間 ｜ 工作階段 ｜ 等級 ｜ 標籤 ｜ 訊息');
      lines.push('#   工作階段 = 每次開網頁隨機產生的代號，代號換了就代表重新整理或重開了網頁');
      lines.push('#   等級 = info 一般事件 / warn 有問題但網站還能用 / error 程式出錯');
      lines.push('#   ×N = 同一則訊息連續出現 N 次（只記一筆）');
      lines.push('#   標籤（原文照印）：page=開關網頁  ui=使用者操作  select=自己的選點變化  地圖=地圖');
      lines.push('#            跳棋=家人同步與登入  導遊=線上導遊  sw=離線快取  network=連線  console=其他警告');
      lines.push('#            uncaught=未捕捉的程式錯誤  promise=未處理的非同步錯誤  resource=檔案載入失敗');
      lines.push('#');
    }
    lines.push(`# 時間：全部是這支手機的${tzLabel()}，不用再換算`);
    lines.push(`# 匯出：${localTime(new Date().toISOString())}  網站版本：${siteVersion}  離線快取：${cacheNames}`);
    lines.push(`# 景點總數：${spotCount}  地圖：${mapOk}  跳棋已登入：${loggedIn}  online=${navigator.onLine}`);
    lines.push(`# 目前已選景點：${selected || '（無）'}`);
    if (!short) {
      lines.push(`# 網址：${location.href}`);
      lines.push(`# 裝置：${navigator.userAgent}  螢幕：${window.innerWidth}x${window.innerHeight}`);
    }

    const errCount = entries.filter(e => e.l === 'error').length;
    const warnCount = entries.filter(e => e.l === 'warn').length;
    const sessions = new Set(entries.map(e => e.s)).size;
    lines.push('#');
    lines.push('# ===== 診斷摘要 =====');
    lines.push(`# 共 ${entries.length} 筆記錄（開過 ${sessions} 次網頁），錯誤 ${errCount} 筆、警告 ${warnCount} 筆`);
    const hints = diagnose(entries);
    lines.push('# 自動判斷：');
    if (hints.length) hints.forEach(h => lines.push('#   ' + h));
    else lines.push('#   ✅ 沒有發現已知的故障模式，請看下面最近的錯誤與警告');
    const problems = entries.filter(e => e.l !== 'info');
    if (problems.length) {
      lines.push('# 最近的錯誤與警告（最多 10 則，新的在下面）：');
      problems.slice(-10).forEach(e => lines.push(`#   ${localTime(e.t, true)} ｜ ${e.l} ｜ ${e.g} ｜ ${e.m.split(' ⟨')[0].slice(0, 160)}${e.n > 1 ? ' ×' + e.n : ''}`));
    }
    lines.push('');

    const timeline = short ? entries.slice(-40) : entries;
    lines.push(short ? '# ===== 最近 40 筆時間軸 =====' : '# ===== 完整時間軸 =====');
    timeline.forEach(e => {
      const count = e.n > 1 ? `  ×${e.n}（最後一次 ${localTime(e.t2, true)}）` : '';
      const msg = short ? e.m.split(' ⟨')[0].slice(0, 200) : e.m;
      lines.push(`${localTime(e.t, short)} ｜ ${e.s} ｜ ${pad(e.l, 5)} ｜ ${e.g} ｜ ${msg}${count}`);
    });
    return lines.join('\n') + '\n';
  }

  async function exportLog() {
    sysLog('info', 'ui', '匯出系統記錄');
    const text = await buildLogText();
    const d = new Date();
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    const filename = `kyoto-map-${stamp}.log`;

    // 手機優先用系統分享（可以直接傳 LINE、存到檔案），不行再用下載，最後才用複製
    try {
      const file = new File([text], filename, { type: 'text/plain' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return 'downloaded';
    } catch (e) { /* 改用複製 */ }
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch (e) {
      return 'failed';
    }
  }

  // 精簡版：診斷摘要＋最近 40 筆，直接複製，方便貼進手機上的 AI（上下文小）
  async function copyShortLog() {
    sysLog('info', 'ui', '複製精簡記錄');
    const text = await buildLogText({ short: true });
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch (e) {
      try {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'kyoto-map-精簡記錄.txt';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return 'downloaded';
      } catch (e2) {
        return 'failed';
      }
    }
  }

  function clearLog() {
    entries = [];
    save();
    sysLog('info', 'ui', '清除系統記錄');
  }

  window.sysLog = sysLog;
  window.sysLogExport = exportLog;
  window.sysLogBuildText = buildLogText;
  window.sysLogCopyShort = copyShortLog;
  window.sysLogClear = clearLog;

  // 按鈕由這支檔案自己綁定，不靠 app.js——就算 app.js 整個當掉，
  // 家人還是按得到，把當掉的原因交給 AI。
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('sysLogBtn');
    if (btn) btn.addEventListener('click', async () => {
      const result = await exportLog();
      if (result === 'copied') alert('這台裝置不能直接下載檔案，已經把記錄內容複製到剪貼簿，直接貼給 AI 就可以了。');
      else if (result === 'failed') alert('匯出失敗：這台裝置不能下載也不能複製。可以改用電腦開網站再試一次。');
    });
    const shortBtn = document.getElementById('sysLogShortBtn');
    if (shortBtn) shortBtn.addEventListener('click', async () => {
      const result = await copyShortLog();
      if (result === 'copied') alert('精簡記錄已複製，直接貼到手機上的 AI（例如 Ornith 9B）對話框就可以了。');
      else if (result === 'downloaded') alert('這台裝置不能直接複製，已改成下載「kyoto-map-精簡記錄.txt」。');
      else alert('複製失敗，請改按上面的「下載系統記錄」。');
    });
  });
})();
