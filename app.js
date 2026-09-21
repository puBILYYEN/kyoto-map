// ===== 京都行程景點地圖 app.js =====

let activeCategory = 'all';
let searchTerm = '';
let bookingOnly = false;  // 只顯示需要預約或事前申請的景點
let selectedIds = [];     // 依點選順序排列，用於產生路線
let activeSpotId = null;  // 目前顯示在下方詳細介紹的景點
const markers = {};       // id -> maplibregl.Marker
let mapLoaded = false;    // 地圖圖層載入完成後才能畫連線
let pendingFit = false;   // 地圖在手機版被隱藏時無法計算範圍，先記下來等顯示時再做

// ---------- 地圖初始化 ----------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty', // 免費、不需API金鑰的地圖圖磚
  center: [135.7600, 35.0100],
  zoom: 11.2,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

map.on('load', () => {
  // 勾選景點之間的虛線連線（依勾選順序串起來）
  map.addSource('routeLine', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'routeLine',
    type: 'line',
    source: 'routeLine',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#2b2620',
      'line-width': 2.5,
      'line-opacity': 0.7,
      'line-dasharray': [2, 1.6],
    },
  });
  mapLoaded = true;

  renderMarkers();
  fitToVisibleSpots();
  updateRouteLine();
});

// ---------- 工具 ----------
function getVisibleSpots() {
  return SPOTS.filter(s => {
    const catOk = activeCategory === 'all' || s.categories.includes(activeCategory);
    const term = searchTerm.trim().toLowerCase();
    const searchOk = !term ||
      s.name.toLowerCase().includes(term) ||
      s.area.toLowerCase().includes(term);
    const bookingOk = !bookingOnly || !!s.booking;
    return catOk && searchOk && bookingOk;
  });
}

// 兩點之間的直線距離（公里），用 haversine 公式計算
function distanceKm(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(km) {
  return km < 1 ? `${Math.round(km * 1000)} 公尺` : `${km.toFixed(1)} 公里`;
}

// 依目前勾選順序，在地圖上畫出連線
function updateRouteLine() {
  if (!mapLoaded) return;
  const coords = selectedIds
    .map(id => SPOTS.find(s => s.id === id))
    .filter(Boolean)
    .map(s => [s.lng, s.lat]);
  map.getSource('routeLine').setData({
    type: 'FeatureCollection',
    features: coords.length >= 2
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }]
      : [],
  });
}

// 手機版一次只顯示一個畫面，地圖被隱藏時容器寬高是 0，不能做範圍／飛行計算
function mapIsVisible() {
  const c = map.getContainer();
  return c.offsetWidth > 0 && c.offsetHeight > 0;
}

function fitToVisibleSpots() {
  if (!mapIsVisible()) { pendingFit = true; return; }
  pendingFit = false;
  const visible = getVisibleSpots();
  if (!visible.length) return;
  const bounds = new maplibregl.LngLatBounds();
  visible.forEach(s => bounds.extend([s.lng, s.lat]));
  map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 500 });
}

// ---------- 標記(marker) ----------
function renderMarkers() {
  // 清除既有 marker
  Object.values(markers).forEach(m => m.remove());
  for (const k in markers) delete markers[k];

  SPOTS.forEach(spot => {
    const el = document.createElement('div');
    el.style.width = '16px';
    el.style.height = '16px';
    el.style.borderRadius = '50%';
    el.style.border = '2px solid #fff';
    el.style.boxShadow = '0 0 3px rgba(0,0,0,0.4)';
    el.style.background = CATEGORY_META[spot.categories[0]].color;
    el.style.cursor = 'pointer';
    // 被勾選時要在圓點中央顯示順序數字，所以用 flex 置中
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.color = '#fff';
    el.style.fontWeight = '700';
    el.style.lineHeight = '1';

    el.addEventListener('click', () => {
      showDetail(spot.id);
    });

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([spot.lng, spot.lat])
      .addTo(map);

    markers[spot.id] = marker;
  });
  updateMarkerVisibility();
}

function updateMarkerVisibility() {
  const visibleIds = new Set(getVisibleSpots().map(s => s.id));
  SPOTS.forEach(spot => {
    const marker = markers[spot.id];
    if (!marker) return;
    const el = marker.getElement();
    el.style.display = visibleIds.has(spot.id) ? 'flex' : 'none';

    const order = selectedIds.indexOf(spot.id);   // -1 代表沒被勾選
    el.style.outline = order >= 0 ? '3px solid #222' : 'none';

    // 勾選的點放大並標上順序，目前查看中的點也稍微放大
    const size = order >= 0 ? 24 : (spot.id === activeSpotId ? 22 : 16);
    el.style.width = size + 'px';
    el.style.height = size + 'px';

    el.textContent = order >= 0 ? String(order + 1) : '';
    el.style.fontSize = order >= 9 ? '9px' : '11px';
  });
}

// ---------- Tabs ----------
const TABS = [
  { cat: 'all', label: '全部' },
  { cat: 'stay', label: CATEGORY_META.stay.label },
  { cat: 'temple', label: CATEGORY_META.temple.label },
  { cat: 'shopping', label: CATEGORY_META.shopping.label },
  { cat: 'scenic', label: CATEGORY_META.scenic.label },
  { cat: 'shojin', label: CATEGORY_META.shojin.label },
  { cat: 'onmyoji', label: CATEGORY_META.onmyoji.label },
  { cat: 'nobunaga', label: CATEGORY_META.nobunaga.label },
  { cat: 'ujimatcha', label: CATEGORY_META.ujimatcha.label },
];

function renderTabs() {
  const wrap = document.getElementById('tabs');
  wrap.innerHTML = '';
  TABS.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeCategory === t.cat ? ' active' : '');
    btn.dataset.cat = t.cat;
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      activeCategory = t.cat;
      renderTabs();
      renderList();
      updateMarkerVisibility();
      fitToVisibleSpots();
    });
    wrap.appendChild(btn);
  });
}

// ---------- 景點清單 ----------
function renderList() {
  const listEl = document.getElementById('spotList');
  listEl.innerHTML = '';
  const visible = getVisibleSpots();

  if (!visible.length) {
    listEl.innerHTML = '<div style="padding:16px;color:#999;font-size:13px;">找不到符合的景點</div>';
    return;
  }

  visible.forEach(spot => {
    const item = document.createElement('div');
    item.className = 'spot-item' + (spot.id === activeSpotId ? ' active' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.includes(spot.id);
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelect(spot.id);
    });

    const dot = document.createElement('span');
    dot.className = 'spot-dot';
    dot.style.background = CATEGORY_META[spot.categories[0]].color;

    const info = document.createElement('div');
    info.className = 'spot-info';
    const tag = spot.booking
      ? `<span class="booking-tag" style="background:${BOOKING_META[spot.booking.level].color}">${BOOKING_META[spot.booking.level].label}</span>`
      : '';
    info.innerHTML =
      `<div class="spot-name">${spot.name}${tag}</div><div class="spot-area">${spot.area}</div>`;

    item.appendChild(checkbox);
    item.appendChild(dot);
    item.appendChild(info);

    item.addEventListener('click', () => showDetail(spot.id));

    listEl.appendChild(item);
  });
}

// ---------- 詳細介紹 ----------
function showDetail(spotId) {
  activeSpotId = spotId;
  const spot = SPOTS.find(s => s.id === spotId);
  const panel = document.getElementById('detailBody');
  if (!spot) {
    panel.innerHTML = '<div class="detail-placeholder">點選左側清單或地圖上的標記，查看景點詳細介紹</div>';
    return;
  }
  const badges = spot.categories
    .map(c => `<span class="badge" style="background:${CATEGORY_META[c].color}">${CATEGORY_META[c].label}</span>`)
    .join(' ');
  panel.innerHTML = `
    <div class="detail-header">
      ${badges}
      <h2>${spot.name}</h2>
    </div>
    <div class="detail-area">${spot.area}</div>
    <div class="detail-desc">${spot.desc}</div>
    ${buildBookingBox(spot)}
    <a class="detail-link" href="${buildPlaceUrl(spot)}" target="_blank" rel="noopener noreferrer">📍 在 Google 地圖上看（照片・評價・營業時間）</a>
  `;
  if (mapIsVisible()) {
    map.flyTo({ center: [spot.lng, spot.lat], zoom: 14.5, duration: 600 });
  }
  if (mobileQuery.matches) openDetailSheet();
  renderList();
  updateMarkerVisibility();
}

// ---------- 多選與路線 ----------
function toggleSelect(spotId) {
  const idx = selectedIds.indexOf(spotId);
  if (idx >= 0) {
    selectedIds.splice(idx, 1);
  } else {
    selectedIds.push(spotId);
  }
  renderList();
  renderSelection();
  updateMarkerVisibility();
}

function renderSelection() {
  document.getElementById('selCount').textContent = `(${selectedIds.length})`;
  const navSelBtn = document.querySelector('.mobile-nav button[data-mview="sel"]');
  if (navSelBtn) navSelBtn.textContent = `✅ 已選 (${selectedIds.length})`;
  const ol = document.getElementById('selectedList');
  ol.innerHTML = '';
  selectedIds.forEach((id, i) => {
    const spot = SPOTS.find(s => s.id === id);
    if (!spot) return;
    const li = document.createElement('li');

    const numEl = document.createElement('span');
    numEl.className = 'sel-num';
    numEl.textContent = String(i + 1);

    const nameEl = document.createElement('span');
    nameEl.className = 'sel-name';
    nameEl.innerHTML =
      `<span class="sel-spot-name">${spot.name}</span><span class="sel-spot-area">${spot.area}</span>`;
    nameEl.addEventListener('click', () => showDetail(spot.id));

    const actions = document.createElement('span');
    actions.className = 'sel-actions';
    actions.appendChild(makeSelBtn('▲', '往前移一位', i === 0, () => moveSelected(i, -1)));
    actions.appendChild(makeSelBtn('▼', '往後移一位', i === selectedIds.length - 1, () => moveSelected(i, 1)));
    actions.appendChild(makeSelBtn('✕', '從清單移除', false, () => toggleSelect(spot.id)));

    li.appendChild(numEl);
    li.appendChild(nameEl);
    li.appendChild(actions);
    ol.appendChild(li);
  });

  const routeWrap = document.getElementById('routeButtons');
  routeWrap.innerHTML = '';

  if (selectedIds.length >= 2) {
    const segments = [];
    let total = 0;
    for (let i = 0; i < selectedIds.length - 1; i++) {
      const a = SPOTS.find(s => s.id === selectedIds[i]);
      const b = SPOTS.find(s => s.id === selectedIds[i + 1]);
      if (!a || !b) continue;
      const km = distanceKm(a, b);
      total += km;
      segments.push({ a, b, km, from: i + 1, to: i + 2 });
    }

    const totalEl = document.createElement('div');
    totalEl.className = 'sel-total';
    totalEl.textContent = `全程直線距離合計約 ${formatDistance(total)}（實際乘車距離會更長）`;
    routeWrap.appendChild(totalEl);

    segments.forEach(seg => {
      const btn = document.createElement('a');
      btn.className = 'route-btn';
      btn.href = buildTransitUrl(seg.a, seg.b);
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
      btn.textContent = `🚉 ${seg.from}→${seg.to} ${seg.a.name} → ${seg.b.name}（直線 ${formatDistance(seg.km)}・查大眾運輸路線）`;
      routeWrap.appendChild(btn);
    });
  }

  updateRouteLine();
}

// 產生已選清單上的小按鈕（▲ ▼ ✕）
function makeSelBtn(label, title, disabled, onClick) {
  const btn = document.createElement('button');
  btn.className = 'sel-btn';
  btn.textContent = label;
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

// 調整已選景點的順序（delta 為 -1 往前、+1 往後）
function moveSelected(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= selectedIds.length) return;
  const [id] = selectedIds.splice(index, 1);
  selectedIds.splice(target, 0, id);
  renderSelection();
  updateMarkerVisibility();
}

// 需要預約或事前申請的提醒方塊
function buildBookingBox(spot) {
  if (!spot.booking) return '';
  const meta = BOOKING_META[spot.booking.level];
  return `
    <div class="booking-box" style="border-left-color:${meta.color}">
      <span class="booking-tag" style="background:${meta.color}">${meta.label}</span>
      <span class="booking-note">${spot.booking.note}</span>
    </div>`;
}

// 行前準備（證件與線上登錄），不屬於任何景點
function showPrep() {
  activeSpotId = null;
  document.getElementById('detailBody').innerHTML = `
    <div class="detail-header"><h2>${TRIP_PREP.title}</h2></div>
    <div class="detail-area">${TRIP_PREP.note}</div>
    ${TRIP_PREP.groups.map(g => `
      <div class="prep-group">
        <h3>${g.heading}</h3>
        <ul>${g.items.map(item => `<li>${item}</li>`).join('')}</ul>
      </div>`).join('')}
  `;
  if (mobileQuery.matches) openDetailSheet();
  renderList();
  updateMarkerVisibility();
}

// 日語求助小抄
function showPhrases() {
  activeSpotId = null;
  const a = PHRASES.address;
  document.getElementById('detailBody').innerHTML = `
    <div class="detail-header"><h2>${PHRASES.title}</h2></div>
    <div class="detail-area">${PHRASES.note}</div>

    <div class="phrase-address">
      <div class="phrase-address-label">${a.label}</div>
      <div class="phrase-ja phrase-ja-big">${a.ja}</div>
      <div class="phrase-sound">${a.romaji}</div>
      <div class="phrase-sound">${a.sound}</div>
      <div class="phrase-tip">${a.tip}</div>
    </div>

    <div class="prep-group">
      <h3>☎️ 緊急電話</h3>
      <ul class="phrase-tel">
        ${PHRASES.emergency.map(e => `
          <li>
            <a href="tel:${e.number.replace(/[^0-9+]/g, '')}">${e.number}</a>
            <b>${e.label}</b>
            <span>${e.note}</span>
          </li>`).join('')}
      </ul>
    </div>

    ${PHRASES.groups.map(g => `
      <div class="prep-group">
        <h3>${g.heading}</h3>
        <ul class="phrase-list">
          ${g.items.map(it => `
            <li>
              <div class="phrase-zh">${it.zh}</div>
              <div class="phrase-ja">${it.ja}</div>
              <div class="phrase-sound">${it.sound}</div>
            </li>`).join('')}
        </ul>
      </div>`).join('')}
  `;
  if (mobileQuery.matches) openDetailSheet();
  renderList();
  updateMarkerVisibility();
}

// 單一景點的 Google 地圖頁面（可看照片、評價、營業時間）
// 有填 address 就用地址查，比用概略座標精準
function buildPlaceUrl(spot) {
  const query = encodeURIComponent(spot.address || `${spot.name} ${spot.lat},${spot.lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function buildTransitUrl(a, b) {
  const origin = `${a.lat},${a.lng}`;
  const destination = `${b.lat},${b.lng}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=transit`;
}

document.getElementById('clearSelection').addEventListener('click', () => {
  selectedIds = [];
  renderList();
  renderSelection();
  updateMarkerVisibility();
});

// ---------- 手機版畫面切換 ----------
const mobileQuery = window.matchMedia('(max-width: 860px)');
const appEl = document.getElementById('app');

function setMobileView(view) {
  appEl.dataset.mview = view;
  document.querySelectorAll('.mobile-nav button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mview === view);
  });

  // 地圖剛從隱藏切回顯示時要重算尺寸，否則會是一片空白
  if (view === 'map') {
    requestAnimationFrame(() => {
      map.resize();
      const spot = SPOTS.find(s => s.id === activeSpotId);
      if (pendingFit) {
        fitToVisibleSpots();
      } else if (spot) {
        map.flyTo({ center: [spot.lng, spot.lat], zoom: 14.5, duration: 400 });
      }
    });
  }
}

// 手機（尤其 Android）習慣用返回鍵關閉浮出面板，所以開啟時壓一筆瀏覽紀錄，
// 返回鍵會先把面板收起來，再按一次才會離開網頁
function openDetailSheet() {
  if (appEl.dataset.detail === 'open') return;
  appEl.dataset.detail = 'open';
  history.pushState({ detailSheet: true }, '');
}

function closeDetailSheet(fromBackButton) {
  if (appEl.dataset.detail !== 'open') return;
  appEl.dataset.detail = 'closed';
  if (!fromBackButton && history.state && history.state.detailSheet) history.back();
}

window.addEventListener('popstate', () => {
  // 聊天視窗開著就先關它，其次才是景點介紹面板
  if (!document.getElementById('chatOverlay').hidden) {
    closeChat(true);
    return;
  }
  closeDetailSheet(true);
});

document.querySelectorAll('.mobile-nav button').forEach(btn => {
  btn.addEventListener('click', () => setMobileView(btn.dataset.mview));
});
document.getElementById('detailClose').addEventListener('click', () => closeDetailSheet());
document.getElementById('detailToMap').addEventListener('click', () => {
  closeDetailSheet();
  setMobileView('map');
});

// 轉螢幕方向或視窗縮放而跨過手機／桌機分界時，把狀態重設乾淨
mobileQuery.addEventListener('change', () => {
  closeDetailSheet();
  // 桌機版不需要浮出面板的瀏覽紀錄
  setMobileView('list');
  requestAnimationFrame(() => map.resize());
});

// ---------- 離線支援 ----------
// 註冊 Service Worker，讓網站在沒有網路時仍然打得開
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('Service Worker 註冊失敗，離線功能無法使用：', err);
    });
  });
}

function updateOnlineStatus() {
  document.getElementById('offlineBar').hidden = navigator.onLine !== false;
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// ---------- 線上導遊 ----------
const chatState = { history: [], busy: false, asked: false };

function chatEl(id) { return document.getElementById(id); }

// 把景點的實際資料整理成一行，讓導遊照我們的資料回答，而不是憑自己的記憶
function describeSpot(spot) {
  let line = `${spot.name}（${spot.area}）：${spot.desc}`;
  if (spot.booking) {
    const meta = BOOKING_META[spot.booking.level];
    line += `【${meta.label}：${spot.booking.note}】`;
  }
  return line;
}

// 把目前畫面狀態告訴導遊，它才知道「我選的這幾個」是指哪幾個
function buildGuideContext() {
  const parts = [];
  const selected = selectedIds.map(id => SPOTS.find(s => s.id === id)).filter(Boolean);

  if (selected.length) {
    parts.push('使用者目前依序勾選了這些景點：');
    selected.forEach((spot, i) => parts.push(`${i + 1}. ${describeSpot(spot)}`));

    // 相鄰兩點的直線距離，導遊才有依據判斷順不順路
    if (selected.length >= 2) {
      const legs = [];
      for (let i = 0; i < selected.length - 1; i++) {
        legs.push(`${i + 1}→${i + 2} 直線 ${formatDistance(distanceKm(selected[i], selected[i + 1]))}`);
      }
      parts.push('各段直線距離（實際乘車會更長）：' + legs.join('、'));
    }
  }

  const active = SPOTS.find(s => s.id === activeSpotId);
  if (active && !selected.includes(active)) {
    parts.push('使用者目前正在看的景點：' + describeSpot(active));
  }

  if (activeCategory !== 'all' && CATEGORY_META[activeCategory]) {
    parts.push(`目前篩選的分類：${CATEGORY_META[activeCategory].label}`);
  }

  if (!parts.length) parts.push('使用者目前還沒有勾選任何景點。');
  return parts.join('\n');
}

function addChatMessage(role, text, extraClass) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg chat-msg-' + role + (extraClass ? ' ' + extraClass : '');
  // 一律用 textContent，不讓模型回傳的內容當成 HTML 執行
  wrap.textContent = text;
  chatEl('chatMsgs').appendChild(wrap);
  chatEl('chatMsgs').scrollTop = chatEl('chatMsgs').scrollHeight;
  return wrap;
}

function renderChatSuggestions() {
  const box = chatEl('chatSuggest');
  box.innerHTML = '';
  if (chatState.asked) return;   // 問過第一題之後就不再佔空間
  AI_CONFIG.suggestions.forEach(q => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-chip';
    btn.textContent = q;
    btn.addEventListener('click', () => sendToGuide(q));
    box.appendChild(btn);
  });
}

function openChat() {
  const overlay = chatEl('chatOverlay');
  if (!overlay.hidden) return;
  overlay.hidden = false;
  if (!chatEl('chatMsgs').children.length) {
    addChatMessage('bot', AI_CONFIG.greeting);
    if (!AI_CONFIG.endpoint) {
      addChatMessage('bot', '（目前還沒有設定導遊的後端網址，所以我還不能回答。設定好之後這裡就會正常運作。）', 'chat-msg-warn');
    }
    renderChatSuggestions();
  }
  history.pushState({ chat: true }, '');
  chatEl('chatText').focus();
}

function closeChat(fromBackButton) {
  const overlay = chatEl('chatOverlay');
  if (overlay.hidden) return;
  overlay.hidden = true;
  if (!fromBackButton && history.state && history.state.chat) history.back();
}

async function sendToGuide(text) {
  const question = (text || '').trim();
  if (!question || chatState.busy) return;

  addChatMessage('user', question);
  chatEl('chatText').value = '';
  chatState.asked = true;
  renderChatSuggestions();

  if (!AI_CONFIG.endpoint) {
    addChatMessage('bot', '導遊的後端還沒設定好，暫時無法回答。' + AI_CONFIG.offlineNote, 'chat-msg-warn');
    return;
  }

  if (navigator.onLine === false) {
    addChatMessage('bot', '手機目前沒有網路。' + AI_CONFIG.offlineNote, 'chat-msg-warn');
    return;
  }

  chatState.busy = true;
  chatEl('chatSend').disabled = true;
  const thinking = addChatMessage('bot', '導遊思考中…', 'chat-msg-thinking');

  const payload = JSON.stringify({
    question,
    context: buildGuideContext(),
    history: chatState.history.slice(-6),   // 只帶最近幾輪，省流量
  });

  try {
    let res;
    try {
      res = await postToGuide(payload, 30000);
    } catch (first) {
      // Render 免費方案閒置會休眠，第一次請求常常失敗或很慢。
      // 自動重試一次，並讓使用者知道在等什麼，而不是以為壞掉了。
      thinking.textContent = '後端休眠中，正在喚醒…（最多約 60 秒，只有第一次會這麼久）';
      res = await postToGuide(payload, 70000);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const answer = (data && data.answer) ? data.answer : '導遊沒有回覆內容，請再問一次。';
    thinking.remove();
    addChatMessage('bot', answer);
    chatState.history.push({ q: question, a: answer });
  } catch (err) {
    thinking.remove();
    const reason = err.name === 'AbortError' ? '等太久沒有回應' : err.message;
    addChatMessage('bot',
      '連不上導遊（' + reason + '）。請再按一次送出試試看。' + AI_CONFIG.offlineNote,
      'chat-msg-warn');
  } finally {
    chatState.busy = false;
    chatEl('chatSend').disabled = false;
  }
}

// 帶逾時的請求，避免手機訊號差時一直轉圈
function postToGuide(payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(AI_CONFIG.endpoint + '/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

chatEl('chatBtn').addEventListener('click', openChat);
chatEl('chatClose').addEventListener('click', () => closeChat());
chatEl('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sendToGuide(chatEl('chatText').value);
});

// Render 免費方案閒置會休眠，冷啟動要幾十秒。
// 一進網頁就先敲一下健康檢查把它叫醒，等使用者真的要問時通常已經醒了。
if (AI_CONFIG.endpoint) {
  fetch(AI_CONFIG.endpoint + '/healthz', { mode: 'cors' }).catch(() => {});
}

// ---------- 搜尋與篩選 ----------
document.getElementById('searchInput').addEventListener('input', (e) => {
  searchTerm = e.target.value;
  renderList();
  updateMarkerVisibility();
});

document.getElementById('bookingOnly').addEventListener('change', (e) => {
  bookingOnly = e.target.checked;
  renderList();
  updateMarkerVisibility();
  fitToVisibleSpots();
});

document.getElementById('prepBtn').addEventListener('click', showPrep);
document.getElementById('phraseBtn').addEventListener('click', showPhrases);

// ---------- 初始化 ----------
renderTabs();
renderList();
renderSelection();
setMobileView('list');
