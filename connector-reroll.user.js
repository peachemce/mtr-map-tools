// ==UserScript==
// @name         MTR Map Tools - Geo Schematic Renderer
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      1.2.0
// @description  Geography-preserving schematic renderer for dense MTR networks with stable route lanes, merged stations, filters, dark mode, and pan/zoom.
// @match        http://localhost:8888/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==

(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const STORE = 'mtr-geo-schematic-v12-';
  const CFG = {
    baseSpacing: 76,
    laneGap: 5.6,
    lineWidth: 4.5,
    iterations: 340,
    geographyPullJunction: 0.036,
    geographyPullOrdinary: 0.013,
    minNodeDistance: 38,
    contextRadius: 2,
    spacingUniformity: 0.58,
  };

  const state = {
    enabled: localStorage.getItem(STORE + 'enabled') !== '0',
    dark: localStorage.getItem(STORE + 'dark') === '1',
    labels: localStorage.getItem(STORE + 'labels') || 'key',
    visible: new Set(JSON.parse(localStorage.getItem(STORE + 'modes') || '["train","light_rail","high_speed","bus"]')),
    wrapper: null,
    canvas: null,
    overlay: null,
    svg: null,
    model: null,
    positions: null,
    view: null,
    fitView: null,
    drag: null,
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const colorHex = value => `#${((Number(value) >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
  const median = arr => {
    if (!arr.length) return 1;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  function routeMode(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('high_speed')) return 'high_speed';
    if (t.includes('light_rail') || t.includes('tram')) return 'light_rail';
    if (t.includes('train')) return 'train';
    return 'bus';
  }

  function modePriority(mode) {
    return ({ high_speed: 0, train: 1, light_rail: 2, bus: 3 })[mode] ?? 4;
  }

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  function lineAngle(angle) {
    let a = angle % Math.PI;
    if (a < 0) a += Math.PI;
    return a;
  }

  function snap45Line(angle) {
    const a = lineAngle(angle);
    return lineAngle(Math.round(a / (Math.PI / 4)) * (Math.PI / 4));
  }

  function directedAngleForPair(line, aPos, bPos) {
    let angle = line;
    const ux = Math.cos(angle), uz = Math.sin(angle);
    const dx = bPos.x - aPos.x, dz = bPos.z - aPos.z;
    if (ux * dx + uz * dz < 0) angle += Math.PI;
    return angle;
  }

  function stableLineNormal(line) {
    const a = lineAngle(line);
    return { x: -Math.sin(a), z: Math.cos(a) };
  }

  async function waitForMap() {
    for (;;) {
      const wrapper = document.querySelector('app-map .wrapper, .wrapper');
      const canvas = wrapper?.querySelector('canvas');
      if (wrapper && canvas) return { wrapper, canvas };
      await new Promise(r => setTimeout(r, 250));
    }
  }

  async function loadNetwork() {
    const response = await fetch('/mtr/api/map/stations-and-routes?dimension=0', { cache: 'no-store' });
    if (!response.ok) throw new Error(`MTR network request failed (${response.status})`);
    const json = await response.json();
    return json?.data ?? json;
  }

  function buildModel(data) {
    const rawStations = data.stations || [];
    const rawRoutes = (data.routes || []).filter(r => !r.hidden && Array.isArray(r.stations) && r.stations.length >= 2);

    const groupsByName = new Map();
    const idToNode = new Map();
    for (const s of rawStations) {
      const key = norm(s.name) || `id:${s.id}`;
      let g = groupsByName.get(key);
      if (!g) {
        g = { id: `name:${key}`, name: String(s.name || s.id), rawIds: new Set(), connections: new Set() };
        groupsByName.set(key, g);
      }
      g.rawIds.add(s.id);
      idToNode.set(s.id, g.id);
    }
    for (const s of rawStations) {
      const from = idToNode.get(s.id);
      const g = [...groupsByName.values()].find(x => x.id === from);
      if (!g) continue;
      for (const otherRaw of s.connections || []) {
        const other = idToNode.get(otherRaw);
        if (other && other !== from) g.connections.add(other);
      }
    }

    const stationMeta = new Map([...groupsByName.values()].map(g => [g.id, g]));
    const occurrences = new Map();
    const routeMembership = new Map();
    const routes = [];
    const edgeMap = new Map();
    const routeEndpoints = new Set();

    function ensureNode(rawId, fallbackName) {
      let node = idToNode.get(rawId);
      if (node) return node;
      node = `id:${rawId}`;
      idToNode.set(rawId, node);
      if (!stationMeta.has(node)) stationMeta.set(node, { id: node, name: fallbackName || rawId, rawIds: new Set([rawId]), connections: new Set() });
      return node;
    }

    for (const raw of rawRoutes) {
      const seq = [];
      for (const s of raw.stations) {
        if (!s?.id || !Number.isFinite(Number(s.x)) || !Number.isFinite(Number(s.z))) continue;
        const node = ensureNode(s.id, s.name);
        const item = { node, x: Number(s.x), z: Number(s.z) };
        if (seq.at(-1)?.node !== node) seq.push(item);
        if (!occurrences.has(node)) occurrences.set(node, []);
        occurrences.get(node).push({ x: item.x, z: item.z });
        if (!routeMembership.has(node)) routeMembership.set(node, new Set());
        routeMembership.get(node).add(raw.id);
      }
      if (seq.length < 2) continue;
      const route = { ...raw, mode: routeMode(raw.type), seq, nodes: seq.map(x => x.node) };
      routes.push(route);
      routeEndpoints.add(route.nodes[0]);
      routeEndpoints.add(route.nodes.at(-1));

      for (let i = 1; i < seq.length; i++) {
        const left = seq[i - 1], right = seq[i];
        if (left.node === right.node) continue;
        const key = pairKey(left.node, right.node);
        let edge = edgeMap.get(key);
        if (!edge) {
          edge = { key, a: left.node < right.node ? left.node : right.node, b: left.node < right.node ? right.node : left.node, routes: new Set(), angleSamples: [], rawSamples: [] };
          edgeMap.set(key, edge);
        }
        edge.routes.add(raw.id);
        edge.rawSamples.push({ x1: left.x, z1: left.z, x2: right.x, z2: right.z });

        const from = Math.max(0, i - 1 - CFG.contextRadius);
        const to = Math.min(seq.length - 1, i + CFG.contextRadius);
        const c1 = seq[from], c2 = seq[to];
        const dx = c2.x - c1.x, dz = c2.z - c1.z;
        if (Math.hypot(dx, dz) > 1) edge.angleSamples.push(Math.atan2(dz, dx));
      }
    }

    const routeById = new Map(routes.map(r => [r.id, r]));
    const original = new Map();
    for (const [id, pts] of occurrences) {
      original.set(id, {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
      });
    }

    const rawLens = [];
    for (const edge of edgeMap.values()) {
      const a = original.get(edge.a), b = original.get(edge.b);
      if (a && b) rawLens.push(Math.hypot(b.x - a.x, b.z - a.z));
    }
    const rawMedian = Math.max(1, median(rawLens));
    const geoScale = CFG.baseSpacing / rawMedian;
    const geo = new Map([...original].map(([id, p]) => [id, { x: p.x * geoScale, z: p.z * geoScale }]));

    const adjacency = new Map([...original.keys()].map(id => [id, []]));
    for (const edge of edgeMap.values()) {
      adjacency.get(edge.a)?.push(edge);
      adjacency.get(edge.b)?.push(edge);
    }

    const transferPairs = new Set();
    for (const meta of stationMeta.values()) {
      if (!original.has(meta.id)) continue;
      for (const other of meta.connections || []) {
        if (original.has(other) && other !== meta.id) transferPairs.add(pairKey(meta.id, other));
      }
    }

    for (const edge of edgeMap.values()) {
      let sx = 0, sy = 0;
      const samples = edge.angleSamples.length ? edge.angleSamples : edge.rawSamples.map(s => Math.atan2(s.z2 - s.z1, s.x2 - s.x1));
      for (const a of samples) { sx += Math.cos(2 * a); sy += Math.sin(2 * a); }
      let dominant = 0.5 * Math.atan2(sy, sx);
      if (!Number.isFinite(dominant)) dominant = 0;
      edge.lineAngle = snap45Line(dominant);

      const a = original.get(edge.a), b = original.get(edge.b);
      const rawLen = Math.max(1, Math.hypot(b.x - a.x, b.z - a.z) * geoScale);
      const blended = Math.exp((1 - CFG.spacingUniformity) * Math.log(rawLen) + CFG.spacingUniformity * Math.log(CFG.baseSpacing));
      edge.targetLength = clamp(blended, CFG.baseSpacing * 0.52, CFG.baseSpacing * 1.85);
    }

    const globalRouteOrder = [...routes].sort((ra, rb) =>
      modePriority(ra.mode) - modePriority(rb.mode) ||
      String(ra.name || '').localeCompare(String(rb.name || '')) ||
      String(ra.id).localeCompare(String(rb.id))
    );
    const routeRank = new Map(globalRouteOrder.map((r, i) => [r.id, i]));

    return { data, routes, routeById, routeRank, stationMeta, original, geo, edgeMap, adjacency, routeMembership, routeEndpoints, transferPairs };
  }

  function solveLayout(model) {
    const pos = new Map([...model.geo].map(([id, p]) => [id, { ...p }]));
    const constraints = [];

    for (const edge of model.edgeMap.values()) {
      const a0 = model.geo.get(edge.a), b0 = model.geo.get(edge.b);
      if (!a0 || !b0) continue;
      const angle = directedAngleForPair(edge.lineAngle, a0, b0);
      constraints.push({
        a: edge.a,
        b: edge.b,
        vx: Math.cos(angle) * edge.targetLength,
        vz: Math.sin(angle) * edge.targetLength,
        weight: 0.85 + Math.min(1.2, Math.log2(edge.routes.size + 1) * 0.28),
      });
    }

    for (const key of model.transferPairs) {
      const [a, b] = key.split('|');
      const a0 = model.geo.get(a), b0 = model.geo.get(b);
      if (!a0 || !b0) continue;
      const rawAngle = Math.atan2(b0.z - a0.z, b0.x - a0.x);
      const line = snap45Line(rawAngle);
      const angle = directedAngleForPair(line, a0, b0);
      constraints.push({ a, b, vx: Math.cos(angle) * CFG.baseSpacing * 0.38, vz: Math.sin(angle) * CFG.baseSpacing * 0.38, weight: 1.9, transfer: true });
    }

    const degree = new Map([...pos.keys()].map(id => [id, model.adjacency.get(id)?.length || 0]));
    const components = [];
    const seen = new Set();
    for (const id of pos.keys()) {
      if (seen.has(id)) continue;
      const stack = [id], ids = [];
      seen.add(id);
      while (stack.length) {
        const cur = stack.pop(); ids.push(cur);
        for (const edge of model.adjacency.get(cur) || []) {
          const other = edge.a === cur ? edge.b : edge.a;
          if (!seen.has(other)) { seen.add(other); stack.push(other); }
        }
      }
      components.push(ids);
    }

    const originalCentroids = components.map(ids => {
      let x = 0, z = 0;
      for (const id of ids) { const p = model.geo.get(id); x += p.x; z += p.z; }
      return { x: x / ids.length, z: z / ids.length };
    });

    for (let iter = 0; iter < CFG.iterations; iter++) {
      const t = iter / Math.max(1, CFG.iterations - 1);
      const step = 0.145 * (1 - 0.72 * t);

      for (const c of constraints) {
        const a = pos.get(c.a), b = pos.get(c.b);
        if (!a || !b) continue;
        const ex = (b.x - a.x) - c.vx;
        const ez = (b.z - a.z) - c.vz;
        const gain = step * c.weight;
        a.x += ex * gain * 0.5; a.z += ez * gain * 0.5;
        b.x -= ex * gain * 0.5; b.z -= ez * gain * 0.5;
      }

      for (const [id, p] of pos) {
        const g = model.geo.get(id);
        const memberships = model.routeMembership.get(id)?.size || 0;
        const important = (degree.get(id) || 0) !== 2 || memberships >= 3 || model.routeEndpoints.has(id);
        const pull = important ? CFG.geographyPullJunction : CFG.geographyPullOrdinary;
        p.x += (g.x - p.x) * pull;
        p.z += (g.z - p.z) * pull;
      }

      if (iter % 12 === 0) {
        const ids = [...pos.keys()].filter(id => (degree.get(id) || 0) !== 2 || (model.routeMembership.get(id)?.size || 0) >= 3);
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const a = pos.get(ids[i]), b = pos.get(ids[j]);
            let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
            if (d >= CFG.minNodeDistance) continue;
            if (d < 0.001) { dx = 1; dz = 0; d = 1; }
            const push = (CFG.minNodeDistance - d) * 0.035;
            const ux = dx / d, uz = dz / d;
            a.x -= ux * push; a.z -= uz * push;
            b.x += ux * push; b.z += uz * push;
          }
        }
      }

      if (iter % 10 === 0) {
        components.forEach((ids, ci) => {
          let x = 0, z = 0;
          for (const id of ids) { const p = pos.get(id); x += p.x; z += p.z; }
          x /= ids.length; z /= ids.length;
          const target = originalCentroids[ci];
          const dx = (target.x - x) * 0.18, dz = (target.z - z) * 0.18;
          for (const id of ids) { const p = pos.get(id); p.x += dx; p.z += dz; }
        });
      }
    }

    return pos;
  }

  function visibleRoute(route) { return state.visible.has(route?.mode || 'bus'); }

  function edgeRouteIds(edge, model) {
    return [...edge.routes].sort((a, b) => (model.routeRank.get(a) ?? 1e9) - (model.routeRank.get(b) ?? 1e9));
  }

  function laneOffset(routeId, edge, model) {
    const ids = edgeRouteIds(edge, model);
    const index = ids.indexOf(routeId);
    if (index < 0) return 0;
    return (index - (ids.length - 1) / 2) * CFG.laneGap;
  }

  function offsetVectorForEdge(routeId, edge, model) {
    const n = stableLineNormal(edge.lineAngle);
    const off = laneOffset(routeId, edge, model);
    return { x: n.x * off, z: n.z * off };
  }

  function routeDisplayPoints(route, model, positions) {
    const out = [];
    for (let i = 0; i < route.nodes.length; i++) {
      const id = route.nodes[i];
      const p = positions.get(id);
      if (!p) continue;
      const vectors = [];
      if (i > 0) {
        const e = model.edgeMap.get(pairKey(route.nodes[i - 1], id));
        if (e) vectors.push(offsetVectorForEdge(route.id, e, model));
      }
      if (i < route.nodes.length - 1) {
        const e = model.edgeMap.get(pairKey(id, route.nodes[i + 1]));
        if (e) vectors.push(offsetVectorForEdge(route.id, e, model));
      }
      const ox = vectors.length ? vectors.reduce((s, v) => s + v.x, 0) / vectors.length : 0;
      const oz = vectors.length ? vectors.reduce((s, v) => s + v.z, 0) / vectors.length : 0;
      out.push({ x: p.x + ox, z: p.z + oz });
    }
    return out;
  }

  function fitBounds(positions) {
    const vals = [...positions.values()];
    const minX = Math.min(...vals.map(p => p.x)), maxX = Math.max(...vals.map(p => p.x));
    const minZ = Math.min(...vals.map(p => p.z)), maxZ = Math.max(...vals.map(p => p.z));
    const pad = 120;
    return { x: minX - pad, y: minZ - pad, w: Math.max(500, maxX - minX + pad * 2), h: Math.max(360, maxZ - minZ + pad * 2) };
  }

  function applyView() {
    if (!state.svg || !state.view) return;
    state.svg.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
  }

  function installPanZoom(svg) {
    svg.style.touchAction = 'none';
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = state.view.x + (e.clientX - rect.left) / rect.width * state.view.w;
      const my = state.view.y + (e.clientY - rect.top) / rect.height * state.view.h;
      const factor = e.deltaY > 0 ? 1.12 : 0.89;
      state.view.x = mx + (state.view.x - mx) * factor;
      state.view.y = my + (state.view.y - my) * factor;
      state.view.w *= factor; state.view.h *= factor;
      applyView();
    }, { passive: false });
    svg.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      svg.setPointerCapture(e.pointerId);
      svg.style.cursor = 'grabbing';
      state.drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
    });
    svg.addEventListener('pointermove', e => {
      if (!state.drag) return;
      const rect = svg.getBoundingClientRect();
      state.view.x = state.drag.vx - (e.clientX - state.drag.x) / rect.width * state.view.w;
      state.view.y = state.drag.vy - (e.clientY - state.drag.y) / rect.height * state.view.h;
      applyView();
    });
    const end = () => { state.drag = null; svg.style.cursor = 'grab'; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', () => { state.view = { ...state.fitView }; applyView(); });
  }

  function setOriginalVisible(show) {
    if (!state.wrapper) return;
    if (state.canvas) state.canvas.style.visibility = show ? '' : 'hidden';
    state.wrapper.querySelectorAll('.label').forEach(el => el.style.visibility = show ? '' : 'hidden');
    if (state.overlay) state.overlay.style.display = show ? 'none' : '';
  }

  function render() {
    if (!state.model || !state.positions || !state.wrapper) return;
    document.getElementById('mtr-schematic-overlay')?.remove();
    document.getElementById('mtr-schematic-controls')?.remove();

    const model = state.model;
    const positions = state.positions;
    const bg = state.dark ? '#111827' : '#f8fafc';
    const fg = state.dark ? '#e5e7eb' : '#111827';
    const halo = state.dark ? '#111827' : '#ffffff';
    const transfer = state.dark ? '#cbd5e1' : '#222222';

    state.wrapper.style.position = 'relative';
    const overlay = document.createElement('div');
    overlay.id = 'mtr-schematic-overlay';
    Object.assign(overlay.style, { position: 'absolute', inset: '0', zIndex: '20', background: bg, overflow: 'hidden' });
    const svg = svgEl('svg', { width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet' });
    svg.style.display = 'block'; svg.style.cursor = 'grab';
    overlay.appendChild(svg); state.wrapper.appendChild(overlay);

    const routesLayer = svgEl('g');
    const transferLayer = svgEl('g');
    const stationsLayer = svgEl('g');
    const labelsLayer = svgEl('g');
    svg.append(routesLayer, transferLayer, stationsLayer, labelsLayer);

    const sortedRoutes = [...model.routes].sort((a, b) => (model.routeRank.get(a.id) ?? 0) - (model.routeRank.get(b.id) ?? 0));
    for (const route of sortedRoutes) {
      if (!visibleRoute(route)) continue;
      const pts = routeDisplayPoints(route, model, positions);
      if (pts.length < 2) continue;
      routesLayer.appendChild(svgEl('polyline', {
        points: pts.map(p => `${p.x},${p.z}`).join(' '),
        fill: 'none',
        stroke: colorHex(route.color),
        'stroke-width': CFG.lineWidth,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke',
      }));
    }

    for (const key of model.transferPairs) {
      const [a, b] = key.split('|');
      const p1 = positions.get(a), p2 = positions.get(b);
      if (!p1 || !p2) continue;
      transferLayer.appendChild(svgEl('line', {
        x1: p1.x, y1: p1.z, x2: p2.x, y2: p2.z,
        stroke: transfer, 'stroke-width': 2.2, 'stroke-dasharray': '6 5', 'vector-effect': 'non-scaling-stroke',
      }));
    }

    for (const [id, p] of positions) {
      const memberships = [...(model.routeMembership.get(id) || [])].filter(rid => visibleRoute(model.routeById.get(rid)));
      if (!memberships.length) continue;
      const meta = model.stationMeta.get(id);
      const count = memberships.length;
      const degree = model.adjacency.get(id)?.length || 0;
      const important = degree !== 2 || count >= 3 || model.routeEndpoints.has(id);
      const r = 3.1 + Math.min(8.8, Math.log2(count + 1) * 2.15);
      const c = svgEl('circle', {
        cx: p.x, cy: p.z, r,
        fill: bg, stroke: fg, 'stroke-width': important ? 2.1 : 1.45,
        'vector-effect': 'non-scaling-stroke',
      });
      const title = svgEl('title');
      title.textContent = `${meta?.name || id} · ${count} route${count === 1 ? '' : 's'}`;
      c.appendChild(title); stationsLayer.appendChild(c);

      const show = state.labels === 'all' || (state.labels === 'key' && important);
      if (show && meta?.name) {
        const text = svgEl('text', {
          x: p.x + r + 4, y: p.z - r - 2,
          'font-size': important ? 10.5 : 8.8,
          'font-family': 'system-ui, sans-serif',
          'font-weight': important ? 650 : 500,
          fill: fg, stroke: halo, 'stroke-width': 3.5, 'paint-order': 'stroke',
          'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
        });
        text.textContent = meta.name; labelsLayer.appendChild(text);
      }
    }

    state.overlay = overlay;
    state.svg = svg;
    state.fitView = fitBounds(positions);
    if (!state.view) state.view = { ...state.fitView };
    applyView();
    installPanZoom(svg);
    installControls();
    setOriginalVisible(!state.enabled);
  }

  function controlButton(text) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = text;
    Object.assign(b.style, { border: '1px solid #4b5563', borderRadius: '7px', padding: '6px 8px', background: '#1f2937', color: '#fff', cursor: 'pointer', font: 'inherit' });
    return b;
  }

  function installControls() {
    const panel = document.createElement('div');
    panel.id = 'mtr-schematic-controls';
    Object.assign(panel.style, {
      position: 'fixed', left: '14px', bottom: '14px', zIndex: '1000000', width: '276px',
      padding: '10px', borderRadius: '10px', background: 'rgba(17,24,39,.96)', color: '#fff',
      font: '600 12px/1.3 system-ui,sans-serif', boxShadow: '0 5px 20px rgba(0,0,0,.3)',
    });

    const title = document.createElement('div');
    title.innerHTML = '<strong style="font-size:14px">Geo schematic</strong><div style="opacity:.66;font-weight:500;margin-top:2px">coarse geography preserved · micro-bends removed · stable lanes</div>';

    const top = document.createElement('div');
    top.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:8px';
    const schematic = controlButton('Schematic');
    const original = controlButton('Original');
    const fit = controlButton('Fit');
    top.append(schematic, original, fit);

    const modes = document.createElement('div');
    modes.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin-top:9px;font-weight:500';
    const labels = { train: 'Train', light_rail: 'Light rail', high_speed: 'High speed', bus: 'Bus/other' };
    for (const mode of ['train', 'light_rail', 'high_speed', 'bus']) {
      const lab = document.createElement('label'); lab.style.cssText = 'display:flex;align-items:center;gap:5px';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = state.visible.has(mode);
      cb.onchange = () => {
        if (cb.checked) state.visible.add(mode); else state.visible.delete(mode);
        localStorage.setItem(STORE + 'modes', JSON.stringify([...state.visible]));
        render();
      };
      lab.append(cb, document.createTextNode(labels[mode])); modes.appendChild(lab);
    }

    const bottom = document.createElement('div');
    bottom.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px';
    const labelSelect = document.createElement('select');
    labelSelect.innerHTML = '<option value="key">Key labels</option><option value="all">All labels</option><option value="none">No labels</option>';
    labelSelect.value = state.labels;
    Object.assign(labelSelect.style, { padding: '6px', borderRadius: '7px', background: '#1f2937', color: '#fff', border: '1px solid #4b5563' });
    const dark = controlButton(state.dark ? 'Light mode' : 'Dark mode');
    bottom.append(labelSelect, dark);

    const note = document.createElement('div');
    note.style.cssText = 'opacity:.62;font-size:11px;font-weight:500;margin-top:7px';
    note.textContent = `${state.model.routes.length} routes · ${state.positions.size} merged stations · drag to pan · wheel to zoom`;

    schematic.onclick = () => { state.enabled = true; localStorage.setItem(STORE + 'enabled', '1'); setOriginalVisible(false); };
    original.onclick = () => { state.enabled = false; localStorage.setItem(STORE + 'enabled', '0'); setOriginalVisible(true); };
    fit.onclick = () => { state.view = { ...state.fitView }; applyView(); };
    labelSelect.onchange = () => { state.labels = labelSelect.value; localStorage.setItem(STORE + 'labels', state.labels); render(); };
    dark.onclick = () => { state.dark = !state.dark; localStorage.setItem(STORE + 'dark', state.dark ? '1' : '0'); render(); };

    panel.append(title, top, modes, bottom, note);
    document.body.appendChild(panel);
  }

  async function main() {
    try {
      const [{ wrapper, canvas }, data] = await Promise.all([waitForMap(), loadNetwork()]);
      state.wrapper = wrapper; state.canvas = canvas;
      state.model = buildModel(data);
      state.positions = solveLayout(state.model);
      render();
      console.log('[MTR Map Tools] geo schematic renderer v1.2 loaded', {
        routes: state.model.routes.length,
        mergedStations: state.positions.size,
        edges: state.model.edgeMap.size,
      });
    } catch (error) {
      console.error('[MTR Map Tools] geo schematic renderer failed:', error);
    }
  }

  main();
})();