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

// 跳棋（其他家人即時選的景點）：renderMarkers() 在檔案開頭就會同步執行
// （見下面「地圖初始化」的說明），renderMemberPawns() 會在那時候就用到
// 這個變數，宣告在後面會踩到 TDZ，所以要跟其他早期宣告放在一起。
let othersState = {};                  // 其他人：id -> { name, color, spotIds }

// 特殊標記形狀（三角形/星形/元寶/坐佛）各自的底色，renderMarkers() 也是
// 在檔案開頭就同步執行，要跟上面 othersState 一樣早宣告避免 TDZ。
const SHAPE_BASE_COLOR = { triangle: '#ff8f00', star: '#ffcc00', ingot: '#ffcc00', buddha: '#a67c00' };

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
const NO_LIMIT_RE = /24\s*小時|24\s*小时|自由參拜|自由参拝|境內自由|境内自由/;

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

// 退稅小幫手：結帳前播放／出示日語，結帳後照清單勾一次，確保真的辦到免稅
function showTaxRefund() {
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

  document.getElementById('taxPlayBtn').addEventListener('click', () => speakJapanese(p.ja, 'taxWarning'));

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
function parseListFromHash(hash) {
  const m = /[#&]list=([^&]*)/.exec(hash || '');
  if (!m) return null;
  const ids = decodeURIComponent(m[1]).split(',')
    .map(s => s.trim())
    .filter(id => SPOTS.some(s => s.id === id));
  return ids.slice(0, MAX_SHARED_SPOTS);
}

// 開啟網頁時如果網址帶著清單，就直接套用
function applyListFromUrl() {
  const ids = parseListFromHash(location.hash);
  if (!ids || !ids.length) return;
  selectedIds = ids;
  renderList();
  renderSelection();
  updateMarkerVisibility();
  fitToVisibleSpots();
  shareMessage('<p class="share-note share-note-ok">已載入分享的清單，共 ' + ids.length +
    ' 個景點。你可以直接用，也可以改完之後再按「🔗 用連結分享」傳回去。</p>');
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
    } else {
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
    clearTimeout(memberSyncTimer);
    pushMemberDoc();
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

// 選點有變動時就 debounce 一下再同步，避免連續勾選時瘋狂寫入
function scheduleMemberSync() {
  renderJointList();
  if (!memberIdentity) return;
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
  if (!memberIdentity) return;
  const { id, name, color } = memberIdentity;
  const spotIds = selectedIds.slice(0, MAX_SHARED_SPOTS);
  try {
    const db = await getFirestore();
    await db.setDoc(
      db.doc(db.instance, 'trips', SHARE_CONFIG.tripId, 'members', id),
      { name, color, spotIds, updatedAt: db.serverTimestamp() }
    );
    logMemberEvent('sync', id, name, { spotCount: spotIds.length });
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
        snap.forEach(docSnap => {
          if (memberIdentity && docSnap.id === memberIdentity.id) return;   // 自己已經用原本的圓點+號碼顯示，不用重複疊一次
          next[docSnap.id] = docSnap.data();
        });
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
function showAskWarning(text, warnElId = 'askWarning') {
  const warn = document.getElementById(warnElId);
  if (!warn) return;
  warn.textContent = text;
  warn.hidden = false;
}

// warnElId：不同面板各自有自己的警告區塊（問路 vs 退稅小幫手），
// 預設用問路面板的 id，維持既有呼叫端（buildAskPhrase 那邊）不用改。
function speakJapanese(text, warnElId = 'askWarning') {
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    showAskWarning('這個瀏覽器不支援語音朗讀，請直接把畫面給對方看這句日文。', warnElId);
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
        '這段時間可以先直接把畫面給對方看這句日文。',
        warnElId
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

// 把景點的實際資料整理成一行，讓導遊照我們的資料回答，而不是憑自己的記憶。
// 開頭的 [id] 是給導遊在建議加入地圖時引用用的，不是給人看的（見下面
// extractAddTag() 的說明），一定要留著，不然導遊沒辦法指定要加哪個點。
function describeSpot(spot) {
  let line = `[${spot.id}] ${spot.name}（${spot.area}）：${spot.desc}`;
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

// 導遊要建議加進地圖的景點時，會在回答最後面附上像 [[ADD: t01,v01]]
// 這樣的標記（後端 system prompt 有教它這個格式，只能用【目前畫面狀態】
// 裡有出現的 [id]，不能自己編）。這段負責把標記從顯示文字裡拿掉，
// 使用者只會看到正常的一段話，不會看到這個內部用的標記本身。
function extractAddTag(answer) {
  const m = answer.match(/\[\[ADD:\s*([^\]]*)\]\]/i);
  if (!m) return { text: answer, ids: [] };
  const ids = m[1].split(',').map(s => s.trim()).filter(Boolean);
  return { text: answer.replace(m[0], '').trim(), ids };
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
    const rawAnswer = (data && data.answer) ? data.answer : '導遊沒有回覆內容，請再問一次。';
    const { text: answer, ids: suggestedIds } = extractAddTag(rawAnswer);
    thinking.remove();
    addChatMessage('bot', answer);
    chatState.history.push({ q: question, a: answer });
    applyGuideSuggestions(suggestedIds);
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
document.getElementById('taxBtn').addEventListener('click', showTaxRefund);

// ---------- 初始化 ----------
renderTabs();
renderList();
renderSelection();
setMobileView('list');
applyListFromUrl();   // 網址帶著 #list=… 時，直接載入別人分享的清單
