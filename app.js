const state = {
  data: null,
  hiddenRoutes: new Set(),
  scale: 1,
  tx: 0,
  ty: 0,
  drag: null,
};

const svg = document.getElementById('map');
const viewport = document.getElementById('viewport');
const routesLayer = document.getElementById('routesLayer');
const stationsLayer = document.getElementById('stationsLayer');
const labelsLayer = document.getElementById('labelsLayer');
const emptyState = document.getElementById('emptyState');
const popup = document.getElementById('stationPopup');
const NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function routeColor(value) {
  if (typeof value === 'number') return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
  if (typeof value === 'string') {
    if (value.startsWith('#')) return value;
    const number = Number(value);
    if (Number.isFinite(number)) return `#${(number & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  return '#607d8b';
}

function payload(json) {
  return json && json.data ? json.data : json;
}

function routeStations(route) {
  const value = route?.stations ?? route?.routeStations ?? route?.platforms ?? [];
  return Array.isArray(value) ? value : [];
}

function stationId(station) {
  return station?.id ?? station?.hexId ?? station?.stationId ?? '';
}

function stationName(station) {
  return station?.name ?? station?.stationName ?? stationId(station) ?? 'Station';
}

function xOf(station) {
  const value = Number(station?.x ?? station?.position?.x);
  return Number.isFinite(value) ? value : null;
}

function zOf(station) {
  const value = Number(station?.z ?? station?.position?.z);
  return Number.isFinite(value) ? value : null;
}

function normalize() {
  const routes = Array.isArray(state.data?.routes) ? state.data.routes : [];
  const stationMap = new Map();

  // Top-level stations contain the proper public station names, but in this
  // MTR payload their coordinates live on each route's ordered station list.
  for (const station of Array.isArray(state.data?.stations) ? state.data.stations : []) {
    const id = stationId(station);
    if (!id) continue;
    stationMap.set(id, {
      ...station,
      id,
      x: xOf(station),
      z: zOf(station),
    });
  }

  // Merge route-station coordinates into the top-level station records.
  for (const route of routes) {
    for (const routeStation of routeStations(route)) {
      const id = stationId(routeStation);
      if (!id) continue;

      const existing = stationMap.get(id) ?? { id };
      const x = xOf(routeStation);
      const z = zOf(routeStation);

      stationMap.set(id, {
        ...routeStation,
        ...existing,
        id,
        // keep the real station name from the top-level object; route station
        // names are usually platform numbers such as "1" or "2"
        name: existing.name ?? routeStation.name ?? id,
        x: existing.x ?? x,
        z: existing.z ?? z,
      });
    }
  }

  const stations = [...stationMap.values()].filter(
    station => Number.isFinite(station.x) && Number.isFinite(station.z)
  );

  return { routes, stations, stationMap };
}

async function load() {
  const statusDot = document.getElementById('statusDot');
  const snapshotStatus = document.getElementById('snapshotStatus');
  const snapshotTime = document.getElementById('snapshotTime');

  let json;
  try {
    const response = await fetch('./data/network.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    json = await response.json();
  } catch (error) {
    console.error('[MTR Map Tools] Could not load data/network.json:', error);
    statusDot.classList.add('bad');
    snapshotStatus.textContent = 'No network snapshot';
    snapshotTime.textContent = 'Could not load data/network.json';
    emptyState.hidden = false;
    return;
  }

  state.data = payload(json);
  statusDot.classList.add('ok');
  snapshotStatus.textContent = 'Public snapshot loaded';
  const exportedAt = state.data?.exportedAt ?? state.data?.generatedAt;
  snapshotTime.textContent = exportedAt ? new Date(exportedAt).toLocaleString() : '';

  try {
    render();
  } catch (error) {
    console.error('[MTR Map Tools] Snapshot loaded but map rendering failed:', error);
    statusDot.classList.remove('ok');
    statusDot.classList.add('bad');
    snapshotStatus.textContent = 'Snapshot loaded — render error';
    snapshotTime.textContent = error?.message ?? String(error);
    emptyState.hidden = false;
    emptyState.querySelector('h2').textContent = 'Network loaded, but the map could not render';
    emptyState.querySelector('p').textContent = 'Open the browser console for the exact error.';
  }
}

function render() {
  emptyState.hidden = true;
  routesLayer.innerHTML = '';
  stationsLayer.innerHTML = '';
  labelsLayer.innerHTML = '';

  const { routes, stations } = normalize();

  for (const route of routes) {
    const routeId = route.id ?? route.hexId ?? route.name;
    if (state.hiddenRoutes.has(routeId)) continue;

    const points = routeStations(route)
      .map(station => [xOf(station), zOf(station)])
      .filter(([x, z]) => Number.isFinite(x) && Number.isFinite(z));

    if (points.length < 2) continue;

    const polyline = svgEl('polyline', {
      points: points.map(([x, z]) => `${x},${z}`).join(' '),
      class: 'route-line',
      stroke: routeColor(route.color),
      'stroke-width': 6,
    });
    routesLayer.appendChild(polyline);
  }

  for (const station of stations) {
    const circle = svgEl('circle', {
      cx: station.x,
      cy: station.z,
      r: 6,
      class: 'station',
    });
    circle.addEventListener('click', event => showStation(station, event));
    stationsLayer.appendChild(circle);

    const label = svgEl('text', {
      x: station.x + 9,
      y: station.z - 9,
      class: 'station-label',
    });
    label.textContent = stationName(station);
    labelsLayer.appendChild(label);
  }

  buildRoutes(routes);
  fit();
}

function buildRoutes(routes) {
  const box = document.getElementById('routeList');
  box.innerHTML = '';

  for (const route of routes) {
    const routeId = route.id ?? route.hexId ?? route.name;
    const row = document.createElement('label');
    row.className = 'route-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !state.hiddenRoutes.has(routeId);

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = routeColor(route.color);

    const name = document.createElement('span');
    name.className = 'route-name';
    name.textContent = route.name ?? route.number ?? routeId;

    checkbox.addEventListener('change', () => {
      checkbox.checked ? state.hiddenRoutes.delete(routeId) : state.hiddenRoutes.add(routeId);
      renderNoFit();
    });

    row.append(checkbox, swatch, name);
    box.appendChild(row);
  }
}

function renderNoFit() {
  const oldTransform = { scale: state.scale, tx: state.tx, ty: state.ty };
  render();
  Object.assign(state, oldTransform);
  applyTransform();
}

function fit() {
  const { stations } = normalize();
  if (!stations.length) return;

  const xs = stations.map(station => station.x);
  const zs = stations.map(station => station.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const width = Math.max(svg.clientWidth, 1);
  const height = Math.max(svg.clientHeight, 1);
  const padding = 80;

  state.scale = Math.min(
    Math.max(0.0001, (width - padding * 2) / Math.max(1, maxX - minX)),
    Math.max(0.0001, (height - padding * 2) / Math.max(1, maxZ - minZ))
  );
  state.tx = width / 2 - state.scale * (minX + maxX) / 2;
  state.ty = height / 2 - state.scale * (minZ + maxZ) / 2;
  applyTransform();
}

function applyTransform() {
  viewport.setAttribute('transform', `translate(${state.tx} ${state.ty}) scale(${state.scale})`);
}

function zoom(factor, cx = svg.clientWidth / 2, cy = svg.clientHeight / 2) {
  state.tx = cx - (cx - state.tx) * factor;
  state.ty = cy - (cy - state.ty) * factor;
  state.scale *= factor;
  applyTransform();
}

svg.addEventListener('wheel', event => {
  event.preventDefault();
  const rect = svg.getBoundingClientRect();
  zoom(event.deltaY < 0 ? 1.15 : 0.87, event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });

svg.addEventListener('pointerdown', event => {
  state.drag = { x: event.clientX, y: event.clientY, tx: state.tx, ty: state.ty };
  svg.setPointerCapture?.(event.pointerId);
  svg.classList.add('dragging');
});

svg.addEventListener('pointermove', event => {
  if (!state.drag) return;
  state.tx = state.drag.tx + event.clientX - state.drag.x;
  state.ty = state.drag.ty + event.clientY - state.drag.y;
  applyTransform();
});

svg.addEventListener('pointerup', () => {
  state.drag = null;
  svg.classList.remove('dragging');
});

document.getElementById('zoomIn').onclick = () => zoom(1.2);
document.getElementById('zoomOut').onclick = () => zoom(0.83);
document.getElementById('fitMap').onclick = fit;

document.getElementById('toggleAll').onclick = () => {
  const routes = normalize().routes;
  if (state.hiddenRoutes.size) {
    state.hiddenRoutes.clear();
  } else {
    routes.forEach(route => state.hiddenRoutes.add(route.id ?? route.hexId ?? route.name));
  }
  document.getElementById('toggleAll').textContent = state.hiddenRoutes.size ? 'Show all' : 'Hide all';
  renderNoFit();
};

function showStation(station, event) {
  popup.hidden = false;
  const rect = svg.getBoundingClientRect();
  popup.style.left = `${Math.min(svg.clientWidth - 290, event.clientX - rect.left + 12)}px`;
  popup.style.top = `${Math.min(svg.clientHeight - 130, event.clientY - rect.top + 12)}px`;
  popup.innerHTML = `<h3>${stationName(station)}</h3><p>X ${Math.round(station.x)} · Z ${Math.round(station.z)}</p><p>ID: ${stationId(station)}</p>`;
}

document.addEventListener('click', event => {
  if (!event.target.closest('.station') && !event.target.closest('.station-popup')) popup.hidden = true;
});

const search = document.getElementById('stationSearch');
const results = document.getElementById('searchResults');

search.addEventListener('input', () => {
  if (!state.data) return;

  const query = search.value.trim().toLowerCase();
  results.innerHTML = '';

  if (!query) {
    results.classList.remove('show');
    return;
  }

  const matches = normalize().stations
    .filter(station => stationName(station).toLowerCase().includes(query))
    .slice(0, 8);

  for (const station of matches) {
    const row = document.createElement('div');
    row.className = 'search-result';
    row.textContent = stationName(station);
    row.onclick = () => {
      const screenX = station.x * state.scale + state.tx;
      const screenY = station.z * state.scale + state.ty;
      state.tx += svg.clientWidth / 2 - screenX;
      state.ty += svg.clientHeight / 2 - screenY;
      applyTransform();
      results.classList.remove('show');
      search.value = stationName(station);
    };
    results.appendChild(row);
  }

  results.classList.toggle('show', results.childElementCount > 0);
});

load();
