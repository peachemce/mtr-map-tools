// ==UserScript==
// @name         MTR Map Tools - Schematic Renderer
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      1.0.0
// @description  Replaces the stock MTR map drawing with a topology-first schematic renderer for dense networks.
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
    baseSpacing: 92,
    lineWidth: 4,
    laneGap: 5.3,
    geographyPull: 0.012,
    constraintWeight: 0.17,
    transferWeight: 0.24,
    iterations: 320,
    minAnchorDistance: 62,
  };

  const state = {
    enabled: localStorage.getItem('mtr-schematic-renderer-enabled') !== '0',
    labelMode: localStorage.getItem('mtr-schematic-renderer-labels') || 'key',
    overlay: null,
    wrapper: null,
    svg: null,
    originalCanvas: null,
    view: null,
    drag: null,
  };

  function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function colorHex(value) {
    const n = Number(value) >>> 0;
    return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  function median(values) {
    if (!values.length) return 1;
    const v = [...values].sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  function snap45(angle) {
    const step = Math.PI / 4;
    return Math.round(angle / step) * step;
  }
  function average(points) {
    let x = 0, z = 0;
    for (const p of points) { x += p.x; z += p.z; }
    return { x: x / points.length, z: z / points.length };
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
    const routes = (data.routes || []).filter(r => !r.hidden && Array.isArray(r.stations) && r.stations.length >= 2);
    const stationMeta = new Map((data.stations || []).map(s => [s.id, s]));
    const occurrences = new Map();
    const routeMembership = new Map();
    const routeEdges = new Map();
    const routeEndpoints = new Set();

    for (const route of routes) {
      const usable = route.stations.filter(s => s?.id && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.z)));
      if (usable.length < 2) continue;
      routeEndpoints.add(usable[0].id);
      routeEndpoints.add(usable[usable.length - 1].id);

      for (const stop of usable) {
        if (!occurrences.has(stop.id)) occurrences.set(stop.id, []);
        occurrences.get(stop.id).push({ x: Number(stop.x), z: Number(stop.z) });
        if (!routeMembership.has(stop.id)) routeMembership.set(stop.id, new Set());
        routeMembership.get(stop.id).add(route.id);
      }

      for (let i = 1; i < usable.length; i++) {
        const a = usable[i - 1].id;
        const b = usable[i].id;
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

    const original = new Map();
    for (const [id, pts] of occurrences) original.set(id, average(pts));

    const rawLengths = [];
    for (const e of routeEdges.values()) {
      const a = original.get(e.a), b = original.get(e.b);
      if (a && b) rawLengths.push(Math.hypot(b.x - a.x, b.z - a.z));
    }
    const rawMedian = Math.max(1, median(rawLengths));
    const geoScale = CFG.baseSpacing / rawMedian;
    const geo = new Map([...original].map(([id, p]) => [id, { x: p.x * geoScale, z: p.z * geoScale }]));

    const adjacency = new Map([...original.keys()].map(id => [id, []]));
    for (const edge of routeEdges.values()) {
      adjacency.get(edge.a)?.push(edge);
      adjacency.get(edge.b)?.push(edge);
    }

    const anchors = new Set();
    for (const id of original.keys()) {
      const degree = adjacency.get(id)?.length || 0;
      const meta = stationMeta.get(id);
      const memberships = routeMembership.get(id)?.size || 0;
      if (degree !== 2 || routeEndpoints.has(id) || memberships >= 3 || (meta?.connections?.length || 0) > 0) anchors.add(id);
    }

    const seen = new Set();
    for (const id of original.keys()) {
      if (seen.has(id)) continue;
      const stack = [id], component = [];
      seen.add(id);
      while (stack.length) {
        const cur = stack.pop();
        component.push(cur);
        for (const e of adjacency.get(cur) || []) {
          const nxt = e.a === cur ? e.b : e.a;
          if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
        }
      }
      if (!component.some(x => anchors.has(x))) anchors.add(component[0]);
    }

    const chains = [];
    const visitedEdges = new Set();
    for (const start of anchors) {
      for (const firstEdge of adjacency.get(start) || []) {
        if (visitedEdges.has(firstEdge.key)) continue;
        const nodes = [start];
        const edges = [];
        let current = start;
        let edge = firstEdge;

        while (edge) {
          visitedEdges.add(edge.key);
          edges.push(edge);
          const next = edge.a === current ? edge.b : edge.a;
          nodes.push(next);
          if (anchors.has(next) && next !== start) break;
          const options = (adjacency.get(next) || []).filter(e => !visitedEdges.has(e.key));
          if (options.length !== 1) break;
          current = next;
          edge = options[0];
        }

        if (nodes.length >= 2) chains.push({ nodes, edges });
      }
    }

    for (const edge of routeEdges.values()) {
      if (!visitedEdges.has(edge.key)) chains.push({ nodes: [edge.a, edge.b], edges: [edge] });
    }

    const routeById = new Map(routes.map(r => [r.id, r]));
    return { data, routes, routeById, stationMeta, original, geo, routeEdges, routeMembership, adjacency, anchors, chains };
  }

  function solveLayout(model) {
    const { geo, chains, anchors } = model;
    const pos = new Map([...anchors].map(id => [id, { ...geo.get(id) }]));
    const constraints = [];

    for (const chain of chains) {
      const aId = chain.nodes[0];
      const bId = chain.nodes[chain.nodes.length - 1];
      if (!pos.has(aId) || !pos.has(bId) || aId === bId) continue;
      const a0 = geo.get(aId), b0 = geo.get(bId);
      const angle = snap45(Math.atan2(b0.z - a0.z, b0.x - a0.x));
      const stops = Math.max(1, chain.nodes.length - 1);
      const len = CFG.baseSpacing * (0.9 + 0.88 * stops);
      const shared = Math.max(...chain.edges.map(e => e.routes.size), 1);
      constraints.push({
        a: aId, b: bId,
        vx: Math.cos(angle) * len,
        vz: Math.sin(angle) * len,
        weight: 1 + Math.log2(shared + 1) * 0.28,
      });
    }

    const transferSeen = new Set();
    for (const station of model.data.stations || []) {
      if (!pos.has(station.id)) continue;
      for (const other of station.connections || []) {
        if (!pos.has(other)) continue;
        const key = pairKey(station.id, other);
        if (transferSeen.has(key)) continue;
        transferSeen.add(key);
        const a0 = geo.get(station.id), b0 = geo.get(other);
        let angle = snap45(Math.atan2(b0.z - a0.z, b0.x - a0.x));
        if (!Number.isFinite(angle)) angle = 0;
        const len = CFG.baseSpacing * 0.45;
        constraints.push({ a: station.id, b: other, vx: Math.cos(angle) * len, vz: Math.sin(angle) * len, weight: 2.4, transfer: true });
      }
    }

    const graph = new Map([...pos.keys()].map(id => [id, new Set()]));
    for (const c of constraints) {
      graph.get(c.a)?.add(c.b);
      graph.get(c.b)?.add(c.a);
    }

    const components = [];
    const used = new Set();
    for (const id of pos.keys()) {
      if (used.has(id)) continue;
      const stack = [id], ids = [];
      used.add(id);
      while (stack.length) {
        const cur = stack.pop();
        ids.push(cur);
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

    for (let iter = 0; iter < CFG.iterations; iter++) {
      const t = iter / Math.max(1, CFG.iterations - 1);
      const step = CFG.constraintWeight * (1 - 0.72 * t);

      for (const c of constraints) {
        const a = pos.get(c.a), b = pos.get(c.b);
        if (!a || !b) continue;
        const ex = (b.x - a.x) - c.vx;
        const ez = (b.z - a.z) - c.vz;
        const gain = step * (c.transfer ? CFG.transferWeight / CFG.constraintWeight : 1) * c.weight;
        if (!roots.has(c.a)) { a.x += ex * gain * 0.5; a.z += ez * gain * 0.5; }
        if (!roots.has(c.b)) { b.x -= ex * gain * 0.5; b.z -= ez * gain * 0.5; }
      }

      for (const [id, p] of pos) {
        if (roots.has(id)) continue;
        const g = geo.get(id);
        p.x += (g.x - p.x) * CFG.geographyPull;
        p.z += (g.z - p.z) * CFG.geographyPull;
      }

      if (iter % 8 === 0) {
        const ids = [...pos.keys()];
        for (let i = 0; i < ids.length; i++) {
          const a = pos.get(ids[i]);
          for (let j = i + 1; j < ids.length; j++) {
            const b = pos.get(ids[j]);
            let dx = b.x - a.x, dz = b.z - a.z;
            let d = Math.hypot(dx, dz);
            if (d >= CFG.minAnchorDistance) continue;
            if (d < 0.001) { dx = 1; dz = 0; d = 1; }
            const push = (CFG.minAnchorDistance - d) * 0.035;
            const ux = dx / d, uz = dz / d;
            if (!roots.has(ids[i])) { a.x -= ux * push; a.z -= uz * push; }
            if (!roots.has(ids[j])) { b.x += ux * push; b.z += uz * push; }
          }
        }
      }

      for (const root of roots) Object.assign(pos.get(root), geo.get(root));
    }

    for (const ids of components) {
      let gx = 0, gz = 0, sx = 0, sz = 0;
      for (const id of ids) {
        const g = geo.get(id), p = pos.get(id);
        gx += g.x; gz += g.z; sx += p.x; sz += p.z;
      }
      gx /= ids.length; gz /= ids.length; sx /= ids.length; sz /= ids.length;
      for (const id of ids) {
        const p = pos.get(id);
        p.x += gx - sx;
        p.z += gz - sz;
      }
    }

    const finalPos = new Map();
    for (const [id, p] of pos) finalPos.set(id, { ...p });

    for (const chain of chains) {
      const start = finalPos.get(chain.nodes[0]);
      const end = finalPos.get(chain.nodes[chain.nodes.length - 1]);
      if (!start || !end) continue;
      const count = chain.nodes.length - 1;
      for (let i = 1; i < chain.nodes.length - 1; i++) {
        const u = i / count;
        finalPos.set(chain.nodes[i], {
          x: start.x + (end.x - start.x) * u,
          z: start.z + (end.z - start.z) * u,
        });
      }
    }

    for (const id of model.original.keys()) if (!finalPos.has(id)) finalPos.set(id, { ...geo.get(id) });
    return finalPos;
  }

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  function routeSort(a, b, routeById) {
    const ra = routeById.get(a), rb = routeById.get(b);
    const pa = typePriority(ra?.type), pb = typePriority(rb?.type);
    return pa - pb || String(ra?.name || '').localeCompare(String(rb?.name || ''));
  }
  function typePriority(type) {
    if (String(type).includes('high_speed')) return 0;
    if (String(type).includes('train')) return 1;
    if (String(type).includes('light_rail')) return 2;
    return 3;
  }

  function render(model, positions, wrapper, canvas) {
    document.getElementById('mtr-schematic-overlay')?.remove();
    document.getElementById('mtr-schematic-controls')?.remove();

    wrapper.style.position = 'relative';
    const overlay = document.createElement('div');
    overlay.id = 'mtr-schematic-overlay';
    Object.assign(overlay.style, { position: 'absolute', inset: '0', zIndex: '20', background: 'var(--surface-ground, #f7f8fa)', overflow: 'hidden' });

    const svg = svgEl('svg', { width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet' });
    svg.style.display = 'block';
    svg.style.cursor = 'grab';
    overlay.appendChild(svg);
    wrapper.appendChild(overlay);

    const lineLayer = svgEl('g');
    const transferLayer = svgEl('g');
    const stationLayer = svgEl('g');
    const labelLayer = svgEl('g');
    svg.append(lineLayer, transferLayer, stationLayer, labelLayer);

    for (const edge of model.routeEdges.values()) {
      const p1 = positions.get(edge.a), p2 = positions.get(edge.b);
      if (!p1 || !p2) continue;
      const routeIds = [...edge.routes].sort((a, b) => routeSort(a, b, model.routeById));
      const dx = p2.x - p1.x, dy = p2.z - p1.z;
      const len = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / len, ny = dx / len;

      routeIds.forEach((routeId, i) => {
        const route = model.routeById.get(routeId);
        const offset = (i - (routeIds.length - 1) / 2) * CFG.laneGap;
        lineLayer.appendChild(svgEl('line', {
          x1: p1.x + nx * offset,
          y1: p1.z + ny * offset,
          x2: p2.x + nx * offset,
          y2: p2.z + ny * offset,
          stroke: colorHex(route?.color),
          'stroke-width': CFG.lineWidth,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'vector-effect': 'non-scaling-stroke',
        }));
      });
    }

    const transferSeen = new Set();
    for (const station of model.data.stations || []) {
      for (const other of station.connections || []) {
        const key = pairKey(station.id, other);
        if (transferSeen.has(key)) continue;
        transferSeen.add(key);
        const a = positions.get(station.id), b = positions.get(other);
        if (!a || !b) continue;
        transferLayer.appendChild(svgEl('line', {
          x1: a.x, y1: a.z, x2: b.x, y2: b.z,
          stroke: '#202020', 'stroke-width': 2.5, 'stroke-dasharray': '7 6',
          'vector-effect': 'non-scaling-stroke',
        }));
      }
    }

    for (const [id, p] of positions) {
      const meta = model.stationMeta.get(id);
      const important = model.anchors.has(id);
      const r = important ? 5.3 : 3.8;
      const circle = svgEl('circle', {
        cx: p.x, cy: p.z, r,
        fill: '#fff', stroke: '#1f1f1f', 'stroke-width': important ? 2 : 1.6,
        'vector-effect': 'non-scaling-stroke',
      });
      const title = svgEl('title');
      title.textContent = meta?.name || id;
      circle.appendChild(title);
      stationLayer.appendChild(circle);

      const showLabel = state.labelMode === 'all' || (state.labelMode === 'key' && important);
      if (showLabel && meta?.name) {
        const text = svgEl('text', {
          x: p.x + 7,
          y: p.z - 7,
          'font-size': important ? 11 : 9,
          'font-family': 'system-ui, sans-serif',
          'font-weight': important ? 650 : 500,
          fill: '#111',
          'paint-order': 'stroke',
          stroke: '#fff',
          'stroke-width': 3.5,
          'stroke-linejoin': 'round',
          'vector-effect': 'non-scaling-stroke',
        });
        text.textContent = meta.name;
        labelLayer.appendChild(text);
      }
    }

    const vals = [...positions.values()];
    const minX = Math.min(...vals.map(p => p.x)), maxX = Math.max(...vals.map(p => p.x));
    const minY = Math.min(...vals.map(p => p.z)), maxY = Math.max(...vals.map(p => p.z));
    const pad = 140;
    state.view = { x: minX - pad, y: minY - pad, w: Math.max(400, maxX - minX + pad * 2), h: Math.max(300, maxY - minY + pad * 2) };
    applyView(svg);

    installPanZoom(svg);
    installControls(wrapper, overlay, canvas, model, positions);

    state.overlay = overlay;
    state.wrapper = wrapper;
    state.svg = svg;
    state.originalCanvas = canvas;
    setOriginalVisible(!state.enabled);
  }

  function applyView(svg) {
    const v = state.view;
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  }

  function installPanZoom(svg) {
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = state.view.x + (e.clientX - rect.left) / rect.width * state.view.w;
      const my = state.view.y + (e.clientY - rect.top) / rect.height * state.view.h;
      const factor = e.deltaY > 0 ? 1.14 : 0.88;
      state.view.x = mx + (state.view.x - mx) * factor;
      state.view.y = my + (state.view.y - my) * factor;
      state.view.w *= factor;
      state.view.h *= factor;
      applyView(svg);
    }, { passive: false });

    svg.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      svg.setPointerCapture(e.pointerId);
      svg.style.cursor = 'grabbing';
      state.drag = { x: e.clientX, y: e.clientY, viewX: state.view.x, viewY: state.view.y };
    });
    svg.addEventListener('pointermove', e => {
      if (!state.drag) return;
      const rect = svg.getBoundingClientRect();
      state.view.x = state.drag.viewX - (e.clientX - state.drag.x) / rect.width * state.view.w;
      state.view.y = state.drag.viewY - (e.clientY - state.drag.y) / rect.height * state.view.h;
      applyView(svg);
    });
    const end = () => { state.drag = null; svg.style.cursor = 'grab'; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  function setOriginalVisible(showOriginal) {
    const wrapper = state.wrapper;
    if (!wrapper) return;
    const canvas = wrapper.querySelector('canvas');
    if (canvas) canvas.style.visibility = showOriginal ? '' : 'hidden';
    wrapper.querySelectorAll('.label').forEach(el => el.style.visibility = showOriginal ? '' : 'hidden');
    if (state.overlay) state.overlay.style.display = showOriginal ? 'none' : '';
  }

  function installControls(wrapper, overlay, canvas, model, positions) {
    const panel = document.createElement('div');
    panel.id = 'mtr-schematic-controls';
    Object.assign(panel.style, {
      position: 'fixed', left: '14px', bottom: '14px', zIndex: '1000000',
      width: '260px', padding: '10px', borderRadius: '10px',
      background: 'rgba(17,24,39,.96)', color: '#fff',
      font: '600 12px/1.3 system-ui,sans-serif', boxShadow: '0 5px 20px rgba(0,0,0,.3)'
    });

    const title = document.createElement('div');
    title.innerHTML = '<strong style="font-size:14px">Schematic renderer</strong><div style="opacity:.65;font-weight:500;margin-top:2px">Topology first · micro-bends ignored</div>';

    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px';
    const schematic = button('Schematic');
    const original = button('Original MTR');
    row.append(schematic, original);

    const labels = document.createElement('select');
    labels.innerHTML = '<option value="key">Key labels</option><option value="all">All labels</option><option value="none">No labels</option>';
    labels.value = state.labelMode;
    Object.assign(labels.style, { width: '100%', marginTop: '7px', padding: '6px', borderRadius: '7px', background: '#1f2937', color: '#fff', border: '1px solid #4b5563' });

    const note = document.createElement('div');
    note.style.cssText = 'opacity:.62;font-size:11px;font-weight:500;margin-top:7px';
    note.textContent = `${model.routes.length} routes · ${model.original.size} stations · ${model.chains.length} simplified corridors`;

    schematic.onclick = () => {
      state.enabled = true;
      localStorage.setItem('mtr-schematic-renderer-enabled', '1');
      setOriginalVisible(false);
    };
    original.onclick = () => {
      state.enabled = false;
      localStorage.setItem('mtr-schematic-renderer-enabled', '0');
      setOriginalVisible(true);
    };
    labels.onchange = () => {
      state.labelMode = labels.value;
      localStorage.setItem('mtr-schematic-renderer-labels', state.labelMode);
      render(model, positions, wrapper, canvas);
    };

    panel.append(title, row, labels, note);
    document.body.appendChild(panel);
  }

  function button(text) {
    const b = document.createElement('button');
    b.textContent = text;
    Object.assign(b.style, { border: '1px solid #4b5563', borderRadius: '7px', padding: '6px 8px', background: '#1f2937', color: '#fff', cursor: 'pointer', font: 'inherit' });
    return b;
  }

  async function main() {
    try {
      const [{ wrapper, canvas }, data] = await Promise.all([waitForMap(), loadNetwork()]);
      const model = buildModel(data);
      const positions = solveLayout(model);
      render(model, positions, wrapper, canvas);
      console.log('[MTR Map Tools] schematic renderer loaded', {
        routes: model.routes.length,
        stations: model.original.size,
        corridors: model.chains.length,
      });
    } catch (error) {
      console.error('[MTR Map Tools] schematic renderer failed:', error);
    }
  }

  main();
})();
