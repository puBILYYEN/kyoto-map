// ===== 京都行程景點地圖 app.js =====

let activeCategory = 'all';
let searchTerm = '';
let bookingOnly = false;  // 只顯示需要預約或事前申請的景點
let selectedIds = [];     // 依點選順序排列，用於產生路線
let activeSpotId = null;  // 目前顯示在下方詳細介紹的景點
const markers = {};       // id -> maplibregl.Marker
let mapLoaded = false;    // 地圖圖層載入完成後才能畫連線
let pendingFit = false;   // 地圖在手機版被隱藏時無法計算範圍，先記下來等顯示時再做
let suppressNextMarkerClick = false;   // 長按問路觸發後，吃掉緊接著補上的那次 click
let tempAskMarker = null;              // 問路時，沒對應到既有景點就在地圖上放的臨時圖釘

// ---------- 地圖初始化 ----------
// 地圖是「加分功能」，不是必要功能。
// 萬一地圖函式庫載入失敗（網路不穩、瀏覽器太舊、WebGL 不支援），
// 景點清單、日語小抄、行前準備這些救命的東西仍然必須照常運作，
// 所以整段包在 try 裡，失敗就只是沒有地圖而已。
let map = null;

try {
  if (typeof maplibregl === 'undefined') throw new Error('地圖函式庫未載入');
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty', // 免費、不需API金鑰的地圖圖磚
    center: [135.7600, 35.0100],
    zoom: 11.2,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
} catch (err) {
  console.warn('[地圖] 無法初始化，其餘功能不受影響：', err);
  map = null;
}

if (map) {
  // 景點標記是 DOM 元素，不需要等底圖樣式下載完成。
  // 以前把它放在 load 事件裡，結果樣式一載不到（網路不穩、圖磚伺服器掛了）
  // 就連一個標記都不會出現。現在立刻畫，底圖有沒有來都不影響。
  renderMarkers();
  fitToVisibleSpots();

  // 連線圖層屬於地圖樣式的一部分，這個才真的要等 load
  map.on('load', () => {
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
    updateRouteLine();
    document.getElementById('map').classList.remove('map-no-basemap');
  });

  // 放大到一定程度才顯示名稱，否則 114 個名字會糊成一團
  const LABEL_ZOOM = 13;
  const mapBox = document.getElementById('map');
  const syncLabels = () => mapBox.classList.toggle('show-labels', map.getZoom() >= LABEL_ZOOM);
  map.on('zoom', syncLabels);
  map.on('zoomend', syncLabels);
  syncLabels();

  // 用 matchMedia 現查即可，這裡執行時 mobileQuery 變數還沒宣告（在檔案後段）
  if (!window.matchMedia('(max-width: 860px)').matches) showLongPressHintOnce();

  // 底圖載不到不是世界末日：標記還在，位置關係還看得出來
  map.on('error', (e) => {
    console.warn('[地圖] 底圖載入問題：', e && e.error ? e.error.message : e);
    document.getElementById('map').classList.add('map-no-basemap');
  });

  // ---------- 長按地圖問路 ----------
  // 長按地圖上任一點：有對應到目前看得見的景點就問「到 XX 怎麼去」，
  // 沒有的話就問「到這裡怎麼去」，並在地圖上放一個臨時圖釘方便比給對方看。
  let pressTimer = null;
  let pressStart = null;
  const LONG_PRESS_MS = 550;      // 按多久算長按
  const MOVE_CANCEL_PX = 12;      // 手指移動超過這個距離，視為在滑地圖，取消長按

  function clearPressTimer() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pressStart = null;
  }

  map.on('touchstart', (e) => {
    // 兩指以上是縮放手勢，不要誤判成長按
    if (e.originalEvent.touches && e.originalEvent.touches.length > 1) { clearPressTimer(); return; }
    pressStart = { point: e.point, lngLat: e.lngLat };
    pressTimer = setTimeout(() => {
      suppressNextMarkerClick = true;
      openAskDirections(pressStart.point, pressStart.lngLat);
      pressTimer = null;
    }, LONG_PRESS_MS);
  });
  map.on('touchmove', (e) => {
    if (!pressStart) return;
    const moved = Math.hypot(e.point.x - pressStart.point.x, e.point.y - pressStart.point.y);
    if (moved > MOVE_CANCEL_PX) clearPressTimer();
  });
  map.on('touchend', () => {
    clearPressTimer();
    // 觸控結束後緊接著會補一次 click，稍等一下再解除抑制旗標
    if (suppressNextMarkerClick) setTimeout(() => { suppressNextMarkerClick = false; }, 400);
  });
  map.on('touchcancel', clearPressTimer);

  // 桌機用滑鼠測試：右鍵當作長按
  map.on('contextmenu', (e) => {
    e.originalEvent.preventDefault();
    openAskDirections(e.point, e.lngLat);
  });
}

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
  if (!map || !mapLoaded) return;
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
  if (!map) return false;
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
  if (!map) return;
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
    // 名稱標籤用 position:absolute 定位，不需要再手動設父層 position——
    // MapLibre 自己的 .maplibregl-marker 規則本來就是 position:absolute，
    // 已經是子層的定位基準。手動覆寫成 relative 會蓋掉 MapLibre 的絕對定位，
    // 讓標記改用一般文件排版，縮放時就會跟著跑掉（這是上一版的 bug）。
    // 被勾選時要在圓點中央顯示順序數字，所以用 flex 置中
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.color = '#fff';
    el.style.fontWeight = '700';
    el.style.lineHeight = '1';

    // 名稱標籤：放大到一定程度才顯示，勾選的景點則一律顯示
    const label = document.createElement('span');
    label.className = 'marker-label marker-label-' + (spot.labelSide || 'below');
    label.textContent = spot.name;
    // 純粹「24 小時開放」沒有限制可以提醒，地圖標籤上不用顯示時段
    const noRealRestriction = spot.hours && hasNoRealTimeRestriction(spot.hours);
    if (spot.hours && !noRealRestriction) {
      const hrs = document.createElement('span');
      hrs.className = 'marker-hours' + (spot.booking ? ' marker-hours-booking' : '');
      hrs.textContent = spot.hours.split('（')[0];   // 標籤只放主要時段，細節在介紹裡
      label.appendChild(hrs);
    }
    // 時段沒有限制（沒顯示，或根本沒收錄時段）但仍要事前預約時，
    // 這件事本身還是要讓人一眼看到，另外加一行黃字提醒
    if (spot.booking && noRealRestriction) {
      // 場地本身沒有限制，但要預約的項目自己有時段的話，把時段也
      // 一併標出來，不然只寫「需事前預約」看不出什麼時候要去
      const itemTime = extractBookingTimeRange(spot.booking.note);
      const note = document.createElement('span');
      note.className = 'marker-hours marker-booking-note';
      note.textContent = itemTime ? `⚠ 需事前預約 ${itemTime}` : '⚠ 需事前預約';
      label.appendChild(note);
    }
    el.appendChild(label);

    el.addEventListener('click', () => {
      // 剛觸發長按問路時，觸控結束通常還會補一個 click 事件，
      // 這裡要吃掉那一次，不然詳細介紹會跟著問路小工具一起跳出來
      if (suppressNextMarkerClick) { suppressNextMarkerClick = false; return; }
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

    // 只改文字節點，不要用 textContent 否則會把名稱標籤一起刪掉
    el.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) node.remove();
    });
    if (order >= 0) el.insertBefore(document.createTextNode(String(order + 1)), el.firstChild);
    el.style.fontSize = order >= 9 ? '9px' : '11px';
    el.classList.toggle('marker-selected', order >= 0);
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
    ${buildHours(spot)}
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

// 標示營業時間的目的是讓人知道「這裡有時間限制」。如果整段時間
// 只是說「24 小時開放」，完全沒有其他限制，那就沒有限制可以提醒，
// 不需要特別顯示這個區塊，只留地點名稱就好。但只要括號裡還有其他
// 附註（不管是不是寫成具體時間，例如「各店家營業時間不一」這種
// 提醒也算），那個附註本身還是有意義的資訊，要繼續顯示，不能因為
// 提到「24小時」就整段藏起來。
function hasNoRealTimeRestriction(hours) {
  if (!hours) return false;
  const isAllDay = /24\s*小時|24\s*小时/.test(hours);
  if (!isAllDay) return false;
  return !/[（(].*[）)]/.test(hours);   // 沒有括號附註 = 真的完全沒有限制
}

// 場地本身雖然 24 小時開放，但要預約的「那個項目」自己可能還有
// 限制時段（例如某個體驗只在 10:00–15:00 受理）。這種時候真正該
// 提醒的時間不是場地的營業時間，而是這個項目自己的時段——從預約
// 說明文字裡抓出時間區間，讓提醒可以連著項目一起顯示。
function extractBookingTimeRange(note) {
  const m = (note || '').match(/\d{1,2}[:：]\d{2}\s*[~～\-–—]\s*\d{1,2}[:：]\d{2}/);
  return m ? m[0] : null;
}

// 營業／開放時間。沒有資料時要明講，不要讓人誤以為「沒寫＝隨時可以去」
function buildHours(spot) {
  // 純粹「24 小時開放」沒有任何限制，不需要標示營業時間
  if (spot.hours && hasNoRealTimeRestriction(spot.hours)) return '';
  // 需要預約／申請的景點，如果同時有真正的限制時段，時段也一起用
  // 黃色提醒，兩個警示互相呼應
  const needsBooking = spot.booking ? ' detail-hours-booking' : '';
  if (spot.hours) {
    return `<div class="detail-hours${needsBooking}">🕘 ${spot.hours}
      <span class="hours-note">參考時間，出發前請以官網或下方 Google 地圖確認</span></div>`;
  }
  return `<div class="detail-hours detail-hours-none">🕘 營業時間未收錄
    <span class="hours-note">請點下方「在 Google 地圖上看」查看即時營業時間</span></div>`;
}

// 需要預約或事前申請的提醒方塊
function buildBookingBox(spot) {
  if (!spot.booking) return '';
  const meta = BOOKING_META[spot.booking.level];
  // 場地整體 24 小時開放、但要預約的項目自己有限制時段時，這裡
  // 才是真正的時間限制所在，整塊改成深底黃字加強提醒
  const isTimedItem = spot.hours && hasNoRealTimeRestriction(spot.hours)
    && extractBookingTimeRange(spot.booking.note);
  const timedClass = isTimedItem ? ' booking-box-timed' : '';
  return `
    <div class="booking-box${timedClass}" style="border-left-color:${meta.color}">
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

// 地圖不能用時，在地圖區塊說明清楚，不要只給使用者一片空白
if (!map) {
  const box = document.getElementById('map');
  box.innerHTML =
    '<div class="map-unavailable">' +
    '🗺️ 地圖目前無法顯示<br><br>' +
    '景點清單、日語小抄、行前準備都還正常，可以照常使用。<br>' +
    '換個網路環境重新整理，地圖通常就會回來。' +
    '</div>';
}

function setMobileView(view) {
  appEl.dataset.mview = view;
  document.querySelectorAll('.mobile-nav button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mview === view);
  });

  // 地圖剛從隱藏切回顯示時要重算尺寸，否則會是一片空白
  if (view === 'map' && map) {
    showLongPressHintOnce();
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
  // 有浮出視窗就先關它，最後才是景點介紹面板
  if (!document.getElementById('chatOverlay').hidden) {
    closeChat(true);
    return;
  }
  if (!document.getElementById('shareOverlay').hidden) {
    closeShare(true);
    return;
  }
  if (!document.getElementById('askOverlay').hidden) {
    closeAskDirections(true);
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
  if (map) requestAnimationFrame(() => map.resize());
});

// ---------- 共享清單（Firebase Firestore）----------
// 用途：妹妹在她手機上勾好景點存成一份清單，姊姊打開就能載入同一份。
// Firebase SDK 用動態 import 從 CDN 載入，只有真的要用時才下載，
// 不影響首次開啟速度，也不會影響離線功能。

const shareState = { db: null, loading: false };

function shareEl(id) { return document.getElementById(id); }

function openShare() { shareEl('shareOverlay').hidden = false; }

function closeShare(fromBackButton) {
  const overlay = shareEl('shareOverlay');
  if (overlay.hidden) return;
  overlay.hidden = true;
  if (!fromBackButton && history.state && history.state.share) history.back();
}

function shareMessage(html) {
  shareEl('shareBody').innerHTML = html;
  openShare();
  if (!history.state || !history.state.share) history.pushState({ share: true }, '');
}

// 需要時才連線，連好之後重複使用
async function getFirestore() {
  if (shareState.db) return shareState.db;
  if (!SHARE_CONFIG.firebaseConfig) throw new Error('尚未設定 Firebase');
  if (navigator.onLine === false) throw new Error('目前沒有網路');

  const BASE = 'https://www.gstatic.com/firebasejs/10.14.1';
  const [{ initializeApp }, firestore] = await Promise.all([
    import(`${BASE}/firebase-app.js`),
    import(`${BASE}/firebase-firestore.js`),
  ]);
  const app = initializeApp(SHARE_CONFIG.firebaseConfig);
  shareState.db = { ...firestore, instance: firestore.getFirestore(app) };
  return shareState.db;
}

function shareUnavailableMessage(err) {
  if (!SHARE_CONFIG.firebaseConfig) {
    return '共享清單還沒設定好（缺少 Firebase 設定），所以暫時不能用。' +
      '你目前勾選的景點仍然正常，只是沒辦法傳給其他人。';
  }
  if (navigator.onLine === false) return '目前沒有網路，共享清單需要連線才能使用。';
  return '連不上共享清單（' + err.message + '），請稍後再試。';
}

// 把目前勾選的景點存成一份清單
async function saveSharedList() {
  if (!selectedIds.length) {
    shareMessage('<p class="share-note">還沒有勾選任何景點。先在清單上勾幾個，再回來分享。</p>');
    return;
  }

  const name = prompt('幫這份清單取個名字（例如：妹妹想去的）', '');
  if (name === null) return;
  const listName = (name || '未命名清單').trim().slice(0, 40);

  shareMessage('<p class="share-note">儲存中…</p>');
  try {
    const db = await getFirestore();
    await db.addDoc(
      db.collection(db.instance, 'trips', SHARE_CONFIG.tripId, 'lists'),
      {
        name: listName,
        spotIds: selectedIds.slice(0, 60),
        createdAt: db.serverTimestamp(),
      }
    );
    await renderSharedLists('已儲存「' + listName + '」。其他人打開「共享清單」就看得到了。');
  } catch (err) {
    shareMessage('<p class="share-note">' + shareUnavailableMessage(err) + '</p>');
  }
}

// 列出所有人存過的清單
async function renderSharedLists(notice) {
  shareMessage('<p class="share-note">讀取中…</p>');
  try {
    const db = await getFirestore();
    const snap = await db.getDocs(db.query(
      db.collection(db.instance, 'trips', SHARE_CONFIG.tripId, 'lists'),
      db.orderBy('createdAt', 'desc'),
      db.limit(SHARE_CONFIG.maxLists)
    ));

    const body = shareEl('shareBody');
    body.innerHTML = '';
    if (notice) {
      const n = document.createElement('p');
      n.className = 'share-note share-note-ok';
      n.textContent = notice;
      body.appendChild(n);
    }
    if (snap.empty) {
      const p = document.createElement('p');
      p.className = 'share-note';
      p.textContent = '還沒有人分享清單。勾選幾個景點後按「分享這份清單」就會出現在這裡。';
      body.appendChild(p);
      return;
    }

    snap.forEach(docSnap => {
      const data = docSnap.data();
      const names = (data.spotIds || [])
        .map(id => (SPOTS.find(s => s.id === id) || {}).name)
        .filter(Boolean);

      const row = document.createElement('div');
      row.className = 'share-item';

      const info = document.createElement('div');
      info.className = 'share-item-info';
      const title = document.createElement('div');
      title.className = 'share-item-name';
      title.textContent = `${data.name}（${names.length} 個景點）`;
      const detail = document.createElement('div');
      detail.className = 'share-item-spots';
      detail.textContent = names.join('、') || '（清單中的景點已不存在）';
      info.appendChild(title);
      info.appendChild(detail);

      const actions = document.createElement('div');
      actions.className = 'share-item-actions';

      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'share-btn share-btn-primary';
      loadBtn.textContent = '載入';
      loadBtn.addEventListener('click', () => loadSharedList(data.spotIds || [], data.name));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'share-btn';
      delBtn.textContent = '刪除';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`確定要刪除「${data.name}」嗎？其他人也會看不到。`)) return;
        try {
          const d = await getFirestore();
          await d.deleteDoc(d.doc(d.instance, 'trips', SHARE_CONFIG.tripId, 'lists', docSnap.id));
          await renderSharedLists('已刪除「' + data.name + '」。');
        } catch (err) {
          shareMessage('<p class="share-note">刪除失敗：' + err.message + '</p>');
        }
      });

      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(actions);
      body.appendChild(row);
    });
  } catch (err) {
    shareMessage('<p class="share-note">' + shareUnavailableMessage(err) + '</p>');
  }
}

// 把清單裡的景點套用到目前的勾選
function loadSharedList(spotIds, name) {
  const valid = spotIds.filter(id => SPOTS.some(s => s.id === id));
  const missing = spotIds.length - valid.length;
  selectedIds = valid;
  renderList();
  renderSelection();
  updateMarkerVisibility();
  fitToVisibleSpots();
  closeShare();
  if (missing > 0) {
    alert(`已載入「${name}」，但其中 ${missing} 個景點已經不在資料裡，已略過。`);
  }
}

shareEl('shareSaveBtn').addEventListener('click', saveSharedList);
shareEl('shareOpenBtn').addEventListener('click', () => {
  if (!history.state || !history.state.share) history.pushState({ share: true }, '');
  renderSharedLists();
});
shareEl('shareClose').addEventListener('click', () => closeShare());

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

// ---------- 景點檢索（給導遊用的 RAG）----------
// 114 筆資料全部塞進 prompt 太浪費，而且免費模型也吃不下。
// 做法：依問題挑出最相關的幾筆再送過去。
//
// 中文沒有空白可以斷詞，所以用「兩字一組」（bigram）切開比對。
// 例如「精進料理」→ 精進、進料、料理，任何一組對上就算分。
// 114 筆資料用這種土法煉鋼就夠了，不需要 embedding 或向量資料庫。

// 這些字幾乎每句話都有，留著只會製造雜訊
const STOP_CHARS = /[的了嗎呢吧啊我你他她它們是在有會要想請問一個這那些什麼怎麼哪裡可以嘛喔耶？?！!。、，,；;：:（）()「」\s]/g;

// 使用者的講法常常跟資料裡的用詞對不上（例如問「吃素」，資料寫「精進料理」）。
// 114 筆固定資料用一張手寫的同義詞表就夠了，不需要語意模型。
const QUERY_SYNONYMS = [
  [/素食|吃素|蔬食|不吃肉|齋|vegetarian|vegan/i, '精進料理湯豆腐'],
  // 藥妝要指向實際賣藥妝的地方，不要整個「穿搭與藥妝」分類（和服店也在裡面）
  [/藥妝|買藥|藥局|化妝品|美妝|保養品/i, '藥妝松本清'],
  [/購物|血拼|伴手禮|紀念品|逛街/i, '商店街市場伴手禮'],
  [/賞楓|紅葉|楓葉|楓紅|秋天/i, '紅葉'],
  [/賞櫻|櫻花|春天/i, '櫻'],
  [/夜景|夜晚|晚上|點燈/i, '夜景點燈'],
  [/和服|浴衣|變裝|換裝/i, '和服'],
  [/抹茶|茶道|綠茶|茶葉/i, '抹茶宇治茶'],
  [/信長|戰國|武將|軍事|歷史迷/i, '織田信長'],
  [/陰陽師|晴明|安倍|動漫|漫畫/i, '陰陽師晴明'],
  [/拍照|網美|打卡|美照|景色|風景/i, '美景'],
  [/世界遺產|遺產/i, '世界遺產'],
  [/庭園|枯山水|造景/i, '庭園枯山水'],
  [/住宿|住哪|住的|飯店|旅館|民宿|過夜|睡/i, '住宿'],
  [/金色|金箔|金的/i, '金閣'],
  [/銀色|銀的/i, '銀閣'],
  [/坐船|搭船|遊船|船/i, '遊船保津川'],
  [/爬山|登山|健行/i, '山'],
  [/姻緣|戀愛|求愛|結緣/i, '姻緣戀'],
  [/斷緣|惡緣|分手/i, '緣切'],
  [/機場|飛機|起飛|降落/i, '關西國際機場'],
  [/車站|電車|地鐵|巴士|公車|交通/i, '京都車站'],
  [/預約|訂位|申請|報名/i, '預約申請'],
  [/神社|參拜|求籤|御守/i, '神社'],
  [/寺廟|寺院|佛寺/i, '寺'],
];

function expandQuery(question) {
  let extra = '';
  QUERY_SYNONYMS.forEach(([pattern, words]) => {
    if (pattern.test(question)) extra += words;
  });
  return question + extra;
}

function normalizeText(text) {
  return String(text).toLowerCase().replace(/[·・【】…\-—]/g, '');
}

function toTerms(text) {
  const out = new Set();
  const latin = text.match(/[a-z0-9]{2,}/g) || [];
  latin.forEach(w => out.add(w));
  const cjk = text.replace(/[a-z0-9]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2));
  if (cjk.length === 1) out.add(cjk);   // 只剩一個字時也要能查
  return [...out];
}

// 每個景點的檢索文字，只建一次
const SEARCH_INDEX = SPOTS.map(spot => {
  const cats = spot.categories.map(c => CATEGORY_META[c].label).join('');
  const booking = spot.booking
    ? BOOKING_META[spot.booking.level].label + spot.booking.note
    : '';
  return {
    spot,
    // 名稱、地區、分類是強訊號；介紹文是弱訊號
    strong: normalizeText(spot.name + spot.area + cats),
    weak: normalizeText(spot.desc + booking),
  };
});

function findRelevantSpots(question, limit, excludeIds) {
  const cleaned = normalizeText(expandQuery(question)).replace(STOP_CHARS, '');
  const terms = toTerms(cleaned);
  if (!terms.length) return [];

  const skip = new Set(excludeIds || []);
  const scored = [];
  SEARCH_INDEX.forEach(entry => {
    if (skip.has(entry.spot.id)) return;
    let score = 0;
    terms.forEach(t => {
      if (entry.strong.includes(t)) score += 3;
      else if (entry.weak.includes(t)) score += 1;
    });
    if (score > 0) scored.push({ spot: entry.spot, score });
  });

  scored.sort((a, b) => b.score - a.score);
  // 只留下跟最高分同一個量級的，避免把勉強沾上邊的景點也塞給導遊
  const threshold = scored.length ? scored[0].score * 0.45 : 0;
  return scored.filter(r => r.score >= threshold).slice(0, limit).map(r => r.spot);
}

// ---------- 長按地圖問路 ----------

// 名稱裡的「（住宿）」「（KIX）」這類備註不是地名本身，
// 寫進日文問句或念出來時要先拿掉，不然日本人會聽得一頭霧水。
function stripAnnotations(name) {
  return name.replace(/[（(][^）)]*[）)]/g, '').trim();
}

// 在觸控點附近找一個目前看得見的景點（螢幕像素距離，不是地理距離，
// 這樣不管縮放到哪一級，判定的「附近」範圍感覺起來都差不多）
function findNearestVisibleSpot(point, maxPx) {
  let best = null;
  let bestDist = Infinity;
  SPOTS.forEach(spot => {
    const marker = markers[spot.id];
    if (!marker) return;
    if (marker.getElement().style.display === 'none') return;   // 目前篩選下看不到的不算
    const screenPos = map.project([spot.lng, spot.lat]);
    const dist = Math.hypot(screenPos.x - point.x, screenPos.y - point.y);
    if (dist < bestDist) { bestDist = dist; best = spot; }
  });
  return (best && bestDist <= maxPx) ? best : null;
}

function buildAskPhrase(spot) {
  if (spot) {
    const name = stripAnnotations(spot.name);
    return {
      label: name,
      zh: ASK_DIRECTIONS.zhTemplate.replace('{name}', name),
      ja: ASK_DIRECTIONS.jaTemplate.replace('{name}', name),
    };
  }
  return { label: '地圖上這個位置', zh: ASK_DIRECTIONS.zhGeneric, ja: ASK_DIRECTIONS.jaGeneric };
}

// 用手機內建的語音合成朗讀日文，這樣遇到日本人時按一下就等於幫忙開口問路，
// 不用自己唸、也不用擔心發音不準。
//
// 重要：如果手機沒有裝日文語音包，speechSynthesis 找不到日文語音時，
// 有些裝置會「默默改用系統預設語音」唸這串日文字——實測發現會變成用
// 中文發音硬套日文，比不播還糟糕（日本人聽了只會更困惑）。
// 所以這裡刻意變嚴格：找不到真正的日文語音就不播，改成清楚引導去安裝，
// 畫面上的日文文字一直都在，可以直接給對方看文字當備案。
function showAskWarning(text) {
  const warn = document.getElementById('askWarning');
  if (!warn) return;
  warn.textContent = text;
  warn.hidden = false;
}

function speakJapanese(text) {
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    showAskWarning('這個瀏覽器不支援語音朗讀，請直接把畫面給對方看這句日文。');
    return;
  }
  speechSynthesis.cancel();   // 停掉上一次可能還沒播完的

  let handled = false;
  const trySpeak = () => {
    if (handled) return;
    handled = true;
    const jaVoice = speechSynthesis.getVoices().find(v => v.lang && v.lang.toLowerCase().startsWith('ja'));
    if (!jaVoice) {
      showAskWarning(
        '這台手機還沒有安裝日文語音，播放出來的發音會不準確（可能會變成用中文發音硬唸日文）。\n\n' +
        '請到手機「設定」裡搜尋「文字轉語音」，選擇文字轉語音引擎的設定 → 安裝語音資料 → ' +
        '下載「日本語」語音包，裝好後再回來按一次播放。\n\n' +
        '這段時間可以先直接把畫面給對方看這句日文。'
      );
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ja-JP';
    utter.voice = jaVoice;
    utter.rate = 0.9;   // 稍微放慢，對方比較聽得清楚
    speechSynthesis.speak(utter);
  };

  // 有些瀏覽器第一次呼叫時語音清單還是空的，要等 voiceschanged 事件才拿得到
  if (speechSynthesis.getVoices().length) {
    trySpeak();
  } else {
    speechSynthesis.addEventListener('voiceschanged', trySpeak, { once: true });
    setTimeout(trySpeak, 400);   // 保險：萬一事件沒觸發，還是要判斷一次
  }
}

function openAskDirections(point, lngLat) {
  const spot = findNearestVisibleSpot(point, 28);
  const phrase = buildAskPhrase(spot);

  if (tempAskMarker) { tempAskMarker.remove(); tempAskMarker = null; }
  if (!spot) {
    // 沒對應到既有景點，放一個臨時圖釘，方便直接把手機畫面比給對方看「就是這裡」
    const el = document.createElement('div');
    el.className = 'ask-pin';
    tempAskMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
  }

  document.getElementById('askBody').innerHTML = `
    <div class="ask-target">📍 ${phrase.label}</div>
    <div class="phrase-zh">${phrase.zh}</div>
    <div class="phrase-ja phrase-ja-big">${phrase.ja}</div>
    <button type="button" class="ask-play-btn" id="askPlayBtn">🔊 播放日語問路</button>
    <div class="ask-warning" id="askWarning" hidden></div>
    <div class="phrase-tip">${ASK_DIRECTIONS.tip}</div>
  `;
  document.getElementById('askPlayBtn').addEventListener('click', () => speakJapanese(phrase.ja));

  document.getElementById('askOverlay').hidden = false;
  history.pushState({ ask: true }, '');
}

function closeAskDirections(fromBackButton) {
  const overlay = document.getElementById('askOverlay');
  if (overlay.hidden) return;
  overlay.hidden = true;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (tempAskMarker) { tempAskMarker.remove(); tempAskMarker = null; }
  if (!fromBackButton && history.state && history.state.ask) history.back();
}

document.getElementById('askClose').addEventListener('click', () => closeAskDirections());

// 第一次使用才提示這個手勢，之後就不再顯示
function showLongPressHintOnce() {
  let seen = false;
  try { seen = localStorage.getItem('kyotoMapAskHintSeen') === '1'; } catch { /* 私密瀏覽模式可能會擋 */ }
  if (seen) return;
  const hint = document.getElementById('mapHint');
  if (!hint) return;
  hint.textContent = ASK_DIRECTIONS.hint;
  hint.hidden = false;
  const hide = () => { hint.hidden = true; };
  hint.addEventListener('click', hide, { once: true });
  setTimeout(hide, 6000);
  try { localStorage.setItem('kyotoMapAskHintSeen', '1'); } catch { /* 同上 */ }
}

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
function buildGuideContext(question) {
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

  // 依問題從 114 個景點裡撈出可能相關的，讓導遊有資料可以回答
  const related = findRelevantSpots(question, 6, selectedIds.concat(activeSpotId || []));
  if (related.length) {
    parts.push('');
    parts.push('資料庫中可能與問題相關的其他景點（使用者沒有勾選，僅供你參考）：');
    related.forEach(spot => parts.push('- ' + describeSpot(spot)));
  }

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
      addChatMessage('bot', '（導遊還在準備中，目前還不能回答。）', 'chat-msg-warn');
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
    addChatMessage('bot', guideErrorMessage('E2'), 'chat-msg-warn');
    return;
  }

  if (navigator.onLine === false) {
    addChatMessage('bot', '手機目前沒有網路，導遊需要連線才能回答。' + AI_CONFIG.offlineNote, 'chat-msg-warn');
    return;
  }

  chatState.busy = true;
  chatEl('chatSend').disabled = true;
  const thinking = addChatMessage('bot', '導遊思考中…', 'chat-msg-thinking');

  const payload = JSON.stringify({
    question,
    context: buildGuideContext(question),
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
    if (!res.ok) {
      // 使用者只需要看到代號，詳細原因寫進主控台給開發者查
      let detail = '';
      try {
        const body = await res.json();
        if (body && body.error) detail = body.error;
      } catch { /* 回應不是 JSON */ }
      console.warn('[導遊] HTTP ' + res.status + (detail ? '：' + detail : ''));
      throw Object.assign(new Error('guide-http'), { code: 'E' + res.status });
    }
    const data = await res.json();
    const answer = (data && data.answer) ? data.answer : '導遊沒有回覆內容，請再問一次。';
    thinking.remove();
    addChatMessage('bot', answer);
    chatState.history.push({ q: question, a: answer });
  } catch (err) {
    thinking.remove();
    console.warn('[導遊] 失敗：', err);
    const code = err.code || (err.name === 'AbortError' ? 'E4' : 'E3');
    addChatMessage('bot', guideErrorMessage(code), 'chat-msg-warn');
  } finally {
    chatState.busy = false;
    chatEl('chatSend').disabled = false;
  }
}

// 家人看到的只有一句人話加一個代號；代號是給開發者對照用的
//   E1  沒有網路      E2  還沒設定導遊後端
//   E3  連不上後端    E4  等太久沒有回應
//   E4xx / E5xx  後端回傳的 HTTP 狀態（例如 E502 = 後端連不到 AI 供應商）
function guideErrorMessage(code) {
  return `導遊現在沒辦法回答，等一下再試試看。（代號 ${code}）`;
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
