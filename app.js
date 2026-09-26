// ===== 京都行程景點地圖 app.js =====

// 系統記錄（logger.js）。用 function 宣告（會被提升），任何地方呼叫都不會踩到 TDZ；
// logger.js 萬一沒載入成功，這裡就什麼都不做，不會拖垮網站。
function appLog(level, tag, msg) {
  if (typeof window.sysLog === 'function') window.sysLog(level, tag, msg);
}

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

// 跳棋（其他家人即時選的景點）：renderMarkers() 在檔案開頭就會同步執行
// （見下面「地圖初始化」的說明），renderMemberPawns() 會在那時候就用到
// 這個變數，宣告在後面會踩到 TDZ，所以要跟其他早期宣告放在一起。
let othersState = {};                  // 其他人：id -> { name, color, spotIds }

// 自己的選點存在手機裡，網頁被關掉再打開才不會變成 0 個。以前沒存，重新開啟時
// 畫面是空的，又會立刻把空清單上傳，蓋掉雲端原本的選點（家人看到「某人 5→0」）。
// 還沒跟雲端上自己的資料比對過之前一律不准上傳（ownSelectionReconciled），
// 比對時看哪邊比較新（selectionChangedAt vs 雲端 updatedAt）。
// 這幾個要在 renderMarkers() 之前宣告並還原，理由同上面的 TDZ 說明。
const SELECTION_KEY = 'kyotoMapSelected';
let selectionChangedAt = 0;          // 這台手機最後一次改選點的時間（毫秒），0 = 從沒改過
let lastPersistedKey = '';
let ownSelectionReconciled = false;
restoreSavedSelection();

// 電視版「跟著手機」：登入後打開哪個景點的介紹，就寫到 Firestore trips/kyoto2026/viewing/{uid}，
// 電視版會跟著飛過去顯示。跟選點資料分開放，規則還沒發布時只有這個功能不能用，不影響選點同步。
let viewingTimer = null;
let viewingDisabled = false;

function restoreSavedSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) || 'null');
    if (!saved || !Array.isArray(saved.ids)) return;
    selectedIds = saved.ids.filter(id => SPOTS.some(s => s.id === id));
    selectionChangedAt = Number(saved.at) || 0;
    lastPersistedKey = selectedIds.join(',');
    if (selectedIds.length) appLog('info', 'select', `從手機還原上次的選點 ${selectedIds.length} 個：${lastPersistedKey}`);
  } catch (e) { /* 私密瀏覽等情況讀不到，就從空的開始 */ }
}

// 選點真的有變才更新時間與存檔（renderSelection 每次都會呼叫，但畫面重畫不算「改選點」）
function persistSelection() {
  const key = selectedIds.join(',');
  if (key === lastPersistedKey) return;
  lastPersistedKey = key;
  selectionChangedAt = Date.now();
  try { localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: selectedIds, at: selectionChangedAt })); }
  catch (e) { /* 存不了就只是重新開啟時不會還原 */ }
}

// 特殊標記形狀（三角形/星形/元寶/坐佛）各自的底色，renderMarkers() 也是
// 在檔案開頭就同步執行，要跟上面 othersState 一樣早宣告避免 TDZ。
const SHAPE_BASE_COLOR = { triangle: '#ff8f00', star: '#ffcc00', ingot: '#ffcc00', buddha: '#a67c00', diamond: '#00b8d4', invtriangle: '#e00000', heart: '#e91e63' };

// 有些景點跟境內附屬的店家／設施座標完全相同（例如龍安寺跟西源院、
// 貴船神社跟貴船溪谷），圖釘會疊在同一個像素上，沒被選取的那個會把
// 另一個整個蓋住——包含蓋住的那個景點自己的跳棋旗子，導致明明有人
// 選了卻在地圖上完全看不到。這裡用 MapLibre Marker 的 pixel offset
// 把畫面上的圖釘位置錯開幾個像素，不管縮放到多遠都分得開；不改
// spot.lat/lng 本身，所以 Google 地圖連結、距離計算都不受影響。
// 要跟 renderMarkers() 一樣早宣告，避免 TDZ。
function computeMarkerOffsets() {
  const groups = {};
  SPOTS.forEach(spot => {
    const key = spot.lat.toFixed(5) + ',' + spot.lng.toFixed(5);
    (groups[key] = groups[key] || []).push(spot.id);
  });
  const offsets = {};
  const r = 9;   // 像素，不隨縮放程度變化
  Object.values(groups).forEach(ids => {
    if (ids.length < 2) return;
    ids.forEach((id, i) => {
      const angle = (2 * Math.PI * i) / ids.length;
      offsets[id] = [r * Math.cos(angle), r * Math.sin(angle)];
    });
  });
  return offsets;
}
const markerOffsets = computeMarkerOffsets();

// 「24 小時開放」「境內自由參拜」這類講法都代表本身沒有時間限制。
// 一定要宣告在這裡：renderMarkers() 在檔案開頭就會執行，const 宣告在
// 後面的話會踩到暫時性死區（TDZ），標記會整個畫不出來。
const NO_LIMIT_RE = /24\s*小時|24\s*小时|自由參拜|自由参拝|境內自由|境内自由/;   // 簡繁檢查：刻意同時比對簡體與日文寫法

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

  // 定位按鈕：用手機瀏覽器原生 GPS，不需要任何 API 金鑰。
  // trackUserLocation 開著的話，走動時藍點會跟著移動，適合現場對照
  // 「我在哪裡、下一個景點怎麼走」。
  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  });
  map.addControl(geolocate, 'top-right');
  geolocate.on('error', (err) => {
    // 常見原因：使用者按了拒絕、瀏覽器不支援、或不是 HTTPS。
    // 不讓地圖壞掉，只是提示一下，跟長按問路共用同一個提示區塊。
    console.warn('[定位] 無法取得位置：', err);
    const hint = document.getElementById('mapHint');
    if (!hint) return;
    hint.textContent = err.code === 1
      ? '📍 定位被拒絕了，如果想用這個功能，請到手機設定允許這個網站使用位置。'
      : '📍 目前無法取得你的位置，請稍後再試。';
    hint.hidden = false;
    const hide = () => { hint.hidden = true; };
    hint.addEventListener('click', hide, { once: true });
    setTimeout(hide, 6000);
  });
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
  appLog('info', '地圖', `標記已畫出 ${Object.keys(markers).length} / ${SPOTS.length} 個`);

  map.on('load', () => appLog('info', '地圖', '底圖樣式載入完成'));

  // 連線圖層屬於地圖樣式的一部分，這個才真的要等 load
  map.on('load', () => {
    // 京都府府界。先加，讓它墊在路線連線底下，不要蓋住行程
    if (typeof KYOTO_BORDER !== 'undefined') {
      map.addSource('kyotoBorder', { type: 'geojson', data: KYOTO_BORDER });
      // 淡淡的底色只在拉遠時出現，讓人看出「京都府其實這麼大」；
      // 放大到市區規劃行程時完全淡出，不然整個畫面都會被染紅
      map.addLayer({
        id: 'kyotoBorderFill',
        type: 'fill',
        source: 'kyotoBorder',
        paint: {
          'fill-color': '#d92b2b',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.10, 10, 0.06, 12.5, 0],
        },
      });
      map.addLayer({
        id: 'kyotoBorderLine',
        type: 'line',
        source: 'kyotoBorder',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#d92b2b',
          'line-opacity': 0.85,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 10, 2.2, 14, 3],
        },
      });
    }

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
        // 每個人的路線用自己的跳棋顏色畫（沒設定跳棋的話用預設深色），
        // 顏色存在 GeoJSON feature 的 properties.color 裡，見 updateRouteLine()
        'line-color': ['get', 'color'],
        'line-width': 2.5,
        'line-opacity': 0.75,
        'line-dasharray': [2, 1.6],
      },
    });
    mapLoaded = true;
    updateRouteLine();
    document.getElementById('map').classList.remove('map-no-basemap');
    precacheDisasterTiles();
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

// ---------- 順路排序（給線上導遊參考，也用在套用建議順序時算距離） ----------
// 從飯店出發，照直線距離排出總長最短的順序（走完不用回飯店）。
// 15 個以內用精確算法（Held-Karp），保證是最短（手機上約 0.2 秒內）；更多的話用
// 「2-opt＋搬移單點」從不同起始順序反覆重試 0.3 秒、挑最短的，不保證最短但很接近。距離是直線，實際搭車會不一樣，所以只當導遊的參考，
// 導遊還會考慮營業時間、預約、長輩體力等因素。
function routeStart() {
  return SPOTS.find(s => s.id === 'b01') || null;   // 住宿 RESI STAY HEART
}

function routeLengthKm(start, spots) {
  let km = 0;
  let prev = start;
  spots.forEach(s => { if (prev) km += distanceKm(prev, s); prev = s; });
  return km;
}

function planRouteOrder(spots, start) {
  if (spots.length < 2) return spots.slice();
  if (!start) {
    // 沒有飯店資料時，就以第一個景點當起點
    return [spots[0], ...planRouteOrder(spots.slice(1), spots[0])];
  }
  return spots.length <= 15 ? exactRoute(spots, start) : heuristicRoute(spots, start);
}

function exactRoute(spots, start) {
  const n = spots.length;
  const full = (1 << n) - 1;
  const d = spots.map(a => spots.map(b => distanceKm(a, b)));
  const cost = new Float64Array((1 << n) * n).fill(Infinity);
  const from = new Int8Array((1 << n) * n).fill(-1);
  for (let j = 0; j < n; j++) cost[(1 << j) * n + j] = distanceKm(start, spots[j]);
  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < n; j++) {
      const c = cost[mask * n + j];
      if (!(mask & (1 << j)) || c === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const next = mask | (1 << k);
        const nc = c + d[j][k];
        if (nc < cost[next * n + k]) { cost[next * n + k] = nc; from[next * n + k] = j; }
      }
    }
  }
  let end = 0;
  for (let j = 1; j < n; j++) if (cost[full * n + j] < cost[full * n + end]) end = j;
  const order = [];
  for (let mask = full, j = end; j >= 0;) {
    order.push(spots[j]);
    const prev = from[mask * n + j];
    mask &= ~(1 << j);
    j = prev;
  }
  return order.reverse();
}

function heuristicRoute(spots, start, budgetMs = 300) {
  // 第一次從「每次走最近的下一個」開始，之後每次打亂重來，時間到就停
  const nearest = [];
  const rest = spots.slice();
  let cur = start;
  while (rest.length) {
    let best = 0;
    rest.forEach((s, i) => { if (distanceKm(cur, s) < distanceKm(cur, rest[best])) best = i; });
    cur = rest.splice(best, 1)[0];
    nearest.push(cur);
  }
  let bestPath = improveRoute(nearest, start);
  let bestLen = routeLengthKm(start, bestPath);
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const shuffled = spots.slice().sort(() => Math.random() - 0.5);
    const cand = improveRoute(shuffled, start);
    const len = routeLengthKm(start, cand);
    if (len + 1e-9 < bestLen) { bestPath = cand; bestLen = len; }
  }
  return bestPath;
}

function improveRoute(initial, start) {
  const path = initial.slice();
  let bestLen = routeLengthKm(start, path);
  for (let round = 0, improved = true; improved && round < 100; round++) {
    improved = false;
    // 2-opt：把一段路反過來走
    for (let i = 0; i < path.length - 1; i++) {
      for (let k = i + 1; k < path.length; k++) {
        const cand = [...path.slice(0, i), ...path.slice(i, k + 1).reverse(), ...path.slice(k + 1)];
        const len = routeLengthKm(start, cand);
        if (len + 1e-9 < bestLen) { path.splice(0, path.length, ...cand); bestLen = len; improved = true; }
      }
    }
    // 搬移單點：把一個景點拿出來插到別的位置
    for (let i = 0; i < path.length; i++) {
      for (let k = 0; k < path.length; k++) {
        if (k === i) continue;
        const cand = path.slice();
        const [x] = cand.splice(i, 1);
        cand.splice(k, 0, x);
        const len = routeLengthKm(start, cand);
        if (len + 1e-9 < bestLen) { path.splice(0, path.length, ...cand); bestLen = len; improved = true; }
      }
    }
  }
  return path;
}

// 導遊（或家人傳來的連結）建議的新順序，一律只「重新排列」：
// 建議裡有、目前也有選的，照建議的先後排；建議裡漏掉的，保留並接在最後面（絕不刪除）；
// 建議裡多出來、目前沒選的，一律忽略（要新增景點只能走 [[ADD: …]]）。
function reorderKeepAll(current, proposal) {
  const cur = new Set(current);
  const seen = new Set();
  const out = [];
  proposal.forEach(id => { if (cur.has(id) && !seen.has(id)) { out.push(id); seen.add(id); } });
  current.forEach(id => { if (!seen.has(id)) { out.push(id); seen.add(id); } });
  return out;
}

// 路線改成貼著馬路走的彎曲線，不是直線——用免費、不需要金鑰的 OSRM
// 路線規劃服務（走路路徑），求的是「看得出真的怎麼走」，不是精確的
// 大眾運輸轉乘（那個要付費的 API 才做得到，見 README 的說明）。
// 每個人算過的路線會快取起來，順序沒變就不用重打一次。
const ROUTE_COLOR_DEFAULT = '#2b2620';   // 沒設定跳棋的自己，維持原本的深色
const routeCache = {};                   // key: 顏色+景點id序列 -> 路線座標陣列
let routeUpdateToken = 0;                // 避免舊的非同步結果蓋掉新的

async function fetchRoadRoute(coords) {
  const key = coords.map(c => c.join(',')).join(';');
  if (routeCache[key]) return routeCache[key];
  const query = coords.map(([lng, lat]) => `${lng},${lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/foot/${query}?overview=full&geometries=geojson`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error('OSRM ' + res.status);
    const data = await res.json();
    const line = data && data.routes && data.routes[0] && data.routes[0].geometry;
    if (!line || line.type !== 'LineString') throw new Error('OSRM 回傳格式不對');
    routeCache[key] = line.coordinates;
    return line.coordinates;
  } catch (err) {
    // 連不上路線規劃服務（離線、服務忙線）就沒關係，外層會自動退回直線
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function spotCoords(ids) {
  return ids
    .map(id => SPOTS.find(s => s.id === id))
    .filter(Boolean)
    .map(s => [s.lng, s.lat]);
}

// 依目前勾選順序，在地圖上畫出連線——自己跟每個有設定跳棋的家人，
// 各自用自己的顏色各畫一條，貼著馬路走
async function updateRouteLine() {
  if (!map || !mapLoaded) return;
  const token = ++routeUpdateToken;

  const people = [{ key: 'self', color: memberIdentity ? memberIdentity.color : ROUTE_COLOR_DEFAULT, ids: selectedIds }];
  Object.entries(othersState).forEach(([id, m]) => {
    if (Array.isArray(m.spotIds) && m.spotIds.length >= 2) people.push({ key: id, color: m.color, ids: m.spotIds });
  });

  // key -> 目前這條線用的座標，先全部墊上直線，路線規劃回來後才逐一換成彎曲線，
  // 不會讓人在等待的那一兩秒內完全看不到線
  const lineByKey = {};
  people.forEach(person => {
    const coords = spotCoords(person.ids);
    if (coords.length >= 2) lineByKey[person.key] = coords;
  });

  const buildFeatures = () => people
    .filter(p => lineByKey[p.key])
    .map(p => ({ type: 'Feature', properties: { color: p.color }, geometry: { type: 'LineString', coordinates: lineByKey[p.key] } }));

  map.getSource('routeLine').setData({ type: 'FeatureCollection', features: buildFeatures() });

  // 逐一去要貼著馬路走的版本，哪個先查到就先換上去，互不影響
  await Promise.all(people.map(async (person) => {
    if (!lineByKey[person.key]) return;
    const road = await fetchRoadRoute(spotCoords(person.ids));
    if (!road || token !== routeUpdateToken) return;   // 沒查到就維持直線；查詢途中又有新變動就放棄這次結果
    lineByKey[person.key] = road;
    map.getSource('routeLine').setData({ type: 'FeatureCollection', features: buildFeatures() });
  }));
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
    el.style.cursor = 'pointer';
    if (SHAPE_BASE_COLOR[spot.shape]) {
      // ⚠️ 這幾種形狀都不能直接把 clip-path 設在 el 本身：clip-path 會
      // 把「這個元素連同它所有子層」一起裁切成那個形狀範圍，而名稱標籤
      // 是用 top:100% 定位在 el 框框「外面」（見下面 .marker-label 的
      // 說明），一旦 el 被裁切，框外的標籤跟著被整個裁掉、憑空消失——
      // 這是「星形/三角形上的文字標籤跟介紹都不見了」這個 bug 的成因。
      // 改成用 .marker-shape-* 這幾個 CSS class 搭配 ::before 偽元素
      // 來畫形狀，形狀只裁切 ::before 自己，el 本身連同上面的名稱標籤、
      // 徽章、選取後的順序數字都完全不受影響。
      el.style.background = 'transparent';
      el.classList.add('marker-shape-' + spot.shape);
      // 每種都改用亮色＋顏色閃爍（不是整體忽隱忽現，不然點擊時常常在
      // 變淡的瞬間點不準），顏色刻意分成不同色系方便一眼分辨是哪一種
      el.style.setProperty('--marker-shape-bg', SHAPE_BASE_COLOR[spot.shape]);
    } else {
      el.style.background = CATEGORY_META[spot.categories[0]].color;
      el.style.borderRadius = '50%';
      el.style.border = '2px solid #fff';
      el.style.boxShadow = '0 0 3px rgba(0,0,0,0.4)';
    }
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

    // 動漫巡禮景點加一個電影拍板徽章疊在圓點右上角，不動圓點本身的
    // 分類顏色。el 本身已經是 position:absolute（MapLibre 自己的
    // .maplibregl-marker 規則給的，不是這裡手動設的），子元素用
    // absolute 定位可以正常錨定在 el 上，不會踩到「手動改 el 的
    // position 蓋掉 MapLibre 定位」那個舊 bug（見上面的說明註解）。
    if (spot.categories.includes('anime')) {
      const badge = document.createElement('span');
      badge.textContent = '🎬';
      badge.style.position = 'absolute';
      badge.style.top = '-9px';
      badge.style.right = '-9px';
      badge.style.width = '16px';
      badge.style.height = '16px';
      badge.style.fontSize = '11px';
      badge.style.lineHeight = '1';
      badge.style.background = '#fff';
      badge.style.borderRadius = '50%';
      badge.style.display = 'flex';
      badge.style.alignItems = 'center';
      badge.style.justifyContent = 'center';
      badge.style.boxShadow = '0 0 2px rgba(0,0,0,0.5)';
      el.appendChild(badge);
    }

    // 名稱標籤：放大到一定程度才顯示，勾選的景點則一律顯示
    const label = document.createElement('span');
    label.className = 'marker-label marker-label-' + (spot.labelSide || 'below');
    label.textContent = spot.name;
    // 純粹「24 小時開放」沒有限制可以提醒，地圖標籤上不用顯示時段
    const hoursShown = spot.hours && !hasNoRealTimeRestriction(spot.hours);
    if (hoursShown) {
      // 24小時開放＋括號例外時，只顯示例外本身（例如「社務所
      // 8:30–16:30」），不重複講沒有限制的「24小時開放」
      const isAllDay = NO_LIMIT_RE.test(spot.hours);
      const restrictionNote = isAllDay ? extractRestrictionNote(spot.hours) : null;
      const hrs = document.createElement('span');
      hrs.className = 'marker-hours' + (spot.booking ? ' marker-hours-booking' : '');
      hrs.textContent = restrictionNote || spot.hours.split('（')[0];   // 標籤只放主要時段，細節在介紹裡
      label.appendChild(hrs);
    }
    // 沒有時段可以標（沒收錄，或時段本身沒有限制）但要事前預約時，
    // 這件事更要讓人一眼看到，另外加一行黃字提醒。
    // 要預約的景點幾乎都沒有固定營業時間（時段是預約時才決定的），
    // 所以提醒絕對不能綁在「有沒有收錄時段」上，不然全部都不會顯示。
    if (spot.booking && !hoursShown) {
      // 要預約的項目自己有時段的話，把時段也一併標出來，
      // 不然只寫「需事前預約」看不出什麼時候要去
      const itemTime = extractBookingTimeRange(spot.booking.note);
      const note = document.createElement('span');
      note.className = 'marker-hours marker-booking-note';
      note.textContent = '⚠ ' + BOOKING_META[spot.booking.level].label + (itemTime ? ' ' + itemTime : '');
      label.appendChild(note);
    }
    el.appendChild(label);

    el.addEventListener('click', () => {
      // 剛觸發長按問路時，觸控結束通常還會補一個 click 事件，
      // 這裡要吃掉那一次，不然詳細介紹會跟著問路小工具一起跳出來
      if (suppressNextMarkerClick) { suppressNextMarkerClick = false; return; }
      showDetail(spot.id);
    });

    // 景點真正的座標（setLngLat）完全不動，一定是 spot.lng/spot.lat 本身，
    // 不會因為旁邊有重疊的圖釘就跑掉。只有 offset 這個畫面上的像素位移
    // 會讓重疊的圖釘看起來分開一點，地圖底層記的位置還是同一個點。
    const off = markerOffsets[spot.id];
    const marker = new maplibregl.Marker({ element: el, offset: off || [0, 0] })
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

    // 座標完全相同的圖釘現在已經用 markerOffsets 錯開幾個像素（見上面
    // computeMarkerOffsets 的說明），但縮放程度高或圖釘本身放大時還是
    // 可能局部疊到。這裡再用 z-index 保險一次：已選取的永遠疊最上面，
    // 其次是「身上有跳棋旗子」的（不能讓旁邊沒人選的景點把跳棋蓋住），
    // 再來是目前查看中的，其餘維持預設順序。
    const hasPawn = Object.values(othersState).some(
      m => Array.isArray(m.spotIds) && m.spotIds.includes(spot.id)
    );
    // 星形（住宿地點）不管有沒有被選取、旁邊有沒有跳棋旗子，一律疊在最上層，
    // 不然常常被別的景點蓋住找不到。
    el.style.zIndex = spot.shape === 'star' ? '20' : order >= 0 ? '10' : hasPawn ? '8' : (spot.id === activeSpotId ? '5' : '1');

    // 只改文字節點，不要用 textContent 否則會把名稱標籤一起刪掉
    el.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) node.remove();
    });
    if (order >= 0) el.insertBefore(document.createTextNode(String(order + 1)), el.firstChild);
    el.style.fontSize = order >= 9 ? '9px' : '11px';
    el.classList.toggle('marker-selected', order >= 0);
  });
  renderMemberPawns();
}

// 跳棋：把其他家人選的景點，用他們自己的顏色＋自己的順序號碼疊在圓點旁邊，
// 不動到圓點本身（那是自己的選點，邏輯完全不受這個功能影響）
function renderMemberPawns() {
  if (!map) return;
  SPOTS.forEach(spot => {
    const marker = markers[spot.id];
    if (!marker) return;
    const el = marker.getElement();
    el.querySelectorAll('.member-pawn').forEach(n => n.remove());

    const pawns = Object.values(othersState).filter(
      m => Array.isArray(m.spotIds) && m.spotIds.includes(spot.id)
    );
    pawns.forEach((m, i) => {
      const pawn = document.createElement('span');
      pawn.className = 'member-pawn';
      pawn.textContent = String(m.spotIds.indexOf(spot.id) + 1);
      pawn.title = m.name;
      pawn.style.background = m.color;
      pawn.style.width = '14px';
      pawn.style.height = '14px';
      pawn.style.fontSize = '8px';
      pawn.style.bottom = '-6px';
      pawn.style.left = (i * 12 - 6) + 'px';
      pawn.style.zIndex = '5';
      el.appendChild(pawn);
    });
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
  { cat: 'anime', label: CATEGORY_META.anime.label },
  { cat: 'shogun', label: CATEGORY_META.shogun.label },
  { cat: 'kyudo', label: CATEGORY_META.kyudo.label },
  { cat: 'sado', label: CATEGORY_META.sado.label },
  { cat: 'kado', label: CATEGORY_META.kado.label },
  { cat: 'shodo', label: CATEGORY_META.shodo.label },
  { cat: 'kodo', label: CATEGORY_META.kodo.label },
  { cat: 'zazen', label: CATEGORY_META.zazen.label },
  { cat: 'togei', label: CATEGORY_META.togei.label },
  { cat: 'kimono', label: CATEGORY_META.kimono.label },
  { cat: 'ninja', label: CATEGORY_META.ninja.label },
  { cat: 'train', label: CATEGORY_META.train.label },
  { cat: 'enmusubi', label: CATEGORY_META.enmusubi.label },
  { cat: 'police', label: CATEGORY_META.police.label },
  { cat: 'parking', label: CATEGORY_META.parking.label },
  { cat: 'restroom', label: CATEGORY_META.restroom.label },
  { cat: 'disaster', label: CATEGORY_META.disaster.label },
];

// 分類越加越多（目前 20+ 個），改用下拉選單，不然分類清單自己就佔掉
// 一大片空間，把下面的景點清單、已選景點都往下擠。
function renderTabs() {
  const wrap = document.getElementById('tabs');
  wrap.innerHTML = '';

  const select = document.createElement('select');
  select.className = 'tab-select';
  select.setAttribute('aria-label', '選擇分類');
  TABS.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.cat;
    opt.textContent = t.label;
    if (activeCategory === t.cat) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => {
    appLog('info', 'ui', `切換分類 → ${select.value}`);
    activeCategory = select.value;
    renderList();
    updateMarkerVisibility();
    fitToVisibleSpots();
  });
  wrap.appendChild(select);
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
  appLog('info', 'ui', `開啟景點 ${spotId}${spot ? ' ' + spot.name : '（找不到這個 id）'}`);
  if (spot) pushViewing(spot.id);
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
    ${buildBookingBox(spot)}
    <div class="detail-desc">${spot.desc}</div>
    <a class="detail-link" href="${buildPlaceUrl(spot)}" target="_blank" rel="noopener noreferrer">📍 在 Google 地圖上看（照片・評價・營業時間）</a>
    ${buildSupplyBox(spot)}
  `;
  bindSupplyBox(panel);
  if (mapIsVisible()) {
    map.flyTo({ center: [spot.lng, spot.lat], zoom: 14.5, duration: 600 });
  }
  if (mobileQuery.matches) openDetailSheet();
  renderList();
  updateMarkerVisibility();
}

// ---------- 天災時最近的補給點 ----------
// 天災時我們不一定在飯店，可能在山上景點等救援，所以每個景點都列出最近的
// 「災害求生」點；也可以用手機定位找（人在兩個景點中間時用）。
// 用 function 宣告（會被提升），不會踩到 TDZ。
function nearestSupplies(from, excludeId, n) {
  return SPOTS
    .filter(s => s.categories.includes('disaster') && s.id !== excludeId)
    .map(s => ({ s, km: distanceKm(from, s) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, n);
}

function supplyListHtml(from, excludeId) {
  const near = nearestSupplies(from, excludeId, 3);
  if (!near.length) return '<div class="supply-empty">還沒有收錄補給點</div>';
  const far = near[0].km > 8
    ? '<div class="supply-far">⚠️ 附近 8 公里內還沒有收錄補給點，可以先找附近的便利商店。如果人在山區，遇到天災不要硬走下山，先打 119 或 110，照救援人員指示原地等待，省著用水和手機電量。</div>'
    : '';
  const items = near.map(({ s, km }) => `
    <li><button type="button" class="supply-name" data-supply="${s.id}">${s.name}</button>
      <span class="supply-meta">直線 ${formatDistance(km)}${s.hours ? '・' + s.hours : ''}</span>
      <a class="supply-go" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=walking" target="_blank" rel="noopener noreferrer">🧭 導航</a></li>`).join('');
  return `${far}<ol class="supply-list">${items}</ol>`;
}

function buildSupplyBox(spot) {
  return `
    <details class="supply-box"${spot.categories.includes('disaster') ? '' : ' open'}>
      <summary>🆘 天災時離這裡最近的補給點（食物・水・災難包）</summary>
      ${spot.id === DISASTER_ROUTE.fromSpot ? buildRouteStops() : ''}
      <div class="supply-body">${supplyListHtml(spot, spot.id)}</div>
      <button type="button" class="supply-gps">📡 用我現在的位置找，直接開 Google 導航</button>
      <div class="supply-gps-result"></div>
    </details>`;
}

// 颱風、地震時常常會斷網，所以有網路時先把「飯店＋採購路線上那幾家店」
// 周圍的底圖圖磚存進手機（kyoto-tiles-pinned，sw.js 不會自動清掉它），
// 斷網時地圖上的愛心旁邊照樣看得到街道。愛心本身是 DOM 元素，
// 資料在 data.js（已經離線快取），本來就不用網路。
const PIN_TILE_CACHE = 'kyoto-tiles-pinned';
function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const r = lat * Math.PI / 180;
  return {
    x: Math.floor((lng + 180) / 360 * n),
    y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n),
  };
}
async function precacheDisasterTiles() {
  try {
    if (!navigator.onLine || !('caches' in window) || typeof DISASTER_ROUTE === 'undefined') return;
    const pts = [DISASTER_ROUTE.fromSpot, ...(DISASTER_ROUTE.stops || [])]
      .map(id => SPOTS.find(s => s.id === id)).filter(Boolean);
    if (!pts.length) return;
    const pad = 0.012;   // 往外多抓約 1 公里
    const minLat = Math.min(...pts.map(p => p.lat)) - pad, maxLat = Math.max(...pts.map(p => p.lat)) + pad;
    const minLng = Math.min(...pts.map(p => p.lng)) - pad, maxLng = Math.max(...pts.map(p => p.lng)) + pad;
    const urls = [];
    for (const [id, def] of Object.entries(map.getStyle().sources)) {
      const src = map.getSource(id);
      if (def.type !== 'vector' || !src || !src.tiles) continue;
      const maxZ = Math.min(src.maxzoom ?? 14, 16);   // 超過來源最大層級時地圖會自己放大用，不用另外抓
      for (let z = 10; z <= maxZ; z++) {
        const a = lngLatToTile(minLng, maxLat, z), b = lngLatToTile(maxLng, minLat, z);
        for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) {
          urls.push(src.tiles[0].replace('{z}', z).replace('{x}', x).replace('{y}', y));
        }
      }
    }
    const cache = await caches.open(PIN_TILE_CACHE);
    let got = 0;
    for (const url of urls) {
      if (await cache.match(url)) continue;
      const res = await fetch(url);
      if (res.ok) { await cache.put(url, res); got++; }
    }
    appLog('info', '地圖', `天災採購路線離線底圖：共 ${urls.length} 張，這次新存 ${got} 張`);
  } catch (err) {
    appLog('warn', '地圖', `天災採購路線離線底圖存不了：${err.message}`);
  }
}

// 飯店出發的採購路線：按鈕＋依序經過的店（地圖上是閃爍愛心）
function buildRouteStops() {
  const stops = (DISASTER_ROUTE.stops || [])
    .map(id => SPOTS.find(s => s.id === id)).filter(Boolean)
    .map(s => `<li><button type="button" class="supply-name" data-supply="${s.id}">${s.name}</button>${s.hours ? `<span class="supply-meta">${s.hours}</span>` : ''}</li>`)
    .join('');
  return `<a class="supply-route" href="${DISASTER_ROUTE.url}" target="_blank" rel="noopener noreferrer">${DISASTER_ROUTE.label}</a>
    ${stops ? `<div class="supply-gps-note">路線依序經過（地圖上的 💗 閃爍愛心）：</div><ol class="supply-list">${stops}</ol>` : ''}`;
}

function bindSupplyBox(root) {
  root.querySelectorAll('[data-supply]').forEach(btn =>
    btn.addEventListener('click', () => showDetail(btn.dataset.supply)));
  const gpsBtn = root.querySelector('.supply-gps');
  if (!gpsBtn) return;
  gpsBtn.addEventListener('click', () => {
    const out = root.querySelector('.supply-gps-result');
    if (!navigator.geolocation) { out.textContent = '這支手機的瀏覽器不支援定位'; return; }
    out.textContent = '定位中…（第一次會問要不要允許位置，請按允許）';
    // 定位要等幾秒，等完才開新分頁會被瀏覽器當成彈跳視窗擋掉，
    // 所以按下去當下就先開一個空白分頁，定位好再把它導到 Google 導航。
    const win = window.open('', '_blank');
    if (win) win.document.write('<p style="font-size:20px;padding:20px">📡 定位中，找最近的補給點…</p>');
    navigator.geolocation.getCurrentPosition(pos => {
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      appLog('info', 'supply', `用定位找補給點 ${here.lat.toFixed(4)},${here.lng.toFixed(4)}`);
      out.innerHTML = '<div class="supply-gps-note">已開 Google 導航到第 1 個；想改去別家，點下面的「🧭 導航」：</div>' + supplyListHtml(here, null);
      out.querySelectorAll('[data-supply]').forEach(btn =>
        btn.addEventListener('click', () => showDetail(btn.dataset.supply)));
      // 人在飯店附近：直接開家人事先規劃好的採購路線
      const home = SPOTS.find(s => s.id === DISASTER_ROUTE.fromSpot);
      if (home && distanceKm(here, home) <= DISASTER_ROUTE.nearKm) {
        appLog('info', 'supply', `人在飯店附近（${formatDistance(distanceKm(here, home))}），開規劃好的採購路線`);
        out.innerHTML = `<div class="supply-gps-note">你在飯店附近，已開我們規劃好的採購路線。</div><a class="supply-route" href="${DISASTER_ROUTE.url}" target="_blank" rel="noopener noreferrer">${DISASTER_ROUTE.label}</a>`;
        if (win && !win.closed) win.location.href = DISASTER_ROUTE.url;
        else location.href = DISASTER_ROUTE.url;
        return;
      }
      const nearest = nearestSupplies(here, null, 1)[0];
      if (!nearest) { if (win) win.close(); return; }
      const url = `https://www.google.com/maps/dir/?api=1&origin=${here.lat},${here.lng}&destination=${nearest.s.lat},${nearest.s.lng}&travelmode=walking`;
      appLog('info', 'supply', `開導航到 ${nearest.s.id} ${nearest.s.name}（${formatDistance(nearest.km)}）`);
      if (win && !win.closed) win.location.href = url;
      else location.href = url;
    }, err => {
      if (win) win.close();
      appLog('warn', 'supply', `定位失敗：${err.code} ${err.message}`);
      out.textContent = err.code === 1
        ? '沒有允許定位。請到瀏覽器設定把這個網站的「位置」改成允許，再按一次。'
        : '定位失敗（山區可能收不到 GPS），請改看上面依景點算的清單。';
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
}

// ---------- 多選與路線 ----------
function toggleSelect(spotId) {
  const idx = selectedIds.indexOf(spotId);
  if (idx >= 0) {
    selectedIds.splice(idx, 1);
  } else {
    selectedIds.push(spotId);
  }
  appLog('info', 'select', `${idx >= 0 ? '取消' : '勾選'} ${spotId}，目前共 ${selectedIds.length} 個：${selectedIds.join(',')}`);
  renderList();
  renderSelection();
  updateMarkerVisibility();
}

function renderSelection() {
  persistSelection();
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
  scheduleMemberSync();
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
  if (!NO_LIMIT_RE.test(hours)) return false;
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

// 括號裡才是真正的例外（例如伏見稻荷大社的「社務所 8:30–16:30」、
// 京都車站的「各店家營業時間不一」）。括號外的「24小時開放」本身
// 不是限制，講出來只會讓人分心，紫牛法則：只講有限制的部分，
// 沒有限制的事情不用提。
function extractRestrictionNote(hours) {
  const m = (hours || '').match(/[（(]([^）)]+)[）)]/);
  return m ? m[1] : null;
}

// 營業／開放時間。沒有資料時要明講，不要讓人誤以為「沒寫＝隨時可以去」
function buildHours(spot) {
  // 純粹「24 小時開放」沒有任何限制，不需要標示營業時間
  if (spot.hours && hasNoRealTimeRestriction(spot.hours)) return '';
  // 需要預約／申請但沒收錄時段的景點（例如西芳寺），不要顯示
  // 「營業時間未收錄」——那是在講沒有限制的事，而且會把注意力
  // 導去查營業時間，但這種地方真正的限制是「不事前申請就進不去」。
  // 黃色的預約提醒才是重點，要預約什麼則寫在介紹裡。
  if (!spot.hours && spot.booking) return '';
  // 需要預約／申請的景點，如果同時有真正的限制時段，時段也一起用
  // 黃色提醒，兩個警示互相呼應
  const needsBooking = spot.booking ? ' detail-hours-booking' : '';
  if (spot.hours) {
    // 24小時開放＋括號例外時，只顯示例外本身，不重複講「24小時開放」
    const isAllDay = NO_LIMIT_RE.test(spot.hours);
    const displayHours = (isAllDay && extractRestrictionNote(spot.hours)) || spot.hours;
    return `<div class="detail-hours${needsBooking}">🕘 ${displayHours}
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
  appLog('info', 'ui', '開啟「行前準備」');
  activeSpotId = null;
  document.getElementById('detailBody').innerHTML = `
    <div class="detail-header"><h2>${TRIP_PREP.title}</h2></div>
    <button type="button" class="ask-play-btn" id="packingBtn">${PACKING_LIST.title}（打開來勾選）</button>
    <div class="detail-area">${TRIP_PREP.note}</div>
    ${TRIP_PREP.groups.map(g => `
      <div class="prep-group">
        <h3>${g.heading}</h3>
        <ul>${g.items.map(item => `<li>${item}</li>`).join('')}</ul>
      </div>`).join('')}
  `;
  document.getElementById('packingBtn').addEventListener('click', showPacking);
  if (mobileQuery.matches) openDetailSheet();
  renderList();
  updateMarkerVisibility();
}

// 出國準備清單：勾選狀態存在這支手機（每個人勾自己的行李），用項目文字當 key
const PACKING_KEY = 'kyotoMapPacking';
function loadPacking() {
  try { return JSON.parse(localStorage.getItem(PACKING_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function savePacking(done) {
  try { localStorage.setItem(PACKING_KEY, JSON.stringify(done)); } catch (e) { /* 私密瀏覽存不了，只是下次不會記得 */ }
}

function showPacking() {
  appLog('info', 'ui', '開啟「出國準備清單」');
  activeSpotId = null;
  const done = loadPacking();
  const all = PACKING_LIST.groups.flatMap(g => g.items);
  const count = () => all.filter(t => done[t]).length;
  document.getElementById('detailBody').innerHTML = `
    <div class="detail-header"><h2>${PACKING_LIST.title}</h2></div>
    <div class="detail-area">${PACKING_LIST.note}</div>
    <div class="packing-progress">已準備 <b id="packingCount">${count()}</b> / ${all.length}</div>
    ${PACKING_LIST.groups.map(g => `
      <div class="prep-group">
        <h3>${g.heading}</h3>
        <ul class="tax-checklist">
          ${g.items.map(t => `
            <li class="${done[t] ? 'done' : ''}">
              <label><input type="checkbox" class="packing-check" data-item="${t}"${done[t] ? ' checked' : ''}><span>${t}</span></label>
            </li>`).join('')}
        </ul>
      </div>`).join('')}
    <div class="prep-group">
      <h3>✈️ 打包提醒</h3>
      <ul>${PACKING_LIST.tips.map(t => `<li>${t}</li>`).join('')}</ul>
    </div>
    <div class="packing-actions">
      <button type="button" class="share-btn" id="packingBack">↩️ 回到行前準備</button>
      <button type="button" class="share-btn" id="packingReset">全部取消勾選</button>
    </div>
  `;
  document.querySelectorAll('.packing-check').forEach(box => {
    box.addEventListener('change', () => {
      const item = box.dataset.item;
      if (box.checked) done[item] = true; else delete done[item];
      savePacking(done);
      box.closest('li').classList.toggle('done', box.checked);
      document.getElementById('packingCount').textContent = count();
    });
  });
  document.getElementById('packingBack').addEventListener('click', showPrep);
  document.getElementById('packingReset').addEventListener('click', () => {
    if (!confirm('確定要把出國準備清單全部取消勾選嗎？')) return;
    savePacking({});
    appLog('info', 'ui', '出國準備清單全部取消勾選');
    showPacking();
  });
  if (mobileQuery.matches) openDetailSheet();
  renderList();
  updateMarkerVisibility();
}

// 日語求助小抄
function showPhrases() {
  appLog('info', 'ui', '開啟「日語小抄」');
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
            <a href="tel:${(e.dial || e.number).replace(/[^0-9+]/g, '')}">${e.number}</a>
            <b>${e.label}</b>
            <span>${e.note}</span>
          </li>`).join('')}
      </ul>
      <details class="lion-offices">
        <summary>🌏 雄獅旅遊其他國外據點（點開看）</summary>
        <ul class="phrase-tel">
          ${PHRASES.lionOffices.map(e => `
            <li>
              <a href="tel:${(e.dial || e.number).replace(/[^0-9+]/g, '')}">${e.number}</a>
              <b>雄獅旅遊 ${e.label}</b>${e.dial ? `<span>人在當地時點號碼，會撥 ${e.dial}</span>` : ''}
            </li>`).join('')}
        </ul>
      </details>
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

// 退稅小幫手：結帳前播放／出示日語，結帳後照清單勾一次，確保真的辦到免稅
function showTaxRefund() {
  appLog('info', 'ui', '開啟「退稅小幫手」');
  activeSpotId = null;
  const p = TAX_REFUND.phrase;
  document.getElementById('detailBody').innerHTML = `
    <div class="detail-header"><h2>${TAX_REFUND.title}</h2></div>
    <div class="detail-area">${TAX_REFUND.note}</div>

    <div class="phrase-address">
      <div class="phrase-address-label">${p.label}</div>
      <div class="phrase-ja phrase-ja-big">${p.ja}</div>
      <div class="phrase-sound">${p.romaji}</div>
      <div class="phrase-sound">${p.sound}</div>
      <button type="button" class="ask-play-btn" id="taxPlayBtn">🔊 播放日語</button>
      <div class="ask-warning" id="taxWarning" hidden></div>
      <div class="phrase-tip">${p.tip}</div>
    </div>

    <div class="prep-group">
      <h3>✅ 結帳確認清單（<span id="taxProgress">0</span> / ${TAX_REFUND.checklist.length} 完成）</h3>
      <ul class="tax-checklist">
        ${TAX_REFUND.checklist.map((item, i) => `
          <li>
            <label>
              <input type="checkbox" class="tax-check" data-idx="${i}">
              <span>${item}</span>
            </label>
          </li>`).join('')}
      </ul>
    </div>
  `;

  document.getElementById('taxPlayBtn').addEventListener('click', (e) => speakJapanese(p.ja, 'taxWarning', e.currentTarget));

  const progress = document.getElementById('taxProgress');
  document.querySelectorAll('.tax-check').forEach(box => {
    box.addEventListener('change', () => {
      box.closest('li').classList.toggle('done', box.checked);
      progress.textContent = document.querySelectorAll('.tax-check:checked').length;
    });
  });

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
  appLog('info', 'select', `按「清除選取」，清掉 ${selectedIds.length} 個：${selectedIds.join(',')}`);
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
    '景點清單、日語小抄、行前準備、退稅小幫手都還正常，可以照常使用。<br>' +
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

// ---------- 用連結分享清單 ----------
// 把勾選的景點直接編進網址（#list=t30,v01,j09），用 LINE 傳給家人，
// 對方一點開就載入同一份清單。不需要帳號、不需要後端、不花錢，
// 而且連結本身就是資料，在日本網路不穩時也不會因為連不到服務而失效。

const MAX_SHARED_SPOTS = 60;   // 跟 Firebase 那條路徑一致，避免網址過長

function buildListUrl() {
  const base = location.origin + location.pathname;
  return base + '#list=' + selectedIds.slice(0, MAX_SHARED_SPOTS).join(',');
}

// 只接受確實存在的景點 id，順序照網址上的順序（順序會影響路線）
function parseListFromHash(hash, key = 'list') {
  const m = new RegExp('[#&]' + key + '=([^&]*)').exec(hash || '');
  if (!m) return null;
  const ids = decodeURIComponent(m[1]).split(',')
    .map(s => s.trim())
    .filter(id => SPOTS.some(s => s.id === id));
  return ids.slice(0, MAX_SHARED_SPOTS);
}

// 套用完就把 #list= / #order= 從網址拿掉：選點現在會存在手機裡，
// 不拿掉的話每次重新整理都會再套用一次，把之後自己改過的選點蓋回去
function clearShareHash() {
  try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* 舊瀏覽器就算了 */ }
}

// 開啟網頁時如果網址帶著清單，就直接套用
//   #list=…   別人分享的整份清單（會取代目前的選點）
//   #order=…  家人的導遊建議的新順序（只重新排列，不新增、不刪除）
function applyListFromUrl() {
  const order = parseListFromHash(location.hash, 'order');
  if (order && order.length) {
    applyOrderFromUrl(order);
    clearShareHash();
    return;
  }
  const ids = parseListFromHash(location.hash);
  if (!ids || !ids.length) return;
  appLog('info', 'select', `從分享連結載入清單 ${ids.length} 個（原本 ${selectedIds.length} 個被取代）：${ids.join(',')}`);
  selectedIds = ids;
  renderList();
  renderSelection();
  updateMarkerVisibility();
  fitToVisibleSpots();
  clearShareHash();
  shareMessage('<p class="share-note share-note-ok">已載入分享的清單，共 ' + ids.length +
    ' 個景點。你可以直接用，也可以改完之後再按「🔗 用連結分享」傳回去。</p>');
}

function applyOrderFromUrl(order) {
  let note;
  if (!selectedIds.length) {
    // 這台手機還沒選過（例如換了新手機），連結裡就是他原本的整份清單，直接用
    selectedIds = order.slice();
    appLog('info', 'select', `從建議順序連結載入 ${order.length} 個（這台手機原本沒有選點）：${order.join(',')}`);
    note = `已載入家人建議的順路順序，共 ${order.length} 個景點。`;
  } else {
    const next = reorderKeepAll(selectedIds, order);
    const kept = selectedIds.filter(id => !order.includes(id));
    const skipped = order.filter(id => !selectedIds.includes(id));
    if (next.join(',') === selectedIds.join(',')) {
      note = '你的順序已經跟建議的一樣了，不用調整。';
    } else {
      selectedIds = next;
      appLog('info', 'select', `套用家人傳來的建議順序：${next.join(',')}（保留：${kept.join(',') || '無'}，略過：${skipped.join(',') || '無'}）`);
      note = `已照建議把你的 ${next.length} 個景點重新排順序（只改順序，沒有刪掉任何景點）。`;
    }
    if (kept.length) note += `建議裡沒有的「${spotNames(kept).join('、')}」保留在最後面。`;
    if (skipped.length) note += `連結裡的「${spotNames(skipped).join('、')}」你已經沒選了，沒有幫你加回去。`;
  }
  renderList();
  renderSelection();
  updateMarkerVisibility();
  fitToVisibleSpots();
  shareMessage('<p class="share-note share-note-ok">' + note + '</p>');
}

async function shareByLink() {
  if (!selectedIds.length) {
    shareMessage('<p class="share-note">還沒有勾選任何景點。先在清單上勾幾個，再回來分享。</p>');
    return;
  }
  const url = buildListUrl();
  const text = '京都行程清單（' + selectedIds.length + ' 個景點）';

  // 手機上叫出系統分享選單，可以直接選 LINE
  if (navigator.share) {
    try {
      await navigator.share({ title: '京都行程景點地圖', text, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // 使用者自己取消，不算失敗
    }
  }
  // 沒有系統分享就複製到剪貼簿
  try {
    await navigator.clipboard.writeText(url);
    shareMessage('<p class="share-note share-note-ok">連結已複製，貼到 LINE 傳給家人就可以了。</p>' +
      '<p class="share-note share-link-text">' + url + '</p>');
  } catch (err) {
    // 連剪貼簿都不能用時，至少讓人看得到、可以手動複製
    shareMessage('<p class="share-note">請手動複製這個連結傳給家人：</p>' +
      '<p class="share-note share-link-text">' + url + '</p>');
  }
}

// ---------- 分享的共用基礎設施（Firebase Firestore）----------
// 下面的浮出視窗跟 Firestore 連線，是「用連結分享」的複製結果提示，
// 跟再往下的「跳棋」都會用到，所以留在這裡共用。
// Firebase SDK 用動態 import 從 CDN 載入，只有真的要用時才下載，
// 不影響首次開啟速度，也不會影響離線功能。

const shareState = { db: null, auth: null, loading: false };
const FIREBASE_SDK_BASE = 'https://www.gstatic.com/firebasejs/10.14.1';

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

// Firestore 跟登入（Auth）共用同一個 Firebase app 實例，只能初始化一次，
// 所以拆出這個共用的取得函式，兩邊都透過它拿 app，不會各自重複 initializeApp。
let firebaseAppPromise = null;
async function getFirebaseApp() {
  if (!SHARE_CONFIG.firebaseConfig) throw new Error('尚未設定 Firebase');
  if (navigator.onLine === false) throw new Error('目前沒有網路');
  if (!firebaseAppPromise) {
    firebaseAppPromise = import(`${FIREBASE_SDK_BASE}/firebase-app.js`)
      .then(({ initializeApp, getApps, getApp }) => (getApps().length ? getApp() : initializeApp(SHARE_CONFIG.firebaseConfig)));
  }
  return firebaseAppPromise;
}

// 需要時才連線，連好之後重複使用
async function getFirestore() {
  if (shareState.db) return shareState.db;
  const app = await getFirebaseApp();
  const firestore = await import(`${FIREBASE_SDK_BASE}/firebase-firestore.js`);
  shareState.db = { ...firestore, instance: firestore.getFirestore(app) };
  return shareState.db;
}

// 跳棋改用 Google 登入之後才需要的 Auth SDK，一樣只在真的要用時才載入
async function getAuthSvc() {
  if (shareState.auth) return shareState.auth;
  const app = await getFirebaseApp();
  const authApi = await import(`${FIREBASE_SDK_BASE}/firebase-auth.js`);
  shareState.auth = { ...authApi, instance: authApi.getAuth(app) };
  return shareState.auth;
}

shareEl('shareLinkBtn').addEventListener('click', shareByLink);
shareEl('shareClose').addEventListener('click', () => closeShare());
shareEl('memberLogBtn').addEventListener('click', showMemberLog);

// ---------- 跳棋：即時顯示每個人選了什麼（Firebase Firestore + Google 登入）----------
// 跟上面「共享清單」不一樣：那個要手動存、手動開才看得到對方的清單；
// 這個是登入之後，選點會自動同步，其他家人不用做任何動作，地圖上就會
// 自動多一顆屬於那個人的棋子。
//
// 身份用 Google 帳號的 uid 當 Firestore 文件 ID（不是自己打的名字）。
// 舊版是拿使用者自己打的名字當識別碼，結果兩個人不小心打了同一個名字，
// 後寫入的那筆會直接覆蓋前面的資料，選點就無預警消失了——這是改用
// Google 登入的原因：uid 是 Google 帳號保證唯一的值，不會再撞名。
// 顯示用的「名字」還是可以自己改（見「改名字」），但只是顯示標籤，
// 不再是識別身份的依據。

const MEMBER_KEY = 'kyotoMemberIdentity';
let memberIdentity = loadMemberIdentity();   // { id, name, color } 或 null，id 現在是 Google uid

// 這個瀏覽器/裝置的隨機代號，只是為了除錯記錄能分辨「是同一支手機還是
// 不同裝置在寫同一個名字」，不是身份驗證，換瀏覽器或清資料就會變新的。
const DEVICE_KEY = 'kyotoDeviceId';
function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = 'dev-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch (err) {
    return 'dev-unknown';
  }
}
let membersListening = false;
let memberSyncTimer = null;

function loadMemberIdentity() {
  try {
    const raw = localStorage.getItem(MEMBER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function saveMemberIdentity() {
  try { localStorage.setItem(MEMBER_KEY, JSON.stringify(memberIdentity)); }
  catch (err) { /* 存不了就算了，不影響其他功能，只是換裝置要重新設定 */ }
}

// 同一個名字每次都要算出同一個顏色，這樣離線、或還沒查到 Firestore
// 資料之前，也不會亂跳色
function hashName(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// 舊版（打名字當識別碼）留下的文件 ID 都很短（中文名字最多10個字），
// 真正的 Google uid 一定是 28 個字的英數字，用這個粗略但夠用的方式
// 分辨「這是舊資料、可以認領」還是「這已經是 uid-based 的新資料」。
function looksLikeLegacyMemberId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 12;
}

// 登入後，如果這個 Google 帳號還沒有自己的資料，看看有沒有舊版留下、
// 還沒被認領的名字（哥、秀容、妹妹...），讓使用者自己選「這是不是我」，
// 選中的話直接把舊資料（選點、顏色）接過來，不用重新選一次。
// 回傳 { name, color, spotIds } 或 null（使用者選「都不是」或沒有舊資料可選）。
function offerLegacyClaim(candidates) {
  return new Promise((resolve) => {
    const body = shareEl('shareBody');
    body.innerHTML = '';

    const title = document.createElement('p');
    title.className = 'share-note';
    title.textContent = '第一次用 Google 登入——你是不是下面哪一位？選一下的話，之前選的景點會直接接過來，不用重選。';
    body.appendChild(title);

    candidates.forEach(c => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'share-btn share-btn-primary';
      btn.style.marginBottom = '6px';
      btn.textContent = `我是「${c.name}」`;
      btn.addEventListener('click', () => { closeShare(); resolve(c); });
      body.appendChild(btn);
    });

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'share-btn';
    skipBtn.textContent = '都不是，我是新加入的';
    skipBtn.addEventListener('click', () => { closeShare(); resolve(null); });
    body.appendChild(skipBtn);

    openShare();
    if (!history.state || !history.state.share) history.pushState({ share: true }, '');
  });
}

// 登入成功、確定拿到 Google user 之後：讀取（或建立）這個 uid 對應的
// Firestore 身份文件，第一次登入時視情況跑一次「認領舊資料」的流程。
// signInWithPopup 完成後，Firebase 自己的 onAuthStateChanged 也會幾乎同時
// 觸發一次，兩邊都可能呼叫這個函式處理同一次登入；用這個旗標擋掉重複
// 執行，不然「認領舊資料」的選單可能會被觸發兩次、或寫入兩次一樣的資料。
let loadingMemberForUid = null;
async function loadOrCreateMemberDoc(user) {
  if (loadingMemberForUid === user.uid) return;
  loadingMemberForUid = user.uid;
  ownSelectionReconciled = false;
  let pushNeeded = true;
  try {
    const db = await getFirestore();
    const ref = db.doc(db.instance, 'trips', SHARE_CONFIG.tripId, 'members', user.uid);
    const snap = await db.getDoc(ref);

    if (snap.exists()) {
      const data = snap.data();
      memberIdentity = {
        id: user.uid,
        name: data.name || (user.displayName ? user.displayName.slice(0, 10) : '我'),
        color: data.color || MEMBER_COLORS[hashName(user.uid) % MEMBER_COLORS.length],
      };
      pushNeeded = reconcileOwnSelection(data) === 'push';
    } else {
      ownSelectionReconciled = true;   // 雲端沒有這個人的資料，這台手機的就是最新的
      let claimed = null;
      try {
        const all = await db.getDocs(db.collection(db.instance, 'trips', SHARE_CONFIG.tripId, 'members'));
        const candidates = [];
        all.forEach(docSnap => {
          if (looksLikeLegacyMemberId(docSnap.id)) candidates.push({ id: docSnap.id, ...docSnap.data() });
        });
        if (candidates.length) claimed = await offerLegacyClaim(candidates);
      } catch (err) {
        console.warn('[跳棋] 查詢舊資料失敗，當作新加入處理：', err);
      }

      const name = (claimed && claimed.name) || (user.displayName ? user.displayName.slice(0, 10) : '我');
      const color = (claimed && claimed.color) || MEMBER_COLORS[hashName(user.uid) % MEMBER_COLORS.length];
      memberIdentity = { id: user.uid, name, color };

      // 只有在這台裝置目前還沒自己選任何景點時，才把認領到的舊選點接過來，
      // 避免蓋掉使用者這台裝置上正在選、還沒同步的東西
      if (claimed && Array.isArray(claimed.spotIds) && claimed.spotIds.length && !selectedIds.length) {
        selectedIds = claimed.spotIds.filter(id => SPOTS.some(s => s.id === id));
        appLog('info', 'select', `登入後接回舊名字「${claimed.name}」的選點 ${selectedIds.length} 個`);
        renderList();
        renderSelection();
        updateMarkerVisibility();
      }

      if (claimed) {
        try {
          const db2 = await getFirestore();
          await db2.deleteDoc(db2.doc(db2.instance, 'trips', SHARE_CONFIG.tripId, 'members', claimed.id));
        } catch (err) {
          console.warn('[跳棋] 清除已認領的舊資料失敗（不影響這次登入）：', err);
        }
      }
    }

    saveMemberIdentity();
    renderMemberBox();
    // renderSelection()（前面接舊選點時可能呼叫過）會透過 scheduleMemberSync()
    // 排一個延遲寫入，這裡改成立刻寫一次，記得取消那個排程，不然會白白多寫一次。
    // 雲端的比較新（已經拿回來）就不用寫，免得白白改到雲端的更新時間。
    clearTimeout(memberSyncTimer);
    if (pushNeeded) pushMemberDoc();
    startMembersListener();
  } catch (err) {
    console.warn('[跳棋] 登入後讀取/建立身份失敗：', err);
    alert('登入成功，但連線資料失敗，請確認網路連線後重新整理頁面再試一次。');
  } finally {
    loadingMemberForUid = null;
  }
}

async function signInWithGoogle() {
  let auth;
  try {
    auth = await getAuthSvc();
  } catch (err) {
    console.warn('[跳棋] 無法載入登入功能：', err);
    alert('目前無法使用登入功能，請確認網路連線後再試一次。');
    return;
  }

  // 這裡拿到登入結果後不直接處理，交給下面已經註冊好的 onAuthStateChanged
  // 監聽器去呼叫 loadOrCreateMemberDoc——避免這裡跟監聽器同時各呼叫一次，
  // 導致「認領舊資料」選單跳兩次或寫入兩次一樣的資料。
  const provider = new auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(auth.instance, provider);
  } catch (err) {
    if (err && err.code === 'auth/popup-closed-by-user') return;   // 自己關掉的，不用顯示錯誤
    if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request')) {
      try { await auth.signInWithRedirect(auth.instance, provider); return; }
      catch (redirectErr) { console.warn('[跳棋] 登入導向也失敗：', redirectErr); }
    }
    console.warn('[跳棋] Google 登入失敗：', err);
    const inAppBrowser = err && (err.code === 'auth/operation-not-supported-in-this-environment' || err.code === 'auth/disallowed-useragent');
    alert(inAppBrowser
      ? '這個瀏覽器（可能是 LINE 或其他 App 內建的瀏覽器）不支援 Google 登入，請點右上角選單選「用瀏覽器開啟」或「在 Chrome 中開啟」，再回來登入一次。'
      : '登入失敗，請確認網路連線後再試一次。');
  }
}

// 改的只是顯示用的名字標籤，不會影響登入身份，也不會像舊版一樣變成
// 另一個獨立身份——現在身份是綁在 Google 帳號上的。
function renameDisplayName() {
  if (!memberIdentity) return;
  const raw = prompt('改成什麼名字？（只是顯示用，其他家人會看到這個名字）', memberIdentity.name);
  if (raw === null) return;
  const name = raw.trim().slice(0, 10);
  if (!name) return;
  memberIdentity.name = name;
  saveMemberIdentity();
  renderMemberBox();
  pushMemberDoc();
}

// 手動刪除自己這個跳棋身份（例如測試用的帳號），不會影響其他人的資料。
// 刪除之後會一併登出，回到「登入」畫面，不會留在一個看起來已登入、
// 但資料已經沒了的奇怪狀態。
async function deleteMemberIdentity() {
  if (!memberIdentity) return;
  const { id, name } = memberIdentity;
  if (!confirm(`確定要刪除跳棋身份「${name}」嗎？其他家人會看不到這個身份的選點，你也會被登出。`)) return;

  try {
    const db = await getFirestore();
    await db.deleteDoc(db.doc(db.instance, 'trips', SHARE_CONFIG.tripId, 'members', id));
    logMemberEvent('delete', id, name, {});
  } catch (err) {
    console.warn('[跳棋] 刪除失敗：', err);
    alert('刪除失敗，請確認網路連線後再試一次。');
    return;
  }

  memberIdentity = null;
  saveMemberIdentity();
  renderMemberBox();
  try {
    const auth = await getAuthSvc();
    await auth.signOut(auth.instance);
  } catch (err) {
    // 登出失敗也無所謂，本機的身份狀態已經清掉了
  }
}

function renderMemberBox() {
  const me = shareEl('memberMe');
  if (!me) return;
  me.innerHTML = '';

  if (!memberIdentity) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'share-btn share-btn-primary';
    btn.textContent = '🔑 用 Google 帳號登入設定跳棋';
    btn.addEventListener('click', signInWithGoogle);
    me.appendChild(btn);
    shareEl('memberOthers').innerHTML = '';
    renderJointList();
    return;
  }

  const tag = document.createElement('div');
  tag.className = 'member-name-tag';
  const dot = document.createElement('span');
  dot.className = 'member-dot';
  dot.style.background = memberIdentity.color;
  const label = document.createElement('span');
  label.innerHTML = `你是 <b>${memberIdentity.name}</b>`;
  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'share-btn';
  renameBtn.style.flex = 'none';
  renameBtn.style.padding = '4px 8px';
  renameBtn.textContent = '✏️';
  renameBtn.title = '改顯示名字';
  renameBtn.addEventListener('click', renameDisplayName);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'share-btn';
  deleteBtn.style.flex = 'none';
  deleteBtn.style.padding = '4px 8px';
  deleteBtn.textContent = '🗑️';
  deleteBtn.title = '刪除這個跳棋身份';
  deleteBtn.addEventListener('click', deleteMemberIdentity);

  tag.appendChild(dot);
  tag.appendChild(label);
  tag.appendChild(renameBtn);
  tag.appendChild(deleteBtn);
  me.appendChild(tag);

  const colors = document.createElement('div');
  colors.className = 'member-colors';
  MEMBER_COLORS.forEach(c => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'member-color-swatch' + (c === memberIdentity.color ? ' active' : '');
    sw.style.background = c;
    sw.title = '換成這個顏色';
    sw.addEventListener('click', () => {
      memberIdentity.color = c;
      saveMemberIdentity();
      renderMemberBox();
      pushMemberDoc();
    });
    colors.appendChild(sw);
  });
  me.appendChild(colors);

  renderOthersList();
  renderJointList();
}

function renderOthersList() {
  const wrap = shareEl('memberOthers');
  if (!wrap) return;
  wrap.innerHTML = '';
  const others = Object.values(othersState);
  if (!others.length) {
    wrap.textContent = memberIdentity ? '目前還沒有其他家人設定跳棋。' : '';
    return;
  }
  others.forEach(m => {
    const row = document.createElement('div');
    row.className = 'member-others-row';
    const dot = document.createElement('span');
    dot.className = 'member-dot';
    dot.style.background = m.color;
    const text = document.createElement('span');
    const n = Array.isArray(m.spotIds) ? m.spotIds.length : 0;
    text.textContent = `${m.name}（已選 ${n} 個景點）`;
    row.appendChild(dot);
    row.appendChild(text);
    wrap.appendChild(row);
  });
}

// ---------- 共同選點（統整跳棋大家目前選了什麼）----------
// 取代原本要手動存、手動開的「分享清單」：這裡直接用跳棋已經同步好的
// 資料，自動列出「誰選了哪個景點」，兩人以上重疊的排最上面，方便討論
// 共同行程時一眼看出大家都想去的地方。
function renderJointList() {
  const wrap = shareEl('jointList');
  if (!wrap) return;
  wrap.innerHTML = '';

  if (!memberIdentity) {
    wrap.innerHTML = '<p class="share-note">設定跳棋名字後，這裡會自動列出大家選了哪些景點。</p>';
    return;
  }

  const tally = {};   // spotId -> [{ name, color }]
  selectedIds.forEach(id => {
    (tally[id] = tally[id] || []).push({ name: memberIdentity.name, color: memberIdentity.color });
  });
  Object.values(othersState).forEach(m => {
    (m.spotIds || []).forEach(id => {
      (tally[id] = tally[id] || []).push({ name: m.name, color: m.color });
    });
  });

  const rows = Object.entries(tally)
    .map(([id, pickers]) => ({ spot: SPOTS.find(s => s.id === id), pickers }))
    .filter(r => r.spot)
    .sort((a, b) => b.pickers.length - a.pickers.length);

  if (!rows.length) {
    wrap.innerHTML = '<p class="share-note">目前還沒有人選景點。</p>';
    return;
  }

  rows.forEach(({ spot, pickers }) => {
    const row = document.createElement('div');
    row.className = 'joint-row' + (pickers.length >= 2 ? ' joint-row-hot' : '');
    row.addEventListener('click', () => showDetail(spot.id));

    const name = document.createElement('span');
    name.className = 'joint-spot-name';
    name.textContent = spot.name;

    const dots = document.createElement('span');
    dots.className = 'joint-dots';
    pickers.forEach(p => {
      const dot = document.createElement('span');
      dot.className = 'member-dot';
      dot.style.background = p.color;
      dot.title = p.name;
      dots.appendChild(dot);
    });

    row.appendChild(name);
    row.appendChild(dots);
    wrap.appendChild(row);
  });
}

// 拿到雲端上「自己」那份資料後，跟這台手機的選點比對一次（每次登入／開網頁一次）。
// 回傳 'push'（手機比較新或雲端還沒有，要上傳）/'adopted'（雲端比較新，已經拿回來）/'same'
function reconcileOwnSelection(cloud) {
  ownSelectionReconciled = true;
  if (!cloud) {
    appLog('info', '跳棋', `雲端還沒有我的資料，上傳這台手機的選點 ${selectedIds.length} 個`);
    return 'push';
  }
  const cloudIds = (Array.isArray(cloud.spotIds) ? cloud.spotIds : []).filter(id => SPOTS.some(s => s.id === id));
  const cloudAt = (cloud.updatedAt && typeof cloud.updatedAt.toMillis === 'function') ? cloud.updatedAt.toMillis() : 0;
  if (cloudIds.join(',') === selectedIds.join(',')) return 'same';
  if (selectionChangedAt > cloudAt) {
    appLog('info', '跳棋', `這台手機的選點比雲端新（手機 ${selectedIds.length} 個／雲端 ${cloudIds.length} 個），上傳手機的`);
    return 'push';
  }
  appLog('info', 'select', `雲端的選點比較新，拿回來 ${cloudIds.length} 個（這台手機原本 ${selectedIds.length} 個）：${cloudIds.join(',')}`);
  selectedIds = cloudIds;
  lastPersistedKey = cloudIds.join(',');
  selectionChangedAt = cloudAt;
  try { localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: selectedIds, at: cloudAt })); } catch (e) { /* ignore */ }
  renderList();
  renderSelection();
  updateMarkerVisibility();
  clearTimeout(memberSyncTimer);   // 內容跟雲端一樣，不用再寫回去
  return 'adopted';
}

// 告訴電視版「我現在在看哪個景點」。連續點好幾個景點時只寫最後一個。
function pushViewing(spotId) {
  if (!memberIdentity || viewingDisabled) return;
  clearTimeout(viewingTimer);
  viewingTimer = setTimeout(async () => {
    const uid = memberIdentity && memberIdentity.id;
    if (!uid) return;
    try {
      const db = await getFirestore();
      await db.setDoc(db.doc(db.instance, 'trips', SHARE_CONFIG.tripId, 'viewing', uid), { spotId, at: db.serverTimestamp() });
    } catch (err) {
      if (err && err.code === 'permission-denied') {
        // 規則還沒發布：這次開網頁就不再試，免得每點一個景點都失敗一次
        viewingDisabled = true;
        appLog('warn', '跳棋', '電視跟著看景點的功能還不能用（Firestore 規則還沒加上 viewing）');
      } else {
        console.warn('[跳棋] 告訴電視版目前在看哪個景點失敗：', err);
      }
    }
  }, 500);
}

// 選點有變動時就 debounce 一下再同步，避免連續勾選時瘋狂寫入
function scheduleMemberSync() {
  renderJointList();
  if (!memberIdentity || !ownSelectionReconciled) return;
  clearTimeout(memberSyncTimer);
  memberSyncTimer = setTimeout(pushMemberDoc, 800);
}

// 除錯用的同步記錄：每次成功寫入/刪除都留一筆，這樣之後「選點怎麼不見了」
// 才查得出來是誰、用哪台裝置、什麼時候把資料改成這樣，而不是只能猜。
// 只負責留記錄，寫失敗不影響原本的同步功能（try/catch 吞掉錯誤）。
// memberId/name 一定要用呼叫端當下already算好的值傳進來，不要在這裡重新
// 讀取外層的 memberIdentity——這個函式沒有 await 呼叫端，執行到一半時
// memberIdentity 可能已經被呼叫端改掉（例如刪除身份時設成 null），
// 曾經因此讓 delete 記錄的名字整個是空的。
async function logMemberEvent(action, memberId, name, extra) {
  try {
    const db = await getFirestore();
    await db.addDoc(
      db.collection(db.instance, 'trips', SHARE_CONFIG.tripId, 'memberLogs'),
      {
        action,                                   // 'sync' | 'delete'
        memberId,
        name,
        deviceId: getDeviceId(),
        at: db.serverTimestamp(),
        ...extra,
      }
    );
  } catch (err) {
    console.warn('[跳棋] 記錄寫入失敗（不影響同步本身）：', err);
  }
}

async function pushMemberDoc() {
  if (!memberIdentity || !ownSelectionReconciled) return;
  const { id, name, color } = memberIdentity;
  const spotIds = selectedIds.slice(0, MAX_SHARED_SPOTS);
  try {
    const db = await getFirestore();
    await db.setDoc(
      db.doc(db.instance, 'trips', SHARE_CONFIG.tripId, 'members', id),
      { name, color, spotIds, updatedAt: db.serverTimestamp() }
    );
    logMemberEvent('sync', id, name, { spotCount: spotIds.length });
    appLog('info', '跳棋', `上傳我的選點成功（${name}，${spotIds.length} 個）`);
  } catch (err) {
    console.warn('[跳棋] 同步失敗，下次選點變動時會再試一次：', err);
  }
}

// 拉出最近的同步記錄給使用者自己看，不用等人在旁邊查 Firestore 主控台
async function showMemberLog() {
  const panel = shareEl('memberLogPanel');
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; return; }

  panel.hidden = false;
  panel.textContent = '讀取中…';
  try {
    const db = await getFirestore();
    const snap = await db.getDocs(db.query(
      db.collection(db.instance, 'trips', SHARE_CONFIG.tripId, 'memberLogs'),
      db.orderBy('at', 'desc'),
      db.limit(40)
    ));
    if (snap.empty) {
      panel.textContent = '目前還沒有同步記錄。';
      return;
    }
    const rows = [];
    snap.forEach(docSnap => {
      const d = docSnap.data();
      const t = d.at && d.at.toDate ? d.at.toDate().toLocaleString('zh-TW', { hour12: false }) : '（時間未知）';
      const who = d.name || d.memberId || '（未知）';
      const dev = d.deviceId ? d.deviceId.slice(0, 10) : '（未知裝置）';
      if (d.action === 'delete') {
        rows.push(`${t}｜${dev}｜${who}｜🗑️ 刪除了跳棋身份`);
      } else {
        rows.push(`${t}｜${dev}｜${who}｜同步了 ${d.spotCount ?? '?'} 個景點`);
      }
    });
    panel.textContent = rows.join('\n');
  } catch (err) {
    panel.textContent = '讀取失敗，請確認網路連線，或 Firestore 規則是否已加上 memberLogs（見 README）。';
    console.warn('[跳棋] 讀取記錄失敗：', err);
  }
}

// 訂閱其他人的即時異動，一有人改選點，大家的地圖立刻更新，不用手動重新整理
async function startMembersListener() {
  if (membersListening || !memberIdentity) return;
  membersListening = true;
  try {
    const db = await getFirestore();
    db.onSnapshot(
      db.collection(db.instance, 'trips', SHARE_CONFIG.tripId, 'members'),
      (snap) => {
        const next = {};
        let own = null;
        snap.forEach(docSnap => {
          // 自己已經用原本的圓點+號碼顯示，不用重複疊一次，只留下來做比對
          if (memberIdentity && docSnap.id === memberIdentity.id) { own = docSnap.data(); return; }
          next[docSnap.id] = docSnap.data();
        });
        // 快取裡的舊資料（離線時）不算數，一定要等真的從雲端拿到才比對
        const fromCache = !!(snap.metadata && snap.metadata.fromCache);
        if (memberIdentity && !ownSelectionReconciled && !fromCache) {
          if (reconcileOwnSelection(own) === 'push') scheduleMemberSync();
        }
        logOthersChange(othersState, next);
        othersState = next;
        renderOthersList();
        renderMemberPawns();
        renderJointList();
        updateRouteLine();
      },
      (err) => console.warn('[跳棋] 即時同步中斷：', err)
    );
  } catch (err) {
    membersListening = false;
    console.warn('[跳棋] 無法連上即時同步：', err);
  }
}

// 家人的選點數量有變化才記一筆（例如「哥 5→0」），之前「選點突然不見」
// 這類問題，看記錄就知道是哪個時間點、哪個人的資料被改掉的。
function logOthersChange(prev, next) {
  const count = (m) => (m && Array.isArray(m.spotIds) ? m.spotIds.length : 0);
  const changes = [];
  Object.keys(next).forEach(id => {
    const before = prev[id] ? count(prev[id]) : null;
    const after = count(next[id]);
    if (before === null) changes.push(`${next[id].name || id} 出現(${after})`);
    else if (before !== after) changes.push(`${next[id].name || id} ${before}→${after}`);
  });
  Object.keys(prev).forEach(id => {
    if (!next[id]) changes.push(`${prev[id].name || id} 消失(原本${count(prev[id])})`);
  });
  if (changes.length) appLog('info', '跳棋', `家人選點變化：${changes.join('、')}`);
}

// 先用本機快取的身份立刻顯示，避免整頁一開始閃一下「尚未登入」，
// 再非同步跟 Firebase Auth 對一次真正的登入狀態，確保沒被登出、
// 也接得住「剛從 Google 登入頁面導回來」（signInWithRedirect）的情況。
async function initMemberAuth() {
  renderMemberBox();   // 不管有沒有快取的身份，先畫出畫面（沒有的話就是「登入」按鈕）
  if (memberIdentity) startMembersListener();
  try {
    const auth = await getAuthSvc();
    try {
      const redirectResult = await auth.getRedirectResult(auth.instance);
      if (redirectResult && redirectResult.user) await loadOrCreateMemberDoc(redirectResult.user);
    } catch (err) {
      console.warn('[跳棋] 讀取登入導向結果失敗：', err);
    }
    auth.onAuthStateChanged(auth.instance, (user) => {
      appLog('info', '跳棋', user ? 'Google 登入狀態：已登入' : 'Google 登入狀態：未登入');
      if (!user) {
        if (memberIdentity) { memberIdentity = null; saveMemberIdentity(); renderMemberBox(); }
        return;
      }
      if (memberIdentity && memberIdentity.id === user.uid) return;   // 狀態已經一致，不用重做一次
      loadOrCreateMemberDoc(user);
    });
  } catch (err) {
    // 尚未設定 Firebase 或目前離線，維持用本機快取的狀態就好，不擋住其他功能
    console.warn('[跳棋] 無法初始化登入狀態：', err);
  }
}
initMemberAuth();

// ---------- 離線支援 ----------
// 註冊 Service Worker，讓網站在沒有網路時仍然打得開
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(() => appLog('info', 'sw', `離線快取已註冊（${navigator.serviceWorker.controller ? '已接管此頁' : '第一次安裝，下次開啟才接管'}）`))
      .catch(err => {
        console.warn('[sw] Service Worker 註冊失敗，離線功能無法使用：', err);
      });
    // 新版 sw.js 接管時記一筆，方便對照「更新後才出問題」這類狀況
    navigator.serviceWorker.addEventListener('controllerchange', () => appLog('info', 'sw', '新版離線快取已接管'));
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
function showAskWarning(text, warnElId = 'askWarning') {
  const warn = document.getElementById(warnElId);
  if (!warn) return;
  warn.textContent = text;
  warn.hidden = false;
}

// 手機的語音清單是開網頁後才慢慢載入的：第一次按播放時，日文語音常常還沒出現在清單裡。
// 以前只等 0.4 秒就判定「沒裝日文語音」，而且那次不再重試，導致要按好幾次才會唸。
// 現在網頁一打開就先開始載入並記住找到的日文語音；按下去還沒載好就最多等 3 秒。
// 只要這支手機找到過一次日文語音，就記下來（JA_OK_KEY）：之後語音載入比較慢也不會再說「沒裝」，
// 只會安靜等它載好；第一次打開網站時就主動檢查，沒有的話直接跳出教學（只跳一次，TTS_GUIDE_KEY）。
const JA_OK_KEY = 'kyotoTtsJaOk';
const TTS_GUIDE_KEY = 'kyotoTtsGuideShown';
let cachedJaVoice = null;
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 私密瀏覽存不了就算了 */ } }
function findJaVoice() {
  let v = null;
  try {
    v = speechSynthesis.getVoices().find(x => x.lang && x.lang.toLowerCase().replace('_', '-').startsWith('ja')) || null;
  } catch (e) { return null; }
  if (v) {
    cachedJaVoice = v;
    if (!lsGet(JA_OK_KEY)) { lsSet(JA_OK_KEY, v.name || 'ja'); appLog('info', 'ui', `這支手機有日文語音：${v.name}`); }
  }
  return v;
}
if ('speechSynthesis' in window) {
  try {
    findJaVoice();
    speechSynthesis.addEventListener('voiceschanged', () => { findJaVoice(); });
    // 第一次點網站任何地方時，用無聲的方式先把語音引擎叫醒，之後按播放才能馬上唸
    document.addEventListener('pointerdown', () => {
      try {
        const warm = new SpeechSynthesisUtterance(' ');
        warm.volume = 0;
        speechSynthesis.speak(warm);
      } catch (e) { /* ignore */ }
    }, { once: true, capture: true });
    // 第一次打開網站（手機）：幾秒內都沒找到日文語音，就先教會使用者設定好
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !lsGet(JA_OK_KEY) && !lsGet(TTS_GUIDE_KEY)) {
      const t0 = Date.now();
      const check = setInterval(() => {
        if (findJaVoice()) { clearInterval(check); return; }
        if (Date.now() - t0 < 5000) return;
        clearInterval(check);
        lsSet(TTS_GUIDE_KEY, '1');
        showTtsGuide(true);
      }, 300);
    }
  } catch (e) { /* 不支援就算了，按播放時會說明 */ }
}

// warnElId：不同面板各自有自己的警告區塊（問路 vs 退稅小幫手），
// 預設用問路面板的 id，維持既有呼叫端不用改。
// btn：播放按鈕本身。等語音載入時在按鈕上顯示百分比——手機不會回報真正的載入進度，
// 所以是照等待時間估算的（等到上限就是 100%），語音一載好就直接跳 100% 開始唸。
function speakJapanese(text, warnElId = 'askWarning', btn = null) {
  const warn = document.getElementById(warnElId);
  if (warn) warn.hidden = true;   // 上一次的警告先收起來，這次成功就不會一直掛著
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    showAskWarning('這個瀏覽器不支援語音朗讀，請直接把畫面給對方看這句日文。', warnElId);
    return;
  }
  speechSynthesis.cancel();   // 停掉上一次可能還沒播完的

  const speakWith = (voice) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ja-JP';
    utter.voice = voice;
    utter.rate = 0.9;   // 稍微放慢，對方比較聽得清楚
    speechSynthesis.speak(utter);
  };

  // 已經找到過日文語音：馬上唸（在按鈕的點擊當下呼叫，iPhone 比較不會擋）
  const ready = cachedJaVoice || findJaVoice();
  if (ready) { cachedJaVoice = ready; speakWith(ready); return; }

  // 還沒載入好：每 0.2 秒看一次。這支手機以前找到過日文語音的話，不會再說「沒裝」，
  // 多等一下（8 秒），真的等不到就直接指定用日文唸，讓手機自己挑日文語音
  const knownOk = !!lsGet(JA_OK_KEY);
  const limit = knownOk ? 8000 : 3000;
  const startedAt = Date.now();
  if (btn && btn.dataset.loading) return;   // 已經在等了，不要重複排隊
  const label = btn ? btn.textContent : '';
  const showPct = (pct) => { if (btn) btn.textContent = `⏳ 載入日文語音… ${pct}%`; };
  const restore = () => { if (btn) { btn.textContent = label; delete btn.dataset.loading; btn.disabled = false; } };
  if (btn) { btn.dataset.loading = '1'; btn.disabled = true; }
  showPct(0);
  const poll = setInterval(() => {
    const v = findJaVoice();
    if (v) {
      clearInterval(poll);
      showPct(100);
      setTimeout(restore, 400);
      speakWith(v);
      return;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed < limit) { showPct(Math.min(99, Math.round(elapsed / limit * 100))); return; }
    clearInterval(poll);
    showPct(100);
    setTimeout(restore, 400);
    if (knownOk) {
      appLog('warn', 'ui', '日文語音 8 秒還沒載好，直接指定 ja-JP 唸');
      speakWith(null);
      return;
    }
    let langs = '';
    try { langs = [...new Set(speechSynthesis.getVoices().map(x => x.lang))].slice(0, 12).join(','); } catch (e) { /* ignore */ }
    appLog('warn', 'ui', `等了 3 秒還是找不到日文語音（語音清單：${langs || '空的'}）`);
    // 教學只給手機（電腦版不需要）；電腦上只留一行提示
    const onPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    showAskWarning(onPhone ? '這台手機還沒有日文語音，先直接把畫面給對方看這句日文。' : '這台電腦沒有日文語音，請直接把畫面給對方看這句日文。', warnElId);
    if (onPhone) showTtsGuide();
  }, 200);
}

// 沒有日文語音時跳出的教學。網頁不能直接打開手機的系統設定（手機的安全限制）：
// Android 用 intent 試著打開「文字轉語音」設定，打不開就改開 Play 商店的 Google 語音服務；
// iPhone 完全不允許，只能照教學自己去設定。
function showTtsGuide(firstVisit) {
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  let box = document.getElementById('ttsGuide');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ttsGuide';
    box.className = 'tts-guide-overlay';
    document.body.appendChild(box);
  }
  const steps = isIOS ? [
    '打開手機的「設定」App',
    '點「輔助使用」→「朗讀內容」→「聲音」',
    '點「日文」，選一個聲音（例如 Kyoko），按下載',
    '下載完回到這裡，再按一次播放',
  ] : [
    '按下面的「📱 前往語音設定」（打不開的話：打開「設定」，在最上面搜尋「文字轉語音」）',
    '「偏好的引擎」選「Google 語音服務」，按它旁邊的齒輪 ⚙️',
    '點「安裝語音資料」→ 找到「日本語」→ 按下載',
    '下載完回到這裡，再按一次播放',
  ];
  box.innerHTML = `
    <div class="tts-guide-box" role="dialog" aria-label="安裝日文語音教學">
      <h3>🔊 ${firstVisit ? '先把手機的日文語音裝好' : '這台手機還沒有日文語音'}</h3>
      <p>${firstVisit ? '這個網站的「問路」和「退稅小幫手」會用手機唸日文給日本人聽，' : ''}沒有日文語音的話，播放出來會變成用中文發音硬唸日文，日本人聽不懂。照下面做一次就好，之後都能用：</p>
      <ol>${steps.map(t => `<li>${t}</li>`).join('')}</ol>
      <p class="tts-guide-note">${isIOS ? 'iPhone 不允許網頁直接打開「設定」，要請你自己打開。' : '在裝好之前，可以先直接把畫面給對方看日文。'}</p>
      <div class="tts-guide-actions">
        ${isAndroid ? '<button type="button" class="ask-play-btn" id="ttsGoSettings">📱 前往語音設定</button>' : ''}
        <button type="button" class="share-btn" id="ttsGuideClose">我知道了</button>
      </div>
    </div>`;
  box.hidden = false;
  appLog('info', 'ui', '顯示安裝日文語音教學');
  document.getElementById('ttsGuideClose').addEventListener('click', () => { box.hidden = true; });
  const go = document.getElementById('ttsGoSettings');
  if (go) go.addEventListener('click', () => {
    appLog('info', 'ui', '按「前往語音設定」');
    const fallback = encodeURIComponent('https://play.google.com/store/apps/details?id=com.google.android.tts');
    location.href = `intent:#Intent;action=com.android.settings.TTS_SETTINGS;S.browser_fallback_url=${fallback};end`;
  });
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
  document.getElementById('askPlayBtn').addEventListener('click', (e) => speakJapanese(phrase.ja, 'askWarning', e.currentTarget));

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

// 把景點的實際資料整理成一行，讓導遊照我們的資料回答，而不是憑自己的記憶。
// 開頭的 [id] 是給導遊在建議加入地圖時引用用的，不是給人看的（見下面
// extractGuideTags() 的說明），一定要留著，不然導遊沒辦法指定要加哪個點。
function describeSpot(spot, maxDesc) {
  const desc = maxDesc && spot.desc.length > maxDesc ? spot.desc.slice(0, maxDesc) + '…' : spot.desc;
  let line = `[${spot.id}] ${spot.name}（${spot.area}）：${desc}`;
  if (spot.hours) line += `【開放時間：${spot.hours}】`;
  if (spot.booking) {
    const meta = BOOKING_META[spot.booking.level];
    line += `【${meta.label}：${spot.booking.note}】`;
  }
  return line;
}

// 導遊回答裡用 [[ORDER@m1: …]] 指定「哪一位家人」，m1、m2… 對應到誰記在這裡
let guideMemberKeys = {};   // 'm1' -> 家人的 uid

function idsToSpots(ids) { return ids.map(id => SPOTS.find(s => s.id === id)).filter(Boolean); }
function routeText(spots) { return spots.map(s => `[${s.id}] ${s.name}`).join(' → '); }

// 依距離排順路，但「住宿與交通」（機場、車站、飯店）是抵達／離開用的點，維持原本的位置不動。
// 以前把關西機場也拿去排，結果被排到最前面，直線總長變成兩百公里。
// 開頭連續的住宿與交通點之後，從最後一個（通常是飯店）出發排其餘景點。
function plannedOrderIds(ids) {
  const spots = idsToSpots(ids);
  const fixed = (s) => s.categories.includes('stay');
  let lead = 0;
  while (lead < spots.length && fixed(spots[lead])) lead++;
  const start = lead ? spots[lead - 1] : routeStart();
  const planned = planRouteOrder(spots.filter(s => !fixed(s)), start);
  let k = 0;
  return spots.map(s => (fixed(s) ? s : planned[k++])).map(s => s.id);
}

// 路線總長：開頭連續的機場／車站／飯店不算（那是抵達的過程，不是這趟要比較的部分），
// 從最後一個（通常是飯店）開始算其餘景點
function tripLengthKm(ids) {
  const spots = idsToSpots(ids);
  let lead = 0;
  while (lead < spots.length && spots[lead].categories.includes('stay')) lead++;
  return routeLengthKm(lead ? spots[lead - 1] : routeStart(), spots.slice(lead));
}

// 一個人的清單：目前順序＋算好的順路順序，給導遊判斷順不順路
function describeRoute(label, spots) {
  const lines = [`${label}目前的順序：${routeText(spots)}（直線總長 ${formatDistance(tripLengthKm(spots.map(s => s.id)))}）`];
  if (spots.length >= 2) {
    const planned = idsToSpots(plannedOrderIds(spots.map(s => s.id)));
    const same = planned.every((s, i) => s === spots[i]);
    lines.push(same
      ? '  → 依距離算，這已經是最順路的順序'
      : `  → 依距離算出的順路順序：${routeText(planned)}（總長 ${formatDistance(tripLengthKm(planned.map(s => s.id)))}）`);
  }
  return lines.join('\n');
}

// 把目前畫面狀態告訴導遊，它才知道「我選的這幾個」是指哪幾個。
// 後端只收前 6000 字，所以短的重點（清單、路線、家人、格式說明）放前面，長的介紹放後面。
function buildGuideContext(question) {
  const parts = [];
  const selected = idsToSpots(selectedIds);
  const me = memberIdentity ? memberIdentity.name : '使用者';

  if (selected.length) {
    parts.push(describeRoute(`使用者（${me}）`, selected));
  } else {
    parts.push('使用者目前還沒有勾選任何景點。');
  }

  // 其他家人的清單（跳棋同步來的），讓導遊能一起考慮大家的路線
  guideMemberKeys = {};
  const family = Object.entries(othersState)
    .filter(([, m]) => m && Array.isArray(m.spotIds) && m.spotIds.length)
    .slice(0, 6);
  family.forEach(([uid, m], i) => {
    const key = 'm' + (i + 1);
    guideMemberKeys[key] = uid;
    parts.push(describeRoute(`家人 ${key}（${m.name || '家人'}）`, idsToSpots(m.spotIds)));
  });

  // 大家共同選的景點：導遊可以盡量排在相近的時段，方便一起行動
  if (family.length) {
    const who = {};
    selectedIds.forEach(id => { (who[id] = who[id] || []).push(me); });
    family.forEach(([, m]) => m.spotIds.forEach(id => { (who[id] = who[id] || []).push(m.name || '家人'); }));
    const shared = Object.entries(who).filter(([, names]) => names.length >= 2);
    if (shared.length) {
      parts.push('兩個人以上都選的景點：' + shared.map(([id, names]) => {
        const s = SPOTS.find(x => x.id === id);
        return s ? `[${id}] ${s.name}（${names.join('、')}）` : '';
      }).filter(Boolean).join('、'));
    }
  }

  const someoneHasRoute = selected.length >= 2 || family.some(([, m]) => m.spotIds.length >= 2);
  if (someoneHasRoute) {
    parts.push(`
【調整順序的格式（系統用，非常重要）】
- 使用者請你排順序、調整路線、問順不順路時，**把標記放在回答的最前面**，一個標記一行，寫完標記才開始寫說明：
  [[ORDER: id1,id2,…]] ← 調整使用者自己的順序
  [[ORDER@m1: id1,id2,…]] ← 建議家人 m1 的順序（系統會產生連結，讓使用者傳給那位家人）
  （回答長度有上限，標記放在最後會被截斷，所以一定要放最前面。）
- 只能重新排列，不能刪除、不能新增：標記裡必須剛好是那個人目前選的全部景點，一個都不能少。
  想建議新增景點用 [[ADD: …]]。
- 使用者要求刪除景點時：你沒辦法刪除，文字要明確寫「我沒辦法幫你刪除，要拿掉的話請在已選景點按 ✕」，
  絕對不能說「已刪除」「已移除」。可以說明為什麼建議拿掉，讓他們自己決定。
- 住宿與交通（機場、車站、飯店）是抵達、離開用的點，除非使用者要求，位置不要動。
- 可以直接採用上面依距離算好的順路順序，也可以依開放時間、預約時段、用餐、長輩體力調整；
  多人都選的景點盡量排在相近的位置，方便大家一起行動。
- 標記使用者看不到。說明文字控制在 200 字內，只講重點理由；
  文字裡一律寫景點名稱和家人的名字，不要寫 [t01]、v16、m1 這種代號。`.trim());
  }

  const active = SPOTS.find(s => s.id === activeSpotId);
  if (active && !selected.includes(active)) {
    parts.push('使用者目前正在看的景點：' + describeSpot(active));
  }

  if (activeCategory !== 'all' && CATEGORY_META[activeCategory]) {
    parts.push(`目前篩選的分類：${CATEGORY_META[activeCategory].label}`);
  }

  if (selected.length) {
    const maxDesc = selected.length > 5 ? 70 : 0;
    parts.push('使用者已選景點的介紹：');
    selected.forEach((spot, i) => parts.push(`${i + 1}. ${describeSpot(spot, maxDesc)}`));
  }

  // 依問題從景點資料庫裡撈出可能相關的，讓導遊有資料可以回答
  const related = findRelevantSpots(question, 6, selectedIds.concat(activeSpotId || []));
  if (related.length) {
    parts.push('');
    parts.push('資料庫中可能與問題相關的其他景點（使用者沒有勾選，僅供你參考）：');
    related.forEach(spot => parts.push('- ' + describeSpot(spot, 90)));
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
  appLog('info', 'ui', '開啟「線上導遊」');
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

// 導遊回答最後面可能附上系統用的標記（使用者看不到，這裡負責拿掉）：
//   [[ADD: t01,v01]]        建議加進地圖的景點（後端 system prompt 教的格式）
//   [[ORDER: t03,t01,…]]    建議使用者自己的新順序（buildGuideContext 裡教的格式）
//   [[ORDER@m1: …]]         建議家人 m1 的新順序，m1 對應誰記在 guideMemberKeys
// 只能用【目前畫面狀態】裡出現過的 [id]，不能自己編；編了也會在套用時被擋掉。
function extractGuideTags(answer) {
  const splitIds = (str) => str.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean);
  const addIds = [];
  const orders = [];
  let text = answer.replace(/\[\[\s*(ADD|ORDER)(?:@(m\d+))?\s*[:：]\s*([^\]]*)\]\]/gi, (m, kind, who, list) => {
    if (kind.toUpperCase() === 'ADD') addIds.push(...splitIds(list));
    else orders.push({ who: who ? who.toLowerCase() : 'self', ids: splitIds(list) });
    return '';
  });
  // 回答被後端的長度上限截斷時，最後會留下半截標記（例如「[[ORDER: b01,b0」），不能給使用者看到
  let truncated = false;
  text = text.replace(/\[\[[^\]\n]*(?:\][^\]\n]*)?(?=\n|$)/g, () => { truncated = true; return ''; });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), addIds, orders, truncated };
}

// 把導遊建議的景點加進「已選景點」。只接受真的存在於資料庫的 id
// （導遊可能會編造或記錯，這裡一律不信任，交叉比對 SPOTS 才算數），
// 已經選過的不重複加，一次最多加 8 個，避免單一回覆就洗掉整個地圖。
const MAX_GUIDE_ADD = 8;
function applyGuideSuggestions(ids) {
  if (!ids || !ids.length) return;
  const toAdd = ids
    .filter(id => SPOTS.some(s => s.id === id))
    .filter(id => !selectedIds.includes(id))
    .slice(0, MAX_GUIDE_ADD);
  if (!toAdd.length) return;

  selectedIds.push(...toAdd);
  renderList();
  renderSelection();
  updateMarkerVisibility();
  fitToVisibleSpots();

  const names = toAdd.map(id => SPOTS.find(s => s.id === id).name);
  addChatMessage('bot', '📍 已經幫你把「' + names.join('、') + '」加進「已選景點」了。', 'chat-msg-ok');
}

// 在聊天視窗裡放幾個按鈕（套用、改回、傳給家人）
function addChatActions(buttons) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-actions';
  buttons.forEach(({ label, onClick, primary }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-action-btn' + (primary ? ' chat-action-primary' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => onClick(btn, wrap));
    wrap.appendChild(btn);
  });
  chatEl('chatMsgs').appendChild(wrap);
  chatEl('chatMsgs').scrollTop = chatEl('chatMsgs').scrollHeight;
  return wrap;
}

function spotNames(ids) { return idsToSpots(ids).map(s => s.name); }

// 導遊建議「自己」的新順序：先給使用者看，按了才套用，套用後還可以改回來
function proposeOwnOrder(proposal, fallback) {
  const next = reorderKeepAll(selectedIds, proposal);
  if (next.join(',') === selectedIds.join(',')) return;
  const before = tripLengthKm(selectedIds);
  const after = tripLengthKm(next);
  const kept = selectedIds.filter(id => !proposal.includes(id));
  appLog('info', '導遊', `建議我的新順序：${next.join(',')}（導遊漏掉、保留在最後：${kept.join(',') || '無'}）`);

  addChatMessage('bot',
    (fallback ? '🔀 導遊沒有附上可以直接套用的順序，這是網站依直線距離算出的順路順序（機場、車站、飯店維持原位）：\n'
              : '🔀 導遊建議的新順序：\n') + spotNames(next).map((n, i) => `${i + 1}. ${n}`).join('\n') +
    `\n\n直線總長：${formatDistance(before)} → ${formatDistance(after)}` +
    (kept.length ? `\n（導遊漏掉的「${spotNames(kept).join('、')}」已經幫你保留，排在最後面）` : '') +
    '\n只會調整順序，不會刪掉你選的任何景點。', 'chat-msg-ok');

  addChatActions([
    { label: '✅ 套用這個順序', primary: true, onClick: (btn, wrap) => {
      const prev = selectedIds.slice();
      // 按下去的當下再算一次：這段時間如果又勾了別的景點，也一樣保留
      selectedIds = reorderKeepAll(selectedIds, next);
      appLog('info', 'select', `套用導遊建議的順序：${selectedIds.join(',')}`);
      renderList();
      renderSelection();
      updateMarkerVisibility();
      wrap.remove();
      addChatMessage('bot', '已經照這個順序排好了，地圖上的路線也更新了。', 'chat-msg-ok');
      addChatActions([{ label: '↩️ 改回原本的順序', onClick: (b2, w2) => {
        selectedIds = reorderKeepAll(selectedIds, prev);
        appLog('info', 'select', `改回原本的順序：${selectedIds.join(',')}`);
        renderList();
        renderSelection();
        updateMarkerVisibility();
        w2.remove();
        addChatMessage('bot', '已經改回原本的順序。', 'chat-msg-ok');
      } }]);
    } },
    { label: '先不要', onClick: (btn, wrap) => wrap.remove() },
  ]);
}

// 導遊建議「家人」的新順序：Firestore 規則只允許每個人改自己的資料，
// 所以不直接改，而是產生 #order= 連結，讓使用者用 LINE 傳給那位家人，他點開就套用
function proposeMemberOrder(key, proposal, fallback) {
  const uid = guideMemberKeys[key];
  const m = uid && othersState[uid];
  if (!m || !Array.isArray(m.spotIds) || !m.spotIds.length) return;
  const next = reorderKeepAll(m.spotIds, proposal);
  if (next.join(',') === m.spotIds.join(',')) return;
  const name = m.name || '家人';
  const before = tripLengthKm(m.spotIds);
  const after = tripLengthKm(next);
  appLog('info', '導遊', `建議 ${name} 的新順序：${next.join(',')}`);

  addChatMessage('bot',
    (fallback ? `🔀 給「${name}」的順路順序（網站依直線距離算的，機場、車站、飯店維持原位）：\n`
              : `🔀 給「${name}」的建議順序：\n`) + spotNames(next).map((n, i) => `${i + 1}. ${n}`).join('\n') +
    `\n\n直線總長：${formatDistance(before)} → ${formatDistance(after)}` +
    `\n只會調整${name}的順序，不會刪掉他選的景點。按下面的按鈕把連結傳給${name}，他點開就會套用。`, 'chat-msg-ok');

  addChatActions([{ label: `📤 傳給${name}`, primary: true, onClick: async () => {
    const url = location.origin + location.pathname + '#order=' + next.slice(0, MAX_SHARED_SPOTS).join(',');
    const text = `導遊幫你把 ${next.length} 個景點排成比較順路的順序（只改順序，不會刪掉你選的），點開連結就會套用：`;
    if (navigator.share) {
      try { await navigator.share({ title: '京都行程：建議順序', text, url }); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(text + url);
      addChatMessage('bot', `連結已複製，貼到 LINE 傳給${name}就可以了。`, 'chat-msg-ok');
    } catch (err) {
      addChatMessage('bot', `請手動複製這個連結傳給${name}：\n${url}`, 'chat-msg-ok');
    }
  } }]);
}

async function sendToGuide(text) {
  const question = (text || '').trim();
  if (!question || chatState.busy) return;
  appLog('info', '導遊', `提問：${question.slice(0, 60)}`);

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
    const rawAnswer = (data && data.answer) ? data.answer : '導遊沒有回覆內容，請再問一次。';
    const { text: answer, addIds, orders, truncated } = extractGuideTags(rawAnswer);
    thinking.remove();
    appLog(truncated ? 'warn' : 'info', '導遊', `回答 ${rawAnswer.length} 字，標記：ADD ${addIds.length} 個、ORDER ${orders.length} 個` +
      (truncated ? '，有不完整的標記（回答被長度上限截斷）' : ''));
    addChatMessage('bot', answer || '（導遊只回了調整建議，請看下面）');
    // 導遊沒辦法刪除景點，但 AI 偶爾還是會說「已刪除」，補一句免得家人以為景點不見了
    if (/(已|幫你|替你)[^。\n]{0,20}(刪除|移除|刪掉|拿掉)/.test(answer)) {
      addChatMessage('bot', '提醒：導遊沒辦法刪除景點，你選的景點都還在。要拿掉的話，請在「已選景點」按 ✕。', 'chat-msg-warn');
    }
    chatState.history.push({ q: question, a: answer });
    applyGuideSuggestions(addIds);
    orders.forEach(o => (o.who === 'self' ? proposeOwnOrder(o.ids) : proposeMemberOrder(o.who, o.ids)));

    // 導遊沒照格式給出順序（例如回答太長被截斷），但使用者明明是在問排順序：
    // 改由網站提供自己算好的順路順序，一樣可以按套用，功能不會因為 AI 沒照格式就失效
    if (/順路|順序|排序|排一下|路線|怎麼排/.test(question)) {
      if (!orders.some(o => o.who === 'self') && selectedIds.length >= 3) {
        proposeOwnOrder(plannedOrderIds(selectedIds), true);
      }
      if (/全家|家人|大家|每個人|其他人/.test(question)) {
        Object.entries(guideMemberKeys).forEach(([key, uid]) => {
          const m = othersState[uid];
          if (!orders.some(o => o.who === key) && m && Array.isArray(m.spotIds) && m.spotIds.length >= 3) {
            proposeMemberOrder(key, plannedOrderIds(m.spotIds), true);
          }
        });
      }
    }
  } catch (err) {
    thinking.remove();
    console.warn('[導遊] 失敗：', err);
    const code = err.code || (err.name === 'AbortError' ? 'E4' : 'E3');
    appLog('warn', '導遊', `回答失敗，畫面顯示代號 ${code}`);
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
document.getElementById('taxBtn').addEventListener('click', showTaxRefund);

// ---------- 初始化 ----------
renderTabs();
renderList();
renderSelection();
setMobileView('list');
applyListFromUrl();   // 網址帶著 #list=… 時，直接載入別人分享的清單
// 網站本來就開著時點連結，瀏覽器只會換掉 # 後面、不會重新載入，要自己接
window.addEventListener('hashchange', applyListFromUrl);
