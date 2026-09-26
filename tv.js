// ===== 京都行程景點地圖 — 電視版 tv.js =====
// 給電視盒（Android TV，例如小米盒子 S）用：三欄「選單 → 清單 → 介紹」，
// 只靠遙控器的上下左右、OK、返回就能操作。只能看、不能改：
//   - 景點資料跟電腦版共用 data.js
//   - 家人的行程直接讀雲端（Firestore 的 members 開放讀取，不用登入；電視上本來也沒辦法用 Google 登入）
//   - 地圖要選「在地圖上看這條路線」才載入，而且只畫那條路線的點（盒子的顯示晶片很舊，全部畫會很卡）

function tvLog(level, msg) {
  if (typeof window.sysLog === 'function') window.sysLog(level, 'tv', msg);
}

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const MAPLIBRE_JS = 'vendor/maplibre-gl.js';
const MAPLIBRE_CSS = 'vendor/maplibre-gl.css';

const state = {
  col: 0,            // 0 選單、1 清單、2 介紹
  nav: 0,
  item: 0,
  navItems: [],
  listItems: [],
  members: {},       // uid -> { name, color, spotIds }
  mapOpen: false,
  mapUid: null,      // 地圖正在顯示（跟著）誰的行程
};
const FOLLOW_KEY = 'kyotoTvFollow';   // 記住上次跟的是誰，下次開電視版直接顯示
let autoFollowTried = false;

const el = (id) => document.getElementById(id);
const spotById = (id) => SPOTS.find(s => s.id === id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 選單 ----------
function buildNav() {
  const items = [];
  Object.entries(state.members)
    .filter(([, m]) => Array.isArray(m.spotIds) && m.spotIds.length)
    .sort((a, b) => String(a[1].name).localeCompare(String(b[1].name), 'zh-Hant'))
    .forEach(([uid, m]) => items.push({ type: 'member', uid, label: `${m.name || '家人'} 的行程`, color: m.color, count: m.spotIds.length }));
  if (!items.length) items.push({ type: 'noMembers', label: '家人行程（讀取中）' });
  items.push({ type: 'shared', label: '大家都有選的景點' });
  items.push({ type: 'cat', cat: 'all', label: '全部景點', count: SPOTS.length });
  Object.entries(CATEGORY_META).forEach(([cat, meta]) => {
    const count = SPOTS.filter(s => s.categories.includes(cat)).length;
    if (count) items.push({ type: 'cat', cat, label: meta.label, color: meta.color, count });
  });
  items.push({ type: 'prep', label: '🛂 行前準備' });
  items.push({ type: 'log', label: '🪵 系統記錄（出問題時拍照給 AI）' });
  return items;
}

// ---------- 清單 ----------
function buildList(navItem) {
  if (!navItem) return [];
  if (navItem.type === 'member') {
    const m = state.members[navItem.uid];
    const ids = (m && m.spotIds || []).filter(spotById);
    return [{ type: 'map', label: '🗺 在地圖上看（手機改了會自動更新）', uid: navItem.uid }]
      .concat(ids.map((id, i) => ({ type: 'spot', id, num: i + 1 })));
  }
  if (navItem.type === 'shared') {
    const who = sharedSpots();
    return Object.keys(who).filter(id => who[id].length >= 2).map(id => ({ type: 'spot', id }));
  }
  if (navItem.type === 'cat') {
    return SPOTS.filter(s => navItem.cat === 'all' || s.categories.includes(navItem.cat)).map(s => ({ type: 'spot', id: s.id }));
  }
  if (navItem.type === 'prep') return TRIP_PREP.groups.map((g, i) => ({ type: 'prep', idx: i, label: g.heading }));
  if (navItem.type === 'log') return [{ type: 'log', label: '顯示精簡記錄' }];
  if (navItem.type === 'noMembers') return [];
  return [];
}

function sharedSpots() {
  const who = {};
  Object.values(state.members).forEach(m => (m.spotIds || []).forEach(id => {
    if (!spotById(id)) return;
    (who[id] = who[id] || []).push(m);
  }));
  return who;
}

// ---------- 畫面 ----------
function renderNav() {
  const box = el('tvNav');
  box.innerHTML = state.navItems.map((it, i) => `
    <div class="tv-item${i === state.nav ? ' tv-current' : ''}" data-col="0" data-idx="${i}">
      ${it.color ? `<span class="tv-dot" style="background:${esc(it.color)}"></span>` : ''}
      <span>${esc(it.label)}</span>
      ${it.count ? `<span class="tv-sub">${it.count}</span>` : ''}
    </div>`).join('');
}

function renderList() {
  const box = el('tvList');
  const navItem = state.navItems[state.nav];
  if (!state.listItems.length) {
    const msg = navItem && navItem.type === 'noMembers'
      ? '正在讀取家人的行程…<br>如果一直沒有出現，可能是沒有網路，或家人都還沒選景點。'
      : navItem && navItem.type === 'shared' ? '目前沒有兩個人以上都選的景點。' : '沒有資料';
    box.innerHTML = `<div class="tv-empty">${msg}</div>`;
    return;
  }
  box.innerHTML = state.listItems.map((it, i) => {
    let inner;
    if (it.type === 'spot') {
      const s = spotById(it.id);
      const color = CATEGORY_META[s.categories[0]].color;
      inner = it.num
        ? `<span class="tv-num" style="background:${esc(color)}">${it.num}</span><span>${esc(s.name)}</span>`
        : `<span class="tv-dot" style="background:${esc(color)}"></span><span>${esc(s.name)}</span><span class="tv-sub">${esc(s.area)}</span>`;
    } else {
      inner = `<span>${esc(it.label)}</span>`;
    }
    return `<div class="tv-item${state.col === 1 && i === state.item ? ' tv-focus' : ''}" data-col="1" data-idx="${i}">${inner}</div>`;
  }).join('');
}

function renderDetail() {
  const box = el('tvDetail');
  const it = state.listItems[state.item];
  const navItem = state.navItems[state.nav];
  if (!it) {
    box.innerHTML = navItem && navItem.type === 'member'
      ? '' : '<div class="tv-empty">用 ← → 換欄、↑↓ 選擇，這裡會顯示介紹。</div>';
    return;
  }
  if (it.type === 'spot') return renderSpot(box, spotById(it.id));
  if (it.type === 'map') {
    const m = state.members[it.uid];
    box.innerHTML = `<h2>🗺 ${esc(m ? m.name : '')}的路線</h2>
      <p>按 OK 在地圖上看這 ${m ? m.spotIds.length : 0} 個景點的先後順序。</p>
      <p>打開之後，${esc(m ? m.name : '')}在手機上勾選、取消或調整順序，電視會自動跟著更新，不用再按遙控器；下次打開電視版也會直接顯示這張地圖。</p>
      <p class="tv-area">第一次開地圖要等幾秒。這台盒子如果太舊顯示不了地圖，會直接告訴你，不影響其他功能。</p>`;
    return;
  }
  if (it.type === 'prep') {
    const g = TRIP_PREP.groups[it.idx];
    box.innerHTML = `<h2>${esc(g.heading)}</h2><ul>${g.items.map(x => `<li>${x}</li>`).join('')}</ul>`;
    return;
  }
  if (it.type === 'log') {
    box.innerHTML = '<div class="tv-empty">產生中…</div>';
    const build = window.sysLogBuildText;
    if (typeof build !== 'function') { box.innerHTML = '<div class="tv-empty">記錄功能沒有載入。</div>'; return; }
    build({ short: true }).then(text => {
      box.innerHTML = `<h2>系統記錄（精簡版）</h2><p class="tv-area">用手機把這個畫面拍下來傳給 AI（按 → 再按 ↑↓ 可以捲動）</p><pre>${esc(text)}</pre>`;
    });
  }
}

function renderSpot(box, s) {
  const badges = s.categories.map(c => `<span style="background:${esc(CATEGORY_META[c].color)}">${esc(CATEGORY_META[c].label)}</span>`).join('');
  const booking = s.booking
    ? `<div class="tv-box tv-box-booking">⚠️ ${esc(BOOKING_META[s.booking.level].label)}：${esc(s.booking.note)}</div>` : '';
  const hours = s.hours ? `<div class="tv-box">🕘 ${esc(s.hours)}</div>` : '';
  const who = Object.values(state.members).filter(m => (m.spotIds || []).includes(s.id));
  const whoHtml = who.length
    ? `<div class="tv-who">選了這裡的家人：${who.map(m => `<b style="background:${esc(m.color || '#555')}">${esc(m.name)} 第 ${m.spotIds.indexOf(s.id) + 1} 站</b>`).join('')}</div>` : '';
  box.innerHTML = `
    <div class="tv-badges">${badges}</div>
    <h2>${esc(s.name)}</h2>
    <div class="tv-area">${esc(s.area)}${s.address ? '・' + esc(s.address) : ''}</div>
    ${hours}${booking}
    <p>${esc(s.desc)}</p>
    ${whoHtml}`;
}

function renderAll() {
  renderNav();
  renderList();
  renderDetail();
  ['tvNav', 'tvList', 'tvDetail'].forEach((id, i) => el(id).classList.toggle('tv-active', state.col === i));
  // 選單欄目前選到的也要框起來（在選單欄時）
  const navEls = el('tvNav').querySelectorAll('.tv-item');
  navEls.forEach((n, i) => n.classList.toggle('tv-focus', state.col === 0 && i === state.nav));
  const focused = state.col === 0 ? navEls[state.nav] : state.col === 1 ? el('tvList').querySelectorAll('.tv-item')[state.item] : null;
  if (focused) focused.scrollIntoView({ block: 'nearest' });
}

function selectNav(i) {
  state.nav = Math.max(0, Math.min(state.navItems.length - 1, i));
  state.listItems = buildList(state.navItems[state.nav]);
  state.item = 0;
  el('tvList').scrollTop = 0;
  el('tvDetail').scrollTop = 0;
}

// ---------- 遙控器 ----------
function onKey(e) {
  const key = e.key;
  if (state.mapOpen) return onMapKey(e);
  const move = { ArrowUp: -1, ArrowDown: 1 }[key];
  if (move) {
    e.preventDefault();
    if (state.col === 0) selectNav(state.nav + move);
    else if (state.col === 1 && state.listItems.length) {
      state.item = Math.max(0, Math.min(state.listItems.length - 1, state.item + move));
      el('tvDetail').scrollTop = 0;
    } else if (state.col === 2) el('tvDetail').scrollBy({ top: move * el('tvDetail').clientHeight * 0.6 });
    renderAll();
    return;
  }
  if (key === 'ArrowRight') {
    e.preventDefault();
    if (state.col === 0 && state.listItems.length) state.col = 1;
    else if (state.col === 1) state.col = 2;
    renderAll();
    return;
  }
  if (key === 'ArrowLeft' || isBackKey(key)) {
    if (state.col > 0) {
      e.preventDefault();
      state.col -= 1;
      renderAll();
    }
    return;
  }
  if (key === 'Enter' || key === ' ') {
    e.preventDefault();
    if (state.col === 0 && state.listItems.length) { state.col = 1; renderAll(); return; }
    const it = state.listItems[state.item];
    if (state.col === 1 && it && it.type === 'map') openMap(it.uid);
    else if (state.col === 1) { state.col = 2; renderAll(); }
  }
}

function isBackKey(key) {
  return key === 'Escape' || key === 'Backspace' || key === 'GoBack' || key === 'BrowserBack';
}

// 用 TV Bro 的游標直接點也要能用
function onClick(e) {
  const item = e.target.closest('.tv-item');
  if (!item) return;
  const col = Number(item.dataset.col);
  const idx = Number(item.dataset.idx);
  if (col === 0) { selectNav(idx); state.col = 0; }
  else {
    state.col = 1;
    state.item = idx;
    const it = state.listItems[idx];
    if (it && it.type === 'map') openMap(it.uid);
  }
  renderAll();
}

// ---------- 地圖（只有要看時才載入） ----------
let mapLib = null;
let map = null;
let mapMarkers = [];
let overviewBounds = null;

function loadMapLibrary() {
  if (mapLib) return mapLib;
  mapLib = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = MAPLIBRE_CSS;
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = MAPLIBRE_JS;
    js.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error('地圖函式庫沒有載入')));
    js.onerror = () => reject(new Error('地圖函式庫下載失敗'));
    document.head.appendChild(js);
  });
  mapLib.catch(() => { mapLib = null; });
  return mapLib;
}

function showMapMsg(text) {
  const msg = el('tvMapMsg');
  msg.textContent = text;
  msg.hidden = !text;
}

async function openMap(uid) {
  const m = state.members[uid];
  if (!m || !(m.spotIds || []).some(spotById)) return;
  state.mapOpen = true;
  state.mapUid = uid;
  try { localStorage.setItem(FOLLOW_KEY, uid); } catch (e) { /* 存不了就只是下次不會自動打開 */ }
  el('tvMapOverlay').hidden = false;
  showMapMsg('地圖載入中…');
  history.pushState({ tvMap: true }, '');
  tvLog('info', `開啟地圖（跟著 ${m.name} 的手機）`);

  try {
    const lib = await loadMapLibrary();
    if (!map) {
      map = new lib.Map({ container: 'tvMap', style: 'https://tiles.openfreemap.org/styles/liberty', center: [135.76, 35.01], zoom: 11 });
      map.on('error', (e) => tvLog('warn', '地圖圖磚載入問題：' + ((e && e.error && e.error.message) || '')));
    }
  } catch (err) {
    tvLog('warn', '地圖無法顯示：' + err.message);
    showMapMsg('這台裝置顯示不了地圖（可能是顯示晶片太舊或網路不穩）。\n右邊的清單一樣會跟著手機更新；按返回鍵回到選單。');
    drawRouteList(uid, []);
    return;
  }
  if (!state.mapOpen) return;
  showMapMsg('');
  drawRoute(uid, []);
}

// 右邊的編號清單；剛新增的景點用黃色標出來，一眼看得出手機剛剛改了什麼
function drawRouteList(uid, prevIds) {
  const m = state.members[uid];
  const spots = (m && m.spotIds || []).map(spotById).filter(Boolean);
  el('tvMapTitle').textContent = `${m ? m.name : ''}的路線（${spots.length} 個景點）`;
  el('tvMapList').innerHTML = spots.map(s =>
    `<li class="${prevIds.length && !prevIds.includes(s.id) ? 'tv-new' : ''}">${esc(s.name)}</li>`).join('');
  return spots;
}

function drawRoute(uid, prevIds) {
  const spots = drawRouteList(uid, prevIds);
  if (!map || !window.maplibregl) return;
  const lib = window.maplibregl;
  const m = state.members[uid];
  mapMarkers.forEach(mk => mk.remove());
  mapMarkers = spots.map((s, i) => {
    const pin = document.createElement('div');
    pin.className = 'tv-pin';
    pin.style.background = m.color || '#b5482b';
    pin.textContent = String(i + 1);
    return new lib.Marker({ element: pin }).setLngLat([s.lng, s.lat]).addTo(map);
  });
  if (!spots.length) return;
  const coords = spots.map(s => [s.lng, s.lat]);
  const drawLine = () => {
    const data = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
    if (map.getSource('tvRoute')) map.getSource('tvRoute').setData(data);
    else {
      map.addSource('tvRoute', { type: 'geojson', data });
      map.addLayer({ id: 'tvRoute', type: 'line', source: 'tvRoute', paint: { 'line-color': m.color || '#b5482b', 'line-width': 4, 'line-dasharray': [2, 1] } });
    }
    if (map.getLayer('tvRoute')) map.setPaintProperty('tvRoute', 'line-color', m.color || '#b5482b');
  };
  if (map.isStyleLoaded()) drawLine(); else map.once('load', drawLine);

  overviewBounds = coords.reduce((b, c) => b.extend(c), new lib.LngLatBounds(coords[0], coords[0]));
  map.resize();
  map.fitBounds(overviewBounds, { padding: 60, duration: prevIds.length ? 600 : 0, maxZoom: 15 });
}

function closeMap(fromPopstate) {
  if (!state.mapOpen) return;
  state.mapOpen = false;
  state.mapUid = null;
  // 自己按返回關掉的，下次開電視版就不要再自動打開
  try { localStorage.removeItem(FOLLOW_KEY); } catch (e) { /* ignore */ }
  el('tvMapOverlay').hidden = true;
  if (!fromPopstate && history.state && history.state.tvMap) history.back();
}

function onMapKey(e) {
  const key = e.key;
  if (isBackKey(key)) { e.preventDefault(); closeMap(false); return; }
  if (!map) return;
  const step = 120;
  const pan = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[key];
  if (pan) { e.preventDefault(); map.panBy(pan, { duration: 200 }); return; }
  if (key === 'Enter' || key === ' ') {
    e.preventDefault();
    if (map.getZoom() >= 15.5 && overviewBounds) map.fitBounds(overviewBounds, { padding: 60, duration: 400, maxZoom: 15 });
    else map.easeTo({ zoom: map.getZoom() + 1, duration: 300 });
  }
}

// 電視盒的返回鍵常常被瀏覽器當成「上一頁」：開地圖時先壓一筆紀錄，返回時關地圖而不是離開網站
window.addEventListener('popstate', () => { if (state.mapOpen) closeMap(true); });

// ---------- 家人行程（雲端，只讀） ----------
async function listenMembers() {
  if (!SHARE_CONFIG || !SHARE_CONFIG.firebaseConfig) return;
  try {
    const appMod = await import(`${FIREBASE_SDK}/firebase-app.js`);
    const fs = await import(`${FIREBASE_SDK}/firebase-firestore.js`);
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(SHARE_CONFIG.firebaseConfig);
    const db = fs.getFirestore(app);
    fs.onSnapshot(fs.collection(db, 'trips', SHARE_CONFIG.tripId, 'members'), (snap) => {
      const next = {};
      snap.forEach(d => { next[d.id] = d.data(); });
      const followed = state.mapUid;
      const prevIds = followed && state.members[followed] ? (state.members[followed].spotIds || []).slice() : [];
      state.members = next;
      // 正在跟著某人的手機：他的選點或順序有變，地圖和清單馬上跟著更新
      if (state.mapOpen && followed && next[followed]) {
        const nowIds = next[followed].spotIds || [];
        if (nowIds.join(',') !== prevIds.join(',')) {
          tvLog('info', `跟著 ${next[followed].name} 的手機更新：${prevIds.length}→${nowIds.length} 個`);
          drawRoute(followed, prevIds);
        }
      }
      // 上次跟著誰，這次開電視版直接打開他的地圖
      if (!autoFollowTried) {
        autoFollowTried = true;
        let saved = null;
        try { saved = localStorage.getItem(FOLLOW_KEY); } catch (e) { /* ignore */ }
        if (saved && next[saved] && !state.mapOpen) setTimeout(() => openMap(saved), 0);
      }
      const counts = Object.values(next).map(m => `${m.name}(${(m.spotIds || []).length})`).join('、');
      tvLog('info', `家人行程更新：${counts || '沒有資料'}`);
      el('tvStatus').textContent = `家人行程已同步 ${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`;
      refreshNavKeepingPlace();
    }, (err) => {
      tvLog('warn', '家人行程同步中斷：' + (err && err.message));
      el('tvStatus').textContent = '家人行程暫時連不上（其他資料照常可看）';
    });
  } catch (err) {
    tvLog('warn', '無法讀取家人行程：' + err.message);
    el('tvStatus').textContent = '沒有網路，家人行程暫時看不到';
  }
}

// 家人資料更新時重建選單，但盡量停在原本選的地方，不要把正在看的人跳走
function refreshNavKeepingPlace() {
  const prev = state.navItems[state.nav];
  const prevItem = state.listItems[state.item];
  state.navItems = buildNav();
  let idx = prev ? state.navItems.findIndex(n => n.type === prev.type && n.uid === prev.uid && n.cat === prev.cat) : 0;
  if (idx < 0) idx = 0;
  state.nav = idx;
  state.listItems = buildList(state.navItems[idx]);
  if (prevItem && prevItem.type === 'spot') {
    const j = state.listItems.findIndex(x => x.type === 'spot' && x.id === prevItem.id);
    state.item = j >= 0 ? j : Math.min(state.item, Math.max(0, state.listItems.length - 1));
  } else {
    state.item = Math.min(state.item, Math.max(0, state.listItems.length - 1));
  }
  if (!state.listItems.length && state.col > 0) state.col = 0;
  renderAll();
}

// ---------- 開始 ----------
document.addEventListener('keydown', onKey);
document.addEventListener('click', onClick);
state.navItems = buildNav();
selectNav(0);
renderAll();
tvLog('info', `電視版開啟 ${window.innerWidth}x${window.innerHeight}`);
listenMembers();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
