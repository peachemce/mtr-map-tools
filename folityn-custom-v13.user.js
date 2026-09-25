// ==UserScript==
// @name         Folityn Custom Transit Map v13
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      13.1.0
// @description  Standalone interactive Folityn schematic renderer. Direct-loads live MTR data and never modifies the native MTR map.
// @match        http://localhost:8888/*
// @match        http://127.0.0.1:8888/*
// @run-at       document-end
// @grant        none
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/folityn-custom-v13.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/folityn-custom-v13.user.js
// ==/UserScript==

(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const API = '/mtr/api/map/stations-and-routes?dimension=0';
  const STORE = 'folityn-v13-';

  let network = null;
  let model = null;
  let overlay = null;
  let svg = null;
  let viewport = null;
  let infoBox = null;
  let transform = { scale: 1, x: 0, y: 0 };

  function norm(value) {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function createSvg(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    }
    return node;
  }

  function unwrap(json) {
    return json && json.data && typeof json.data === 'object' ? json.data : json;
  }

  function routeStops(route) {
    if (Array.isArray(route?.stations)) return route.stations;
    if (Array.isArray(route?.routeStations)) return route.routeStations;
    if (Array.isArray(route?.platforms)) return route.platforms;
    return [];
  }

  function stationId(station) {
    return String(station?.id ?? station?.hexId ?? station?.stationId ?? '');
  }

  function pointOf(station) {
    const x = Number(station?.x ?? station?.position?.x);
    const z = Number(station?.z ?? station?.position?.z);
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
  }

  function routeName(route) {
    return String(route?.name ?? route?.routeName ?? route?.route_name ?? '').trim();
  }

  function routeNumber(route) {
    const match = routeName(route).match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  function routeColor(route) {
    const raw = route?.color ?? route?.routeColor;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return `#${(raw & 0xffffff).toString(16).padStart(6, '0')}`;
    }
    const text = String(raw ?? '').trim();
    if (/^#?[0-9a-f]{6}$/i.test(text)) return text.startsWith('#') ? text : `#${text}`;
    if (/^\d+$/.test(text)) {
      const n = Number(text);
      if (Number.isFinite(n)) return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
    }
    return '#7aa2d6';
  }

  function routeClass(route) {
    const type = norm(route?.type);
    const name = norm(routeName(route));
    const number = routeNumber(route);
    const light = type.includes('light_rail') || type === 'train_light_rail';
    if (light && Number.isFinite(number) && number >= 1 && number <= 20) return 'tram';
    if (light && Number.isFinite(number) && number >= 100) return 'bus';
    if (type.includes('high_speed') || /^ic(?:_|$)/.test(name)) return 'high';
    if (type.includes('train_normal') || type === 'rail' || type === 'train') return 'rail';
    if (light) return 'light';
    return 'other';
  }

  function aliasFor(name) {
    const n = norm(name);
    if (['aleje_osamasona', 'stare_miasto', 'muzeum_narodowa', 'krolewska'].includes(n)) return 'hub:rynek';
    if (['folityn_wity', 'wity_pkm'].includes(n)) return 'hub:wity';
    if (n === 'folityn_centralny') return 'hub:centralny';
    return `s:${n}`;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function buildModel(data) {
    const routes = Array.isArray(data?.routes) ? data.routes : [];
    const stationNames = new Map();

    for (const station of Array.isArray(data?.stations) ? data.stations : []) {
      const id = stationId(station);
      if (id) stationNames.set(id, String(station?.name ?? station?.stationName ?? id));
    }

    const rawNodes = new Map();
    for (const route of routes) {
      for (const stop of routeStops(route)) {
        const id = stationId(stop);
        const point = pointOf(stop);
        if (!id || !point) continue;
        const name = stationNames.get(id) || String(stop?.name ?? id);
        const alias = aliasFor(name);
        if (!rawNodes.has(alias)) rawNodes.set(alias, { alias, names: new Set(), points: [] });
        rawNodes.get(alias).names.add(name);
        rawNodes.get(alias).points.push(point);
      }
    }

    const nodes = new Map();
    for (const [alias, raw] of rawNodes.entries()) {
      const names = [...raw.names];
      const displayName = alias === 'hub:rynek' ? 'RYNEK'
        : alias === 'hub:wity' ? 'Wity'
        : alias === 'hub:centralny' ? 'Folityn Centralny'
        : names[0] || alias.replace(/^s:/, '').replaceAll('_', ' ');
      nodes.set(alias, {
        alias,
        name: displayName,
        names,
        raw: {
          x: median(raw.points.map(p => p.x)),
          z: median(raw.points.map(p => p.z)),
        },
        pos: null,
        services: new Set(),
        oneWayServices: new Set(),
      });
    }

    const allRawX = [...nodes.values()].map(n => -n.raw.x);
    const allRawY = [...nodes.values()].map(n => -n.raw.z);
    const minX = Math.min(...allRawX);
    const maxX = Math.max(...allRawX);
    const minY = Math.min(...allRawY);
    const maxY = Math.max(...allRawY);
    const mapScale = Math.min(1800 / Math.max(1, maxX - minX), 1180 / Math.max(1, maxY - minY));

    for (const node of nodes.values()) {
      node.pos = {
        x: 140 + (-node.raw.x - minX) * mapScale,
        y: 140 + (-node.raw.z - minY) * mapScale,
      };
    }

    function routeSequence(route) {
      const sequence = [];
      for (const stop of routeStops(route)) {
        const id = stationId(stop);
        const name = stationNames.get(id) || String(stop?.name ?? id);
        const alias = aliasFor(name);
        if (!nodes.has(alias)) continue;
        if (sequence[sequence.length - 1] !== alias) sequence.push(alias);
      }
      return sequence;
    }

    function serviceKey(route) {
      const cls = routeClass(route);
      const number = routeNumber(route);
      const id = (cls === 'tram' || cls === 'bus') && Number.isFinite(number)
        ? String(number)
        : norm(routeName(route));
      return `${cls}|${id}|${routeColor(route)}`;
    }

    const grouped = new Map();
    for (const route of routes) {
      const cls = routeClass(route);
      if (cls === 'other') continue;
      const sequence = routeSequence(route);
      if (sequence.length < 2) continue;
      const key = serviceKey(route);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({ route, sequence });
    }

    function pathScore(sequence) {
      let length = 0;
      for (let i = 1; i < sequence.length; i++) {
        const a = nodes.get(sequence[i - 1])?.raw;
        const b = nodes.get(sequence[i])?.raw;
        if (a && b) length += Math.hypot(b.x - a.x, b.z - a.z);
      }
      const first = nodes.get(sequence[0])?.raw;
      const last = nodes.get(sequence[sequence.length - 1])?.raw;
      const direct = first && last ? Math.max(1, Math.hypot(last.x - first.x, last.z - first.z)) : 1;
      return length / direct + sequence.length * 0.002;
    }

    const services = [];
    for (const [key, variants] of grouped.entries()) {
      variants.sort((a, b) => pathScore(a.sequence) - pathScore(b.sequence));
      const canonical = [...variants[0].sequence];
      const canonicalSet = new Set(canonical);
      const extras = [];
      for (const variant of variants.slice(1)) {
        for (const alias of variant.sequence) {
          if (!canonicalSet.has(alias) && !extras.includes(alias)) extras.push(alias);
        }
      }
      const route = variants[0].route;
      const service = {
        key,
        name: routeName(route) || key,
        number: routeNumber(route),
        class: routeClass(route),
        color: routeColor(route),
        path: canonical,
        extras,
      };
      services.push(service);
      for (const alias of canonical) nodes.get(alias)?.services.add(key);
      for (const alias of extras) {
        nodes.get(alias)?.services.add(key);
        nodes.get(alias)?.oneWayServices.add(key);
      }
    }

    const find = (...names) => {
      const wanted = new Set(names.flat().map(norm));
      for (const node of nodes.values()) {
        if (wanted.has(norm(node.name))) return node;
        if (node.names.some(name => wanted.has(norm(name)))) return node;
      }
      return null;
    };

    function spacingBetween(a, b) {
      const ra = nodes.get(a)?.raw;
      const rb = nodes.get(b)?.raw;
      if (!ra || !rb) return 100;
      return Math.max(72, Math.min(128, Math.hypot(rb.x - ra.x, rb.z - ra.z) * 0.018));
    }

    function forceAxis(nameGroups, angle, anchorNames) {
      const chain = nameGroups.map(group => find(...(Array.isArray(group) ? group : [group]))).filter(Boolean);
      if (chain.length < 2) return;
      const anchor = find(...(Array.isArray(anchorNames) ? anchorNames : [anchorNames])) || chain[0];
      let index = chain.indexOf(anchor);
      if (index < 0) index = 0;
      const unit = { x: Math.cos(angle), y: Math.sin(angle) };
      const anchorPos = { ...anchor.pos };
      chain[index].pos = anchorPos;
      for (let i = index + 1; i < chain.length; i++) {
        const step = spacingBetween(chain[i - 1].alias, chain[i].alias);
        chain[i].pos = {
          x: chain[i - 1].pos.x + unit.x * step,
          y: chain[i - 1].pos.y + unit.y * step,
        };
      }
      for (let i = index - 1; i >= 0; i--) {
        const step = spacingBetween(chain[i].alias, chain[i + 1].alias);
        chain[i].pos = {
          x: chain[i + 1].pos.x - unit.x * step,
          y: chain[i + 1].pos.y - unit.y * step,
        };
      }
    }

    // Custom city structure. These move only the named schematic nodes; everything else stays near its Minecraft position.
    const rcm = find('Rogowska Centrum Miejskie');
    const rynek = nodes.get('hub:rynek');
    const centralny = nodes.get('hub:centralny');
    if (rcm && rynek) rynek.pos = { x: rcm.pos.x - 190, y: rcm.pos.y + 15 };
    if (rynek && centralny) centralny.pos = { x: rynek.pos.x + 70, y: rynek.pos.y - 125 };

    forceAxis([
      ['Wzgórzyn PKM', 'Wzgorzyn PKM'],
      ['Rakoniewicka'],
      ['Astrolitowska'],
      ['Końcowa', 'Koncowa'],
      ['Kraszewska'],
      ['Lepianki'],
      ['Kobylskiego'],
    ], -Math.PI / 4, ['Wzgórzyn PKM', 'Wzgorzyn PKM']);

    forceAxis([
      ['Rondo Larcho'],
      ['Most Śródmiejski', 'Most Srodmiejski'],
      ['Sucharskiego'],
      ['Rynek Chomicki'],
      ['Polna'],
      ['Rodowa'],
      ['Muzea'],
    ], Math.PI / 4, ['Rondo Larcho']);

    forceAxis([
      ['Rogowska Centrum Miejskie'],
      ['Witkowskiego'],
      ['Rogowska/Dąbka', 'Rogowska/Dabka'],
      ['Rogowska'],
      ['Charlińska', 'Charlinska'],
      ['Soperka'],
      ['Szwedzka/Norweska', 'Szwedzka Norweska'],
    ], Math.PI / 4, ['Rogowska Centrum Miejskie']);

    forceAxis([
      ['Rogowska Centrum Miejskie'],
      ['Maniaka'],
      ['Rondo Moryta-Niejawskiego'],
      ['Grochowa'],
      ['Folityn Jamnikowsko', 'Jamnikowsko'],
    ], 0, ['Rogowska Centrum Miejskie']);

    const drzewiecStart = find('Folityn Centralny');
    const drzewiecEnd = find('Drzewiec PKM');
    if (drzewiecStart && drzewiecEnd) {
      const rawAngle = Math.atan2(
        drzewiecEnd.pos.y - drzewiecStart.pos.y,
        drzewiecEnd.pos.x - drzewiecStart.pos.x
      );
      const candidates = [Math.PI / 4, -Math.PI / 4, 3 * Math.PI / 4, -3 * Math.PI / 4];
      const best = candidates.reduce((bestAngle, angle) => {
        const da = Math.abs(Math.atan2(Math.sin(angle - rawAngle), Math.cos(angle - rawAngle)));
        const db = Math.abs(Math.atan2(Math.sin(bestAngle - rawAngle), Math.cos(bestAngle - rawAngle)));
        return da < db ? angle : bestAngle;
      }, candidates[0]);
      forceAxis([
        ['Folityn Centralny'],
        ['Folityn Drzewiec'],
        ['Drzewiec PKM'],
        ['Słonecznikowa', 'Slonecznikowa'],
        ['Wypycha'],
        ['Brzozowo'],
      ], best, ['Folityn Centralny']);
    }

    const edges = new Map();
    function edgeKey(a, b) {
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    }
    for (const service of services) {
      for (let i = 1; i < service.path.length; i++) {
        const a = service.path[i - 1];
        const b = service.path[i];
        if (a === b) continue;
        const key = edgeKey(a, b);
        if (!edges.has(key)) edges.set(key, { key, a: a < b ? a : b, b: a < b ? b : a, services: [] });
        edges.get(key).services.push(service.key);
      }
    }
    for (const edge of edges.values()) edge.services = [...new Set(edge.services)].sort();

    return { nodes, services, edges };
  }

  function octilinear(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < 2 || ay < 2 || Math.abs(ax - ay) < 20) return [{ ...a }, { ...b }];
    const sx = Math.sign(dx) || 1;
    const sy = Math.sign(dy) || 1;
    const points = [{ ...a }];
    if (ax > ay) points.push({ x: a.x + sx * ay, y: a.y + sy * ay });
    else points.push({ x: a.x + sx * ax, y: a.y + sy * ax });
    points.push({ ...b });
    return points;
  }

  function pathString(points) {
    if (!points.length) return '';
    return `M ${points.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')}`;
  }

  function offsetPath(points, amount) {
    if (Math.abs(amount) < 0.001) return points.map(p => ({ ...p }));
    return points.map((point, index) => {
      let dx;
      let dy;
      if (index === 0) {
        dx = points[1].x - points[0].x;
        dy = points[1].y - points[0].y;
      } else if (index === points.length - 1) {
        dx = points[index].x - points[index - 1].x;
        dy = points[index].y - points[index - 1].y;
      } else {
        dx = points[index + 1].x - points[index - 1].x;
        dy = points[index + 1].y - points[index - 1].y;
      }
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len;
      let ny = dx / len;
      if (dx < 0 || (Math.abs(dx) < 0.001 && dy < 0)) {
        nx *= -1;
        ny *= -1;
      }
      return { x: point.x + nx * amount, y: point.y + ny * amount };
    });
  }

  function pointToPolyline(point, polyline) {
    let best = null;
    for (let i = 1; i < polyline.length; i++) {
      const a = polyline[i - 1];
      const b = polyline[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2)) : 0;
      const projected = { x: a.x + dx * t, y: a.y + dy * t };
      const d = distance(point, projected);
      if (!best || d < best.distance) best = { distance: d, point: projected, angle: Math.atan2(dy, dx) };
    }
    return best;
  }

  function isEnabled(serviceClass) {
    if (serviceClass === 'tram') return localStorage.getItem(`${STORE}tram`) !== '0';
    if (serviceClass === 'bus') return localStorage.getItem(`${STORE}bus`) !== '0';
    if (serviceClass === 'rail') return localStorage.getItem(`${STORE}rail`) !== '0';
    if (serviceClass === 'high') return localStorage.getItem(`${STORE}high`) !== '0';
    return true;
  }

  function injectStyle() {
    if (document.getElementById('folityn-v13-style')) return;
    const style = document.createElement('style');
    style.id = 'folityn-v13-style';
    style.textContent = `
      #folityn-v13-open{position:fixed;right:18px;bottom:18px;z-index:2147483646;border:1px solid #43536b;background:#111d30;color:#eef4ff;border-radius:10px;padding:10px 14px;font:700 12px system-ui;cursor:pointer;box-shadow:0 5px 22px #0009}
      #folityn-v13{position:fixed;inset:0;z-index:2147483647;background:#0b1220;color:#e9f0fa;font-family:system-ui;display:none;grid-template-columns:1fr 300px}
      #folityn-v13.open{display:grid}
      .fv13-map{position:relative;overflow:hidden;background:#0b1220}
      .fv13-map svg{width:100%;height:100%;display:block;touch-action:none;cursor:grab}
      .fv13-map.dragging svg{cursor:grabbing}
      .fv13-tools{position:absolute;left:14px;top:14px;display:flex;gap:7px;z-index:4}
      .fv13-button{border:1px solid #34455e;background:#121f33;color:#eef4ff;border-radius:8px;padding:8px 11px;font:700 11px system-ui;cursor:pointer}
      .fv13-side{background:#101827;border-left:1px solid #26364c;padding:15px;overflow:auto}
      .fv13-title{font-size:17px;font-weight:900}.fv13-sub{font-size:11px;color:#91a4bd;margin:4px 0 14px}
      .fv13-section{border-top:1px solid #29394f;margin-top:12px;padding-top:12px}
      .fv13-filter{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:12px}.fv13-filter input{accent-color:#70b7ff}
      .fv13-label{font:600 11px system-ui;fill:#e9f0fa;paint-order:stroke;stroke:#0b1220;stroke-width:4px;pointer-events:none}
      .fv13-label.major{font-size:14px;font-weight:900}
      .fv13-hit{fill:none;stroke:transparent;stroke-width:18;pointer-events:stroke;cursor:pointer}
      .fv13-station-hit{fill:transparent;stroke:transparent;stroke-width:16;pointer-events:all;cursor:pointer}
      .fv13-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid #34455e;background:#162338;border-radius:999px;padding:4px 7px;margin:3px;font-size:10px}.fv13-swatch{width:9px;height:9px;border-radius:50%}
      .fv13-info p{font-size:12px;color:#b8c7db;line-height:1.45}
      .fv13-status{font-size:11px;color:#9eb0c8;margin-top:8px}.fv13-error{color:#ff8794}
    `;
    document.head.appendChild(style);
  }

  function ensureUi() {
    injectStyle();
    if (!document.getElementById('folityn-v13-open')) {
      const open = document.createElement('button');
      open.id = 'folityn-v13-open';
      open.textContent = '🗺 Folityn Custom Map';
      open.addEventListener('click', openMap);
      document.body.appendChild(open);
    }

    if (document.getElementById('folityn-v13')) return;

    overlay = document.createElement('div');
    overlay.id = 'folityn-v13';

    const map = document.createElement('div');
    map.className = 'fv13-map';

    const tools = document.createElement('div');
    tools.className = 'fv13-tools';
    const close = document.createElement('button');
    close.className = 'fv13-button';
    close.textContent = 'Close';
    close.addEventListener('click', () => overlay.classList.remove('open'));
    const fit = document.createElement('button');
    fit.className = 'fv13-button';
    fit.textContent = 'Fit';
    fit.addEventListener('click', fitMap);
    const reload = document.createElement('button');
    reload.className = 'fv13-button';
    reload.textContent = 'Reload data';
    reload.addEventListener('click', () => loadAndRender(true));
    tools.append(close, fit, reload);
    map.appendChild(tools);

    const side = document.createElement('aside');
    side.className = 'fv13-side';
    side.innerHTML = '<div class="fv13-title">FOLITYN CUSTOM</div><div class="fv13-sub">Standalone shared-corridor schematic</div>';

    const filters = document.createElement('div');
    filters.className = 'fv13-section';
    const filterDefs = [
      ['tram', 'Trams 1–20'],
      ['bus', 'Buses 100+'],
      ['rail', 'Normal rail'],
      ['high', 'High speed / IC'],
    ];
    for (const [key, label] of filterDefs) {
      const row = document.createElement('label');
      row.className = 'fv13-filter';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = localStorage.getItem(`${STORE}${key}`) !== '0';
      box.addEventListener('change', () => {
        localStorage.setItem(`${STORE}${key}`, box.checked ? '1' : '0');
        if (network) renderMap(false);
      });
      row.append(box, document.createTextNode(label));
      filters.appendChild(row);
    }
    side.appendChild(filters);

    infoBox = document.createElement('div');
    infoBox.className = 'fv13-section fv13-info';
    infoBox.innerHTML = '<p>Click a station or route. Drag to pan and use the mouse wheel to zoom.</p>';
    side.appendChild(infoBox);

    const status = document.createElement('div');
    status.id = 'folityn-v13-status';
    status.className = 'fv13-status';
    status.textContent = 'Ready';
    side.appendChild(status);

    overlay.append(map, side);
    document.body.appendChild(overlay);
  }

  async function openMap() {
    ensureUi();
    overlay.classList.add('open');
    if (!network) await loadAndRender(true);
    else renderMap(false);
  }

  async function loadAndRender(shouldFit) {
    const status = document.getElementById('folityn-v13-status');
    if (status) {
      status.classList.remove('fv13-error');
      status.textContent = 'Loading live MTR data…';
    }
    try {
      const response = await fetch(`${API}&_=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`MTR API returned HTTP ${response.status}`);
      const json = await response.json();
      network = unwrap(json);
      if (!Array.isArray(network?.routes)) throw new Error('MTR API response has no routes array');
      model = buildModel(network);
      if (status) status.textContent = `${network.routes.length} route variants loaded`;
      renderMap(shouldFit);
    } catch (error) {
      console.error('[Folityn v13]', error);
      if (status) {
        status.classList.add('fv13-error');
        status.textContent = `Load failed: ${error.message}`;
      }
      if (infoBox) infoBox.innerHTML = `<p class="fv13-error"><b>Could not load the MTR network.</b><br>${String(error.message)}</p>`;
    }
  }

  function renderMap(shouldFit) {
    if (!model) return;
    const map = document.querySelector('#folityn-v13 .fv13-map');
    const oldSvg = map.querySelector('svg');
    if (oldSvg) oldSvg.remove();

    svg = createSvg('svg', { viewBox: '0 0 2200 1500' });
    viewport = createSvg('g');
    svg.appendChild(viewport);
    map.insertBefore(svg, map.firstChild);

    const visibleServices = model.services.filter(service => isEnabled(service.class));
    const serviceMap = new Map(visibleServices.map(service => [service.key, service]));
    const visibleKeys = new Set(serviceMap.keys());
    const nodeCounts = new Map();

    for (const service of visibleServices) {
      for (const alias of service.path) {
        if (!nodeCounts.has(alias)) nodeCounts.set(alias, new Set());
        nodeCounts.get(alias).add(service.key);
      }
    }

    for (const edge of model.edges.values()) {
      const used = edge.services.filter(key => visibleKeys.has(key));
      if (!used.length) continue;
      const a = model.nodes.get(edge.a)?.pos;
      const b = model.nodes.get(edge.b)?.pos;
      if (!a || !b) continue;
      const geometry = octilinear(a, b);
      const casing = createSvg('path', {
        d: pathString(geometry),
        fill: 'none',
        stroke: '#040810',
        'stroke-width': Math.max(10, used.length * 5 + 5),
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
      viewport.appendChild(casing);

      used.sort();
      used.forEach((key, index) => {
        const service = serviceMap.get(key);
        const lane = offsetPath(geometry, (index - (used.length - 1) / 2) * 4.4);
        const line = createSvg('path', {
          d: pathString(lane),
          fill: 'none',
          stroke: service.color,
          'stroke-width': 4.2,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'vector-effect': 'non-scaling-stroke',
        });
        viewport.appendChild(line);
        const hit = createSvg('path', { d: pathString(lane), class: 'fv13-hit' });
        hit.addEventListener('click', event => {
          event.stopPropagation();
          showRoute(service);
        });
        viewport.appendChild(hit);
      });
    }

    // One-way stops are visual markers only. They never create new route geometry.
    for (const service of visibleServices) {
      if (!service.extras.length) continue;
      const polyline = [];
      for (let i = 1; i < service.path.length; i++) {
        const a = model.nodes.get(service.path[i - 1])?.pos;
        const b = model.nodes.get(service.path[i])?.pos;
        if (!a || !b) continue;
        let part = octilinear(a, b);
        if (polyline.length) part = part.slice(1);
        polyline.push(...part);
      }
      for (const alias of service.extras) {
        const node = model.nodes.get(alias);
        if (!node || polyline.length < 2) continue;
        const projected = pointToPolyline(node.pos, polyline);
        if (!projected || projected.distance > 160) continue;
        const marker = createSvg('rect', {
          x: projected.point.x - 3,
          y: projected.point.y - 8,
          width: 6,
          height: 12,
          rx: 2,
          fill: '#0b1220',
          stroke: '#ffffff',
          'stroke-width': 2,
          transform: `rotate(${projected.angle * 180 / Math.PI} ${projected.point.x} ${projected.point.y})`,
          'vector-effect': 'non-scaling-stroke',
        });
        viewport.appendChild(marker);
      }
    }

    for (const node of model.nodes.values()) {
      const count = nodeCounts.get(node.alias)?.size || 0;
      if (!count) continue;
      const p = node.pos;
      const major = node.alias.startsWith('hub:') || count >= 4;
      const group = createSvg('g');

      if (node.alias === 'hub:rynek') {
        group.appendChild(createSvg('circle', { cx: p.x, cy: p.y, r: 27, fill: '#0b1220', stroke: '#ffffff', 'stroke-width': 4 }));
        group.appendChild(createSvg('circle', { cx: p.x, cy: p.y, r: 16, fill: '#17243a', stroke: '#ffffff', 'stroke-width': 2 }));
      } else if (node.alias === 'hub:centralny') {
        group.appendChild(createSvg('circle', { cx: p.x, cy: p.y, r: 19, fill: '#0b1220', stroke: '#ffffff', 'stroke-width': 4 }));
        const icon = createSvg('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', fill: '#ffffff', 'font-size': 12, 'font-weight': 900 });
        icon.textContent = '⇄';
        group.appendChild(icon);
      } else if (node.alias === 'hub:wity') {
        group.appendChild(createSvg('circle', { cx: p.x, cy: p.y, r: 14, fill: '#0b1220', stroke: '#ffffff', 'stroke-width': 3 }));
      } else if (count >= 4) {
        group.appendChild(createSvg('rect', { x: p.x - 9, y: p.y - 9, width: 18, height: 18, rx: 2, fill: '#0b1220', stroke: '#ffffff', 'stroke-width': 3 }));
      } else if (count >= 2) {
        group.appendChild(createSvg('rect', { x: p.x - 12, y: p.y - 7, width: 24, height: 14, rx: 7, fill: '#0b1220', stroke: '#ffffff', 'stroke-width': 3 }));
      } else {
        group.appendChild(createSvg('circle', { cx: p.x, cy: p.y, r: 6, fill: '#0b1220', stroke: '#ffffff', 'stroke-width': 2.5 }));
      }

      const stationHit = createSvg('circle', { cx: p.x, cy: p.y, r: 17, class: 'fv13-station-hit' });
      stationHit.addEventListener('click', event => {
        event.stopPropagation();
        showStation(node, visibleServices);
      });
      group.appendChild(stationHit);
      viewport.appendChild(group);

      const side = ((node.name.charCodeAt(0) || 0) % 2) ? 1 : -1;
      const label = createSvg('text', {
        x: p.x + 10 * side,
        y: p.y - 10,
        'text-anchor': side > 0 ? 'start' : 'end',
        class: `fv13-label${major ? ' major' : ''}`,
      });
      label.textContent = node.name;
      viewport.appendChild(label);
    }

    installPanZoom(map);
    if (shouldFit) requestAnimationFrame(fitMap);
    else applyTransform();
  }

  function showStation(node, visibleServices) {
    const services = visibleServices.filter(service => service.path.includes(node.alias) || service.extras.includes(node.alias));
    infoBox.innerHTML = `<h3>${node.name}</h3><p>${node.names.join(' · ')}</p><p>${services.length} visible services</p>`;
    for (const service of services) {
      const chip = document.createElement('span');
      chip.className = 'fv13-chip';
      const swatch = document.createElement('span');
      swatch.className = 'fv13-swatch';
      swatch.style.background = service.color;
      chip.append(swatch, document.createTextNode(service.name));
      infoBox.appendChild(chip);
    }
  }

  function showRoute(service) {
    infoBox.innerHTML = `<h3>${service.name}</h3><p>${service.class} · one physical schematic path</p><p>${service.path.map(alias => model.nodes.get(alias)?.name).filter(Boolean).join(' → ')}</p>`;
  }

  function applyTransform() {
    if (!viewport) return;
    viewport.setAttribute('transform', `translate(${transform.x} ${transform.y}) scale(${transform.scale})`);
  }

  function fitMap() {
    if (!model || !svg) return;
    const visibleServices = model.services.filter(service => isEnabled(service.class));
    const visibleKeys = new Set(visibleServices.map(service => service.key));
    const points = [...model.nodes.values()]
      .filter(node => [...node.services].some(key => visibleKeys.has(key)))
      .map(node => node.pos);
    if (!points.length) return;

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs) - 90;
    const maxX = Math.max(...xs) + 90;
    const minY = Math.min(...ys) - 90;
    const maxY = Math.max(...ys) + 90;
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / Math.max(1, maxX - minX), rect.height / Math.max(1, maxY - minY)) * 0.94;
    transform.scale = scale;
    transform.x = (rect.width / scale - (maxX - minX)) / 2 - minX;
    transform.y = (rect.height / scale - (maxY - minY)) / 2 - minY;
    applyTransform();
  }

  function installPanZoom(map) {
    let dragging = false;
    let last = null;
    svg.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const old = transform.scale;
      const next = Math.max(0.2, Math.min(5, old * Math.exp(-event.deltaY * 0.001)));
      const worldX = mx / old - transform.x;
      const worldY = my / old - transform.y;
      transform.scale = next;
      transform.x = mx / next - worldX;
      transform.y = my / next - worldY;
      applyTransform();
    }, { passive: false });

    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      dragging = true;
      last = { x: event.clientX, y: event.clientY };
      svg.setPointerCapture?.(event.pointerId);
      map.classList.add('dragging');
    });

    svg.addEventListener('pointermove', event => {
      if (!dragging) return;
      transform.x += (event.clientX - last.x) / transform.scale;
      transform.y += (event.clientY - last.y) / transform.scale;
      last = { x: event.clientX, y: event.clientY };
      applyTransform();
    });

    const stopDrag = () => {
      dragging = false;
      map.classList.remove('dragging');
    };
    svg.addEventListener('pointerup', stopDrag);
    svg.addEventListener('pointercancel', stopDrag);
  }

  function boot() {
    if (!document.body) {
      setTimeout(boot, 50);
      return;
    }
    ensureUi();
    console.info('[Folityn v13.1] UI ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
