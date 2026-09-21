// ===== 京都行程景點地圖 app.js =====

let activeCategory = 'all';
let searchTerm = '';
let selectedIds = [];     // 依點選順序排列，用於產生路線
let activeSpotId = null;  // 目前顯示在下方詳細介紹的景點
const markers = {};       // id -> maplibregl.Marker

// ---------- 地圖初始化 ----------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty', // 免費、不需API金鑰的地圖圖磚
  center: [135.7600, 35.0100],
  zoom: 11.2,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

map.on('load', () => {
  renderMarkers();
  fitToVisibleSpots();
});

// ---------- 工具 ----------
function getVisibleSpots() {
  return SPOTS.filter(s => {
    const catOk = activeCategory === 'all' || s.category === activeCategory;
    const term = searchTerm.trim().toLowerCase();
    const searchOk = !term ||
      s.name.toLowerCase().includes(term) ||
      s.area.toLowerCase().includes(term);
    return catOk && searchOk;
  });
}

function fitToVisibleSpots() {
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
    el.style.background = CATEGORY_META[spot.category].color;
    el.style.cursor = 'pointer';

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
    el.style.display = visibleIds.has(spot.id) ? 'block' : 'none';
    el.style.outline = selectedIds.includes(spot.id) ? '3px solid #222' : 'none';
    el.style.transform2 = null; // no-op, keep default transform from maplibre
    if (spot.id === activeSpotId) {
      el.style.width = '22px';
      el.style.height = '22px';
    } else {
      el.style.width = '16px';
      el.style.height = '16px';
    }
  });
}

// ---------- Tabs ----------
const TABS = [
  { cat: 'all', label: '全部' },
  { cat: 'temple', label: CATEGORY_META.temple.label },
  { cat: 'shopping', label: CATEGORY_META.shopping.label },
  { cat: 'scenic', label: CATEGORY_META.scenic.label },
  { cat: 'shojin', label: CATEGORY_META.shojin.label },
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
    dot.style.background = CATEGORY_META[spot.category].color;

    const info = document.createElement('div');
    info.className = 'spot-info';
    info.innerHTML = `<div class="spot-name">${spot.name}</div><div class="spot-area">${spot.area}</div>`;

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
  const panel = document.getElementById('detailPanel');
  if (!spot) {
    panel.innerHTML = '<div class="detail-placeholder">點選左側清單或地圖上的標記，查看景點詳細介紹</div>';
    return;
  }
  const meta = CATEGORY_META[spot.category];
  panel.innerHTML = `
    <div class="detail-header">
      <span class="badge" style="background:${meta.color}">${meta.label}</span>
      <h2>${spot.name}</h2>
    </div>
    <div class="detail-area">${spot.area}</div>
    <div class="detail-desc">${spot.desc}</div>
  `;
  map.flyTo({ center: [spot.lng, spot.lat], zoom: 14.5, duration: 600 });
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
  const ol = document.getElementById('selectedList');
  ol.innerHTML = '';
  selectedIds.forEach(id => {
    const spot = SPOTS.find(s => s.id === id);
    if (!spot) return;
    const li = document.createElement('li');
    li.textContent = `${spot.name}（${spot.area}）`;
    ol.appendChild(li);
  });

  const routeWrap = document.getElementById('routeButtons');
  routeWrap.innerHTML = '';

  if (selectedIds.length >= 2) {
    for (let i = 0; i < selectedIds.length - 1; i++) {
      const a = SPOTS.find(s => s.id === selectedIds[i]);
      const b = SPOTS.find(s => s.id === selectedIds[i + 1]);
      if (!a || !b) continue;
      const url = buildTransitUrl(a, b);
      const btn = document.createElement('a');
      btn.className = 'route-btn';
      btn.href = url;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
      btn.textContent = `🚉 ${a.name} → ${b.name}（開啟大眾運輸路線）`;
      routeWrap.appendChild(btn);
    }
  }
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

// ---------- 搜尋 ----------
document.getElementById('searchInput').addEventListener('input', (e) => {
  searchTerm = e.target.value;
  renderList();
  updateMarkerVisibility();
});

// ---------- 初始化 ----------
renderTabs();
renderList();
renderSelection();
