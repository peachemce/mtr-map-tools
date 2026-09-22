// ==UserScript==
// @name         MTR Map Tools - Corridor Schematic Renderer
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      1.1.0
// @description  Corridor-first schematic renderer for dense MTR networks: merged stations, mode filters, dark mode, pan/zoom, and street spines.
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
  const CFG = {
    baseSpacing: 86,
    lineWidth: 4.5,
    laneGap: 5.8,
    geographyPull: 0.004,
    iterations: 360,
    minAnchorDistance: 58,
  };

  // These are DESIGN spines, not geographic bearings. They tell the schematic
  // renderer that the named stops belong to one visually straight street.
  // More streets can be added later without touching the layout engine.
  const STREET_SPINES = [
    {
      name: 'Rogowska',
      angle: 0, // horizontal on the schematic
      stations: [
        'Rogowska Centrum Miejskie',
        'Witkowskiego',
        'Rogowska/Dąbka',
        'Rogowska',
      ],
    },
  ];

  const state = {
    enabled: localStorage.getItem('mtr-schematic-renderer-enabled') !== '0',
    dark: localStorage.getItem('mtr-schematic-renderer-dark') === '1',
    labelMode: localStorage.getItem('mtr-schematic-renderer-labels') || 'key',
    visible: new Set(JSON.parse(localStorage.getItem('mtr-schematic-renderer-modes') || '["train","light_rail","high_speed","bus"]')),
    overlay: null,
    wrapper: null,
    svg: null,
    canvas: null,
    model: null,
    positions: null,
    view: null,
    fitView: null,
    drag: null,
  };

  const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const median = values => {
    if (!values.length) return 1;
    const v = [...values].sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const colorHex = value => `#${((Number(value) >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
  const snap45 = angle => Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);

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

  function principalAngle(points, fallbackStart, fallbackEnd) {
    if (points.length < 2) return 0;
    let mx = 0, mz = 0;
    for (const p of points) { mx += p.x; mz += p.z; }
    mx /= points.length; mz /= points.length;
    let xx = 0, zz = 0, xz = 0;
    for (const p of points) {
      const x = p.x - mx, z = p.z - mz;
      xx += x * x; zz += z * z; xz += x * z;
    }
    let a = 0.5 * Math.atan2(2 * xz, xx - zz);
    const fx = fallbackEnd.x - fallbackStart.x;
    const fz = fallbackEnd.z - fallbackStart.z;
    if (Math.cos(a) * fx + Math.sin(a) * fz < 0) a += Math.PI;
    return a;
  }

  function buildModel(data) {
    const rawRoutes = (data.routes || []).filter(r => !r.hidden && Array.isArray(r.stations) && r.stations.length >= 2);
    const rawStations = data.stations || [];

    // Merge all physical MTR station IDs that have the same visible station name.
    const groupByName = new Map();
    const idToNode = new Map();
    for (const s of rawStations) {
      const keyName = norm(s.name) || `id:${s.id}`;
      let g = groupByName.get(keyName);
      if (!g) {
        g = { id: `name:${keyName}`, name: String(s.name || '').trim() || s.id, ids: new Set(), connections: new Set(), color: s.color };
        groupByName.set(keyName, g);
      }
      g.ids.add(s.id);
      idToNode.set(s.id, g.id);
    }
    for (const s of rawStations) {
      const from = idToNode.get(s.id);
      const g = [...groupByName.values()].find(x => x.id === from);
      if (!g) continue;
      for (const c of s.connections || []) {
        const to = idToNode.get(c);
        if (to && to !== from) g.connections.add(to);
      }
    }

    const stationMeta = new Map([...groupByName.values()].map(g => [g.id, g]));
    const nameToNode = new Map([...stationMeta.values()].map(g => [norm(g.name), g.id]));
    const occurrences = new Map();
    const routeMembership = new Map();
    const routeEdges = new Map();
    const routeEndpoints = new Set();
    const routes = [];

    for (const raw of rawRoutes) {
      const usable = [];
      for (const s of raw.stations) {
        if (!s?.id || !Number.isFinite(Number(s.x)) || !Number.isFinite(Number(s.z))) continue;
        let node = idToNode.get(s.id);
        if (!node) {
          node = `id:${s.id}`;
          idToNode.set(s.id, node);
          if (!stationMeta.has(node)) stationMeta.set(node, { id: node, name: s.id, ids: new Set([s.id]), connections: new Set(), color: raw.color });
        }
        const item = { node, x: Number(s.x), z: Number(s.z) };
        if (usable.at(-1)?.node !== node) usable.push(item);
        if (!occurrences.has(node)) occurrences.set(node, []);
        occurrences.get(node).push({ x: item.x, z: item.z });
        if (!routeMembership.has(node)) routeMembership.set(node, new Set());
        routeMembership.get(node).add(raw.id);
      }
      if (usable.length < 2) continue;
      const route = { ...raw, mode: routeMode(raw.type), nodes: usable.map(x => x.node) };
      routes.push(route);
      routeEndpoints.add(route.nodes[0]);
      routeEndpoints.add(route.nodes.at(-1));
      for (let i = 1; i < route.nodes.length; i++) {
        const a = route.nodes[i - 1], b = route.nodes[i];
        if (a === b) continue;
        const key = pairKey(a, b);
        let edge = routeEdges.get(key);
        if (!edge) {
          edge = { key, a: a < b ? a : b, b: a < b ? b : a, routes: new Set() };
          routeEdges.set(key, edge);
        }
        edge.routes.add(route.id);
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

    const rawLengths = [];
    for (const e of routeEdges.values()) {
      const a = original.get(e.a), b = original.get(e.b);
      if (a && b) rawLengths.push(Math.hypot(b.x - a.x, b.z - a.z));
    }
    const geoScale = CFG.baseSpacing / Math.max(1, median(rawLengths));
    const geo = new Map([...original].map(([id, p]) => [id, { x: p.x * geoScale, z: p.z * geoScale }]));

    const adjacency = new Map([...original.keys()].map(id => [id, []]));
    for (const edge of routeEdges.values()) {
      adjacency.get(edge.a)?.push(edge);
      adjacency.get(edge.b)?.push(edge);
    }

    const transferPairs = new Set();
    for (const meta of stationMeta.values()) {
      if (!original.has(meta.id)) continue;
      for (const other of meta.connections || []) if (original.has(other) && other !== meta.id) transferPairs.add(pairKey(meta.id, other));
    }

    const anchors = new Set();
    for (const id of original.keys()) {
      const degree = adjacency.get(id)?.length || 0;
      const memberships = routeMembership.get(id)?.size || 0;
      const hasTransfer = [...transferPairs].some(k => k.startsWith(`${id}|`) || k.endsWith(`|${id}`));
      if (degree !== 2 || routeEndpoints.has(id) || memberships >= 3 || hasTransfer) anchors.add(id);
    }

    // Street-spine stops must be explicit anchors so the whole graph can reflow around them.
    const streetConstraints = [];
    for (const spine of STREET_SPINES) {
      const ids = spine.stations.map(n => nameToNode.get(norm(n))).filter(Boolean);
      for (const id of ids) anchors.add(id);
      for (let i = 1; i < ids.length; i++) {
        if (ids[i - 1] !== ids[i]) streetConstraints.push({ a: ids[i - 1], b: ids[i], angle: spine.angle, street: spine.name });
      }
    }

    // Build corridor chains between anchors. Intermediate micro-bends are intentionally swallowed.
    const chains = [];
    const visited = new Set();
    for (const start of anchors) {
      for (const first of adjacency.get(start) || []) {
        if (visited.has(first.key)) continue;
        const nodes = [start], edges = [];
        let current = start, edge = first;
        while (edge) {
          visited.add(edge.key);
          edges.push(edge);
          const next = edge.a === current ? edge.b : edge.a;
          nodes.push(next);
          if (anchors.has(next) && next !== start) break;
          const opts = (adjacency.get(next) || []).filter(e => !visited.has(e.key));
          if (opts.length !== 1) break;
          current = next;
          edge = opts[0];
        }
        if (nodes.length >= 2) chains.push({ nodes, edges });
      }
    }
    for (const edge of routeEdges.values()) if (!visited.has(edge.key)) chains.push({ nodes: [edge.a, edge.b], edges: [edge] });

    return { data, routes, routeById, stationMeta, nameToNode, original, geo, routeEdges, routeMembership, adjacency, anchors, chains, transferPairs, streetConstraints };
  }

  function solveLayout(model) {
    const { geo, chains, anchors } = model;
    const pos = new Map([...anchors].filter(id => geo.has(id)).map(id => [id, { ...geo.get(id) }]));
    const constraints = [];

    for (const chain of chains) {
      const aId = chain.nodes[0], bId = chain.nodes.at(-1);
      if (!pos.has(aId) || !pos.has(bId) || aId === bId) continue;
      const pts = chain.nodes.map(id => geo.get(id)).filter(Boolean);
      const a0 = geo.get(aId), b0 = geo.get(bId);
      // PCA over the WHOLE corridor means a tiny 4-block turn cannot rotate the map.
      const angle = snap45(principalAngle(pts, a0, b0));
      const stopCount = Math.max(1, chain.nodes.length - 1);
      const len = CFG.baseSpacing * (0.72 + 0.70 * stopCount);
      const shared = Math.max(1, ...chain.edges.map(e => e.routes.size));
      constraints.push({ a: aId, b: bId, vx: Math.cos(angle) * len, vz: Math.sin(angle) * len, weight: 1 + Math.log2(shared + 1) * 0.28 });
    }

    for (const key of model.transferPairs) {
      const [a, b] = key.split('|');
      if (!pos.has(a) || !pos.has(b)) continue;
      const a0 = geo.get(a), b0 = geo.get(b);
      const angle = snap45(Math.atan2(b0.z - a0.z, b0.x - a0.x));
      const len = CFG.baseSpacing * 0.42;
      constraints.push({ a, b, vx: Math.cos(angle) * len, vz: Math.sin(angle) * len, weight: 2.5, transfer: true });
    }

    const hard = [];
    for (const s of model.streetConstraints) {
      if (!pos.has(s.a) || !pos.has(s.b)) continue;
      const a0 = geo.get(s.a), b0 = geo.get(s.b);
      const raw = Math.max(1, Math.hypot(b0.x - a0.x, b0.z - a0.z));
      const len = clamp(raw, CFG.baseSpacing * 0.72, CFG.baseSpacing * 1.55);
      hard.push({ a: s.a, b: s.b, vx: Math.cos(s.angle) * len, vz: Math.sin(s.angle) * len, street: s.street });
    }

    const graph = new Map([...pos.keys()].map(id => [id, new Set()]));
    for (const c of [...constraints, ...hard]) {
      graph.get(c.a)?.add(c.b); graph.get(c.b)?.add(c.a);
    }

    const components = [];
    const used = new Set();
    for (const id of pos.keys()) {
      if (used.has(id)) continue;
      const stack = [id], ids = [];
      used.add(id);
      while (stack.length) {
        const cur = stack.pop(); ids.push(cur);
        for (const n of graph.get(cur) || []) if (!used.has(n)) { used.add(n); stack.push(n); }
      }
      components.push(ids);
    }

    const roots = new Set();
    for (const ids of components) {
      let root = ids[0], degree = -1;
      for (const id of ids) {
        const d = graph.get(id)?.size || 0;
        if (d > degree) { degree = d; root = id; }
      }
      roots.add(root);
    }

    function project(c, gain) {
      const a = pos.get(c.a), b = pos.get(c.b);
      if (!a || !b) return;
      const ex = (b.x - a.x) - c.vx;
      const ez = (b.z - a.z) - c.vz;
      if (!roots.has(c.a)) { a.x += ex * gain * 0.5; a.z += ez * gain * 0.5; }
      if (!roots.has(c.b)) { b.x -= ex * gain * 0.5; b.z -= ez * gain * 0.5; }
    }

    for (let iter = 0; iter < CFG.iterations; iter++) {
      const t = iter / Math.max(1, CFG.iterations - 1);
      const step = 0.15 * (1 - 0.68 * t);
      for (const c of constraints) project(c, step * (c.transfer ? 1.5 : c.weight));
      // Street spines are much stronger, but the rest of the graph is free to move around them.
      for (const c of hard) project(c, 0.62);

      for (const [id, p] of pos) {
        if (roots.has(id)) continue;
        const g = geo.get(id);
        p.x += (g.x - p.x) * CFG.geographyPull;
        p.z += (g.z - p.z) * CFG.geographyPull;
      }

      if (iter % 10 === 0) {
        const ids = [...pos.keys()];
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const a = pos.get(ids[i]), b = pos.get(ids[j]);
            let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
            if (d >= CFG.minAnchorDistance) continue;
            if (d < 0.001) { dx = 1; dz = 0; d = 1; }
            const push = (CFG.minAnchorDistance - d) * 0.025;
            const ux = dx / d, uz = dz / d;
            if (!roots.has(ids[i])) { a.x -= ux * push; a.z -= uz * push; }
            if (!roots.has(ids[j])) { b.x += ux * push; b.z += uz * push; }
          }
        }
      }
      for (const root of roots) Object.assign(pos.get(root), geo.get(root));
    }

    // Recenter components, then distribute intermediate corridor stops evenly.
    for (const ids of components) {
      let gx = 0, gz = 0, sx = 0, sz = 0;
      for (const id of ids) { const g = geo.get(id), p = pos.get(id); gx += g.x; gz += g.z; sx += p.x; sz += p.z; }
      gx /= ids.length; gz /= ids.length; sx /= ids.length; sz /= ids.length;
      for (const id of ids) { const p = pos.get(id); p.x += gx - sx; p.z += gz - sz; }
    }

    const finalPos = new Map([...pos].map(([id, p]) => [id, { ...p }]));
    for (const chain of chains) {
      const start = finalPos.get(chain.nodes[0]), end = finalPos.get(chain.nodes.at(-1));
      if (!start || !end) continue;
      const count = chain.nodes.length - 1;
      for (let i = 1; i < chain.nodes.length - 1; i++) {
        const u = i / count;
        finalPos.set(chain.nodes[i], { x: start.x + (end.x - start.x) * u, z: start.z + (end.z - start.z) * u });
      }
    }
    for (const id of model.original.keys()) if (!finalPos.has(id)) finalPos.set(id, { ...geo.get(id) });
    return finalPos;
  }

  function routeSort(a, b, routeById) {
    const ra = routeById.get(a), rb = routeById.get(b);
    return modePriority(ra?.mode) - modePriority(rb?.mode) || String(ra?.name || '').localeCompare(String(rb?.name || ''));
  }

  function visibleRoutesForEdge(edge, model) {
    return [...edge.routes]
      .filter(id => state.visible.has(model.routeById.get(id)?.mode || 'bus'))
      .sort((a, b) => routeSort(a, b, model.routeById));
  }

  function fitView(positions) {
    const vals = [...positions.values()];
    const minX = Math.min(...vals.map(p => p.x)), maxX = Math.max(...vals.map(p => p.x));
    const minY = Math.min(...vals.map(p => p.z)), maxY = Math.max(...vals.map(p => p.z));
    const pad = 130;
    return { x: minX - pad, y: minY - pad, w: Math.max(500, maxX - minX + pad * 2), h: Math.max(350, maxY - minY + pad * 2) };
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
      state.view.w *= factor; state.view.h *= factor; applyView();
    }, { passive: false });
    svg.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      svg.setPointerCapture(e.pointerId); svg.style.cursor = 'grabbing';
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
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', () => { state.view = { ...state.fitView }; applyView(); });
  }

  function render() {
    const { model, positions, wrapper, canvas } = state;
    if (!model || !positions || !wrapper) return;
    document.getElementById('mtr-schematic-overlay')?.remove();
    document.getElementById('mtr-schematic-controls')?.remove();

    wrapper.style.position = 'relative';
    const bg = state.dark ? '#111827' : '#f7f8fa';
    const fg = state.dark ? '#e5e7eb' : '#111827';
    const halo = state.dark ? '#111827' : '#ffffff';
    const transferColor = state.dark ? '#cbd5e1' : '#202020';

    const overlay = document.createElement('div');
    overlay.id = 'mtr-schematic-overlay';
    Object.assign(overlay.style, { position: 'absolute', inset: '0', zIndex: '20', background: bg, overflow: 'hidden' });
    const svg = svgEl('svg', { width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet' });
    svg.style.display = 'block'; svg.style.cursor = 'grab';
    overlay.appendChild(svg); wrapper.appendChild(overlay);

    const lineLayer = svgEl('g'), transferLayer = svgEl('g'), stationLayer = svgEl('g'), labelLayer = svgEl('g');
    svg.append(lineLayer, transferLayer, stationLayer, labelLayer);

    for (const edge of model.routeEdges.values()) {
      const p1 = positions.get(edge.a), p2 = positions.get(edge.b);
      if (!p1 || !p2) continue;
      const routeIds = visibleRoutesForEdge(edge, model);
      if (!routeIds.length) continue;
      const dx = p2.x - p1.x, dy = p2.z - p1.z, len = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / len, ny = dx / len;
      routeIds.forEach((routeId, i) => {
        const route = model.routeById.get(routeId);
        const offset = (i - (routeIds.length - 1) / 2) * CFG.laneGap;
        lineLayer.appendChild(svgEl('line', {
          x1: p1.x + nx * offset, y1: p1.z + ny * offset,
          x2: p2.x + nx * offset, y2: p2.z + ny * offset,
          stroke: colorHex(route?.color), 'stroke-width': CFG.lineWidth,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
        }));
      });
    }

    for (const key of model.transferPairs) {
      const [a, b] = key.split('|');
      const p1 = positions.get(a), p2 = positions.get(b);
      if (!p1 || !p2) continue;
      transferLayer.appendChild(svgEl('line', {
        x1: p1.x, y1: p1.z, x2: p2.x, y2: p2.z,
        stroke: transferColor, 'stroke-width': 2.2, 'stroke-dasharray': '6 5', 'vector-effect': 'non-scaling-stroke',
      }));
    }

    for (const [id, p] of positions) {
      const meta = model.stationMeta.get(id);
      const visibleMemberships = [...(model.routeMembership.get(id) || [])].filter(rid => state.visible.has(model.routeById.get(rid)?.mode || 'bus'));
      if (!visibleMemberships.length) continue;
      const count = visibleMemberships.length;
      const important = model.anchors.has(id) || count >= 3;
      const r = 3.3 + Math.min(8.5, Math.log2(count + 1) * 2.25);
      const circle = svgEl('circle', {
        cx: p.x, cy: p.z, r,
        fill: state.dark ? '#111827' : '#ffffff', stroke: fg,
        'stroke-width': important ? 2.1 : 1.5, 'vector-effect': 'non-scaling-stroke',
      });
      const title = svgEl('title');
      title.textContent = `${meta?.name || id} · ${count} route${count === 1 ? '' : 's'}`;
      circle.appendChild(title); stationLayer.appendChild(circle);

      const showLabel = state.labelMode === 'all' || (state.labelMode === 'key' && important);
      if (showLabel && meta?.name) {
        const text = svgEl('text', {
          x: p.x + r + 4, y: p.z - r - 2,
          'font-size': important ? 11 : 9, 'font-family': 'system-ui, sans-serif',
          'font-weight': important ? 650 : 500, fill: fg,
          'paint-order': 'stroke', stroke: halo, 'stroke-width': 3.8, 'stroke-linejoin': 'round',
          'vector-effect': 'non-scaling-stroke',
        });
        text.textContent = meta.name; labelLayer.appendChild(text);
      }
    }

    state.overlay = overlay; state.svg = svg; state.canvas = canvas;
    if (!state.fitView) state.fitView = fitView(positions);
    if (!state.view) state.view = { ...state.fitView };
    applyView(); installPanZoom(svg); installControls();
    setOriginalVisible(!state.enabled);
  }

  function setOriginalVisible(showOriginal) {
    const wrapper = state.wrapper;
    if (!wrapper) return;
    const canvas = wrapper.querySelector('canvas');
    if (canvas) canvas.style.visibility = showOriginal ? '' : 'hidden';
    wrapper.querySelectorAll('.label').forEach(el => el.style.visibility = showOriginal ? '' : 'hidden');
    if (state.overlay) state.overlay.style.display = showOriginal ? 'none' : '';
  }

  function button(text) {
    const b = document.createElement('button'); b.textContent = text;
    Object.assign(b.style, { border: '1px solid #4b5563', borderRadius: '7px', padding: '6px 8px', background: '#1f2937', color: '#fff', cursor: 'pointer', font: 'inherit' });
    return b;
  }

  function modeToggle(label, mode) {
    const l = document.createElement('label');
    l.style.cssText = 'display:flex;align-items:center;gap:5px;font-weight:600';
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = state.visible.has(mode);
    c.onchange = () => {
      c.checked ? state.visible.add(mode) : state.visible.delete(mode);
      localStorage.setItem('mtr-schematic-renderer-modes', JSON.stringify([...state.visible]));
      render();
    };
    l.append(c, document.createTextNode(label)); return l;
  }

  function installControls() {
    const panel = document.createElement('div'); panel.id = 'mtr-schematic-controls';
    Object.assign(panel.style, {
      position: 'fixed', left: '14px', bottom: '14px', zIndex: '1000000', width: '286px', padding: '10px', borderRadius: '10px',
      background: 'rgba(17,24,39,.96)', color: '#fff', font: '600 12px/1.3 system-ui,sans-serif', boxShadow: '0 5px 20px rgba(0,0,0,.3)'
    });
    const title = document.createElement('div');
    title.innerHTML = '<strong style="font-size:14px">Corridor schematic</strong><div style="opacity:.65;font-weight:500;margin-top:2px">Street runs simplified · same-name stations merged</div>';

    const top = document.createElement('div'); top.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:9px';
    const schematic = button('Schematic'), original = button('Original'), fit = button('Fit'); top.append(schematic, original, fit);
    schematic.onclick = () => { state.enabled = true; localStorage.setItem('mtr-schematic-renderer-enabled', '1'); setOriginalVisible(false); };
    original.onclick = () => { state.enabled = false; localStorage.setItem('mtr-schematic-renderer-enabled', '0'); setOriginalVisible(true); };
    fit.onclick = () => { state.view = { ...state.fitView }; applyView(); };

    const modes = document.createElement('div'); modes.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:5px 9px;margin-top:9px';
    modes.append(modeToggle('Train', 'train'), modeToggle('Light rail', 'light_rail'), modeToggle('High speed', 'high_speed'), modeToggle('Bus / other', 'bus'));

    const labels = document.createElement('select');
    labels.innerHTML = '<option value="key">Key labels</option><option value="all">All labels</option><option value="none">No labels</option>';
    labels.value = state.labelMode;
    Object.assign(labels.style, { width: '100%', marginTop: '8px', padding: '6px', borderRadius: '7px', background: '#1f2937', color: '#fff', border: '1px solid #4b5563' });
    labels.onchange = () => { state.labelMode = labels.value; localStorage.setItem('mtr-schematic-renderer-labels', state.labelMode); render(); };

    const dark = document.createElement('label'); dark.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px';
    const darkCheck = document.createElement('input'); darkCheck.type = 'checkbox'; darkCheck.checked = state.dark;
    darkCheck.onchange = () => { state.dark = darkCheck.checked; localStorage.setItem('mtr-schematic-renderer-dark', state.dark ? '1' : '0'); render(); };
    dark.append(darkCheck, document.createTextNode('Dark mode'));

    const note = document.createElement('div'); note.style.cssText = 'opacity:.62;font-size:11px;font-weight:500;margin-top:8px';
    note.textContent = `${state.model.routes.length} routes · ${state.model.original.size} merged stations · ${state.model.chains.length} corridors · drag to pan, wheel to zoom, double-click to fit`;
    const spine = document.createElement('div'); spine.style.cssText = 'opacity:.72;font-size:11px;font-weight:600;margin-top:5px';
    spine.textContent = 'Street spine: Rogowska locked as one straight schematic corridor.';

    panel.append(title, top, modes, labels, dark, note, spine); document.body.appendChild(panel);
  }

  async function main() {
    try {
      const [{ wrapper, canvas }, data] = await Promise.all([waitForMap(), loadNetwork()]);
      state.wrapper = wrapper; state.canvas = canvas;
      state.model = buildModel(data);
      state.positions = solveLayout(state.model);
      state.fitView = fitView(state.positions);
      state.view = { ...state.fitView };
      render();
      console.log('[MTR Map Tools] corridor schematic renderer loaded', {
        routes: state.model.routes.length,
        mergedStations: state.model.original.size,
        corridors: state.model.chains.length,
        streetSpines: STREET_SPINES.map(s => s.name),
      });
    } catch (error) {
      console.error('[MTR Map Tools] corridor schematic renderer failed:', error);
    }
  }

  main();
})();