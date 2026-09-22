// ==UserScript==
// @name         MTR Map Tools - Folityn Schematic v3
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      3.0.0
// @description  Standalone geography-preserving octilinear renderer for the Folityn MTR map.
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
  const KEY = 'folityn-schematic-v3-';
  const CFG = {
    targetSpacing: 78,
    lineWidth: 4.8,
    laneGap: 6.2,
    cornerRadius: 15,
    pad: 140,
  };

  const state = {
    enabled: localStorage.getItem(KEY + 'enabled') !== '0',
    dark: localStorage.getItem(KEY + 'dark') !== '0',
    labels: localStorage.getItem(KEY + 'labels') || 'key',
    transfers: localStorage.getItem(KEY + 'transfers') !== '0',
    visible: new Set(JSON.parse(localStorage.getItem(KEY + 'modes') || '["light_rail","rail","high_speed","bus"]')),
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

  const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const colorHex = value => `#${((Number(value) >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  function median(values) {
    if (!values.length) return 1;
    const a = [...values].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function modeOf(type) {
    const t = String(type || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (t.includes('high_speed') || (t.includes('high') && t.includes('speed'))) return 'high_speed';
    if (t.includes('light_rail') || (t.includes('light') && t.includes('rail')) || t.includes('tram')) return 'light_rail';
    if (t === 'train' || t === 'rail' || t.includes('train') || t.includes('normal_rail')) return 'rail';
    return 'bus';
  }

  function modeOrder(mode) {
    return ({ high_speed: 0, rail: 1, light_rail: 2, bus: 3 })[mode] ?? 4;
  }

  function publicLabel(route) {
    const v = route.routeNumber ?? route.number ?? route.route_number ?? route.name ?? route.id;
    return String(v ?? route.id).trim();
  }

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
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

  function buildModel(data) {
    const stationByRawId = new Map();
    const logicalByName = new Map();
    const rawToLogical = new Map();

    for (const s of data.stations || []) {
      stationByRawId.set(s.id, s);
      const key = norm(s.name) || `id:${s.id}`;
      let logical = logicalByName.get(key);
      if (!logical) {
        logical = { id: `name:${key}`, name: String(s.name || s.id), rawIds: new Set(), connections: new Set() };
        logicalByName.set(key, logical);
      }
      logical.rawIds.add(s.id);
      rawToLogical.set(s.id, logical.id);
    }

    const stationMeta = new Map([...logicalByName.values()].map(s => [s.id, s]));
    for (const s of data.stations || []) {
      const from = rawToLogical.get(s.id);
      const meta = stationMeta.get(from);
      if (!meta) continue;
      for (const otherRaw of s.connections || []) {
        const to = rawToLogical.get(otherRaw);
        if (to && to !== from) meta.connections.add(to);
      }
    }

    function ensureLogical(rawId) {
      let id = rawToLogical.get(rawId);
      if (id) return id;
      const raw = stationByRawId.get(rawId);
      const key = norm(raw?.name) || `id:${rawId}`;
      id = `name:${key}`;
      rawToLogical.set(rawId, id);
      if (!stationMeta.has(id)) stationMeta.set(id, { id, name: String(raw?.name || rawId), rawIds: new Set([rawId]), connections: new Set() });
      return id;
    }

    const occurrences = new Map();
    const routeGroups = new Map();
    const nodeRouteGroups = new Map();
    const routeEndpoints = new Set();

    for (const raw of data.routes || []) {
      if (raw.hidden || !Array.isArray(raw.stations) || raw.stations.length < 2) continue;
      const mode = modeOf(raw.type);
      const label = publicLabel(raw);
      const color = Number(raw.color ?? 0);
      const groupKey = `${mode}|${label}|${color}`;
      let group = routeGroups.get(groupKey);
      if (!group) {
        group = { id: groupKey, label, mode, color, sequences: [], sequenceSigs: new Set(), edges: new Set() };
        routeGroups.set(groupKey, group);
      }

      const seq = [];
      for (const stop of raw.stations) {
        if (!stop?.id || !Number.isFinite(Number(stop.x)) || !Number.isFinite(Number(stop.z))) continue;
        const node = ensureLogical(stop.id);
        const p = { node, x: Number(stop.x), y: Number(stop.z) };
        if (seq.at(-1)?.node !== node) seq.push(p);
        if (!occurrences.has(node)) occurrences.set(node, []);
        occurrences.get(node).push({ x: p.x, y: p.y });
      }
      if (seq.length < 2) continue;

      const ids = seq.map(s => s.node);
      const forward = ids.join('>');
      const reverse = [...ids].reverse().join('>');
      const signature = forward < reverse ? forward : reverse;
      if (!group.sequenceSigs.has(signature)) {
        group.sequenceSigs.add(signature);
        group.sequences.push(ids);
      }

      routeEndpoints.add(ids[0]);
      routeEndpoints.add(ids.at(-1));
      for (const id of ids) {
        if (!nodeRouteGroups.has(id)) nodeRouteGroups.set(id, new Set());
        nodeRouteGroups.get(id).add(groupKey);
      }
      for (let i = 1; i < ids.length; i++) {
        if (ids[i - 1] !== ids[i]) group.edges.add(pairKey(ids[i - 1], ids[i]));
      }
    }

    const edges = new Map();
    for (const group of routeGroups.values()) {
      for (const key of group.edges) {
        let edge = edges.get(key);
        if (!edge) {
          const [a, b] = key.split('|');
          edge = { key, a, b, routes: new Set() };
          edges.set(key, edge);
        }
        edge.routes.add(group.id);
      }
    }

    const original = new Map();
    for (const [id, points] of occurrences) {
      original.set(id, {
        x: points.reduce((s, p) => s + p.x, 0) / points.length,
        y: points.reduce((s, p) => s + p.y, 0) / points.length,
      });
    }

    const lengths = [];
    for (const edge of edges.values()) {
      const a = original.get(edge.a), b = original.get(edge.b);
      if (a && b) lengths.push(dist(a, b));
    }
    const scale = CFG.targetSpacing / Math.max(1, median(lengths));
    const cx = [...original.values()].reduce((s, p) => s + p.x, 0) / Math.max(1, original.size);
    const cy = [...original.values()].reduce((s, p) => s + p.y, 0) / Math.max(1, original.size);

    const geo = new Map();
    for (const [id, p] of original) {
      const dx = (p.x - cx) * scale;
      const dy = (p.y - cy) * scale;
      const r = Math.hypot(dx, dy);
      const compressed = r > 700 ? 700 + Math.sqrt(r - 700) * 13 : r;
      const k = r > 0 ? compressed / r : 1;
      geo.set(id, { x: dx * k, y: dy * k });
    }

    const adjacency = new Map([...geo.keys()].map(id => [id, []]));
    for (const edge of edges.values()) {
      if (!geo.has(edge.a) || !geo.has(edge.b)) continue;
      adjacency.get(edge.a)?.push(edge);
      adjacency.get(edge.b)?.push(edge);
    }

    const transferPairs = new Set();
    for (const meta of stationMeta.values()) {
      if (!geo.has(meta.id)) continue;
      for (const other of meta.connections || []) if (geo.has(other) && other !== meta.id) transferPairs.add(pairKey(meta.id, other));
    }

    const groups = [...routeGroups.values()].sort((a, b) => modeOrder(a.mode) - modeOrder(b.mode) || a.label.localeCompare(b.label, undefined, { numeric: true }) || a.id.localeCompare(b.id));
    const routeRank = new Map(groups.map((g, i) => [g.id, i]));
    return { data, stationMeta, original, geo, adjacency, edges, routeGroups, groups, routeRank, nodeRouteGroups, routeEndpoints, transferPairs };
  }

  function octilinearPoints(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const ax = Math.abs(dx), ay = Math.abs(dy), eps = 0.5;
    if (ax < eps || ay < eps || Math.abs(ax - ay) < eps) return [{ ...a }, { ...b }];
    const sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
    let mid;
    if (ax > ay) mid = { x: a.x + sx * (ax - ay), y: a.y };
    else mid = { x: a.x, y: a.y + sy * (ay - ax) };
    if (dist(a, mid) < eps || dist(mid, b) < eps) return [{ ...a }, { ...b }];
    return [{ ...a }, mid, { ...b }];
  }

  function pointAlongPolyline(points, fraction) {
    const lens = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) { const len = dist(points[i - 1], points[i]); lens.push(len); total += len; }
    if (total <= 0) return { ...points[0] };
    let target = clamp(fraction, 0, 1) * total;
    for (let i = 0; i < lens.length; i++) {
      if (target <= lens[i] || i === lens.length - 1) {
        const u = lens[i] > 0 ? target / lens[i] : 0;
        return { x: points[i].x + (points[i + 1].x - points[i].x) * u, y: points[i].y + (points[i + 1].y - points[i].y) * u };
      }
      target -= lens[i];
    }
    return { ...points.at(-1) };
  }

  function simplifyCorridors(model) {
    const pos = new Map([...model.geo].map(([id, p]) => [id, { ...p }]));
    const anchors = new Set();
    for (const id of pos.keys()) {
      const degree = model.adjacency.get(id)?.length || 0;
      const transfer = [...model.transferPairs].some(k => k.startsWith(`${id}|`) || k.endsWith(`|${id}`));
      if (degree !== 2 || model.routeEndpoints.has(id) || transfer) anchors.add(id);
    }
    const visited = new Set();
    for (const start of anchors) {
      for (const first of model.adjacency.get(start) || []) {
        if (visited.has(first.key)) continue;
        const chain = [start];
        let current = start, edge = first;
        while (edge) {
          visited.add(edge.key);
          const next = edge.a === current ? edge.b : edge.a;
          chain.push(next);
          if (anchors.has(next) && next !== start) break;
          const options = (model.adjacency.get(next) || []).filter(e => !visited.has(e.key));
          if (options.length !== 1) break;
          current = next; edge = options[0];
        }
        if (chain.length < 3) continue;
        const a = pos.get(chain[0]), b = pos.get(chain.at(-1));
        if (!a || !b) continue;
        const spine = octilinearPoints(a, b);
        for (let i = 1; i < chain.length - 1; i++) pos.set(chain[i], pointAlongPolyline(spine, i / (chain.length - 1)));
      }
    }

    const byName = new Map([...model.stationMeta.values()].map(s => [norm(s.name), s.id]));
    const names = ['Rogowska Centrum Miejskie', 'Witkowskiego', 'Rogowska/Dąbka', 'Rogowska'];
    const ids = names.map(n => byName.get(norm(n))).filter(id => id && pos.has(id));
    if (ids.length >= 3) {
      const y = ids.reduce((s, id) => s + pos.get(id).y, 0) / ids.length;
      const first = pos.get(ids[0]);
      const rawFirst = model.geo.get(ids[0]), rawLast = model.geo.get(ids.at(-1));
      const sign = (rawLast?.x ?? first.x) >= (rawFirst?.x ?? first.x) ? 1 : -1;
      let cursor = first.x;
      pos.set(ids[0], { x: cursor, y });
      for (let i = 1; i < ids.length; i++) {
        const prevRaw = model.geo.get(ids[i - 1]), curRaw = model.geo.get(ids[i]);
        const step = clamp(prevRaw && curRaw ? dist(prevRaw, curRaw) : CFG.targetSpacing, CFG.targetSpacing * 0.65, CFG.targetSpacing * 1.3);
        cursor += sign * step;
        pos.set(ids[i], { x: cursor, y });
      }
    }
    return pos;
  }

  function offsetPolyline(points, offset) {
    if (Math.abs(offset) < 0.001 || points.length < 2) return points.map(p => ({ ...p }));
    const normals = [];
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y;
      const len = Math.max(0.001, Math.hypot(dx, dy));
      normals.push({ x: -dy / len, y: dx / len });
    }
    return points.map((p, i) => {
      if (i === 0) return { x: p.x + normals[0].x * offset, y: p.y + normals[0].y * offset };
      if (i === points.length - 1) { const n = normals.at(-1); return { x: p.x + n.x * offset, y: p.y + n.y * offset }; }
      const n1 = normals[i - 1], n2 = normals[i];
      let mx = n1.x + n2.x, my = n1.y + n2.y;
      const ml = Math.hypot(mx, my);
      if (ml < 0.001) return { x: p.x + n2.x * offset, y: p.y + n2.y * offset };
      mx /= ml; my /= ml;
      const dot = Math.max(0.35, mx * n2.x + my * n2.y);
      const miter = offset / dot;
      return { x: p.x + mx * miter, y: p.y + my * miter };
    });
  }

  function roundedPath(points, radius = CFG.cornerRadius) {
    if (points.length < 2) return '';
    if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1], cur = points[i], next = points[i + 1];
      const l1 = dist(prev, cur), l2 = dist(cur, next);
      const r = Math.min(radius, l1 * 0.38, l2 * 0.38);
      if (r < 0.5) { d += ` L ${cur.x} ${cur.y}`; continue; }
      const u1 = { x: (cur.x - prev.x) / l1, y: (cur.y - prev.y) / l1 };
      const u2 = { x: (next.x - cur.x) / l2, y: (next.y - cur.y) / l2 };
      const pIn = { x: cur.x - u1.x * r, y: cur.y - u1.y * r };
      const pOut = { x: cur.x + u2.x * r, y: cur.y + u2.y * r };
      d += ` L ${pIn.x} ${pIn.y} Q ${cur.x} ${cur.y} ${pOut.x} ${pOut.y}`;
    }
    const last = points.at(-1);
    return d + ` L ${last.x} ${last.y}`;
  }

  function edgeRouteIds(edge, model) {
    return [...edge.routes].filter(id => state.visible.has(model.routeGroups.get(id)?.mode || 'bus')).sort((a, b) => (model.routeRank.get(a) ?? 0) - (model.routeRank.get(b) ?? 0));
  }

  function setOriginalVisible(show) {
    const wrapper = state.wrapper;
    if (!wrapper) return;
    const canvas = wrapper.querySelector('canvas');
    if (canvas) canvas.style.visibility = show ? '' : 'hidden';
    wrapper.querySelectorAll('.label').forEach(el => el.style.visibility = show ? '' : 'hidden');
    if (state.overlay) state.overlay.style.display = show ? 'none' : '';
  }

  function fitForPositions(positions) {
    const vals = [...positions.values()];
    const minX = Math.min(...vals.map(p => p.x)), maxX = Math.max(...vals.map(p => p.x));
    const minY = Math.min(...vals.map(p => p.y)), maxY = Math.max(...vals.map(p => p.y));
    return { x: minX - CFG.pad, y: minY - CFG.pad, w: Math.max(500, maxX - minX + CFG.pad * 2), h: Math.max(360, maxY - minY + CFG.pad * 2) };
  }

  function applyView() {
    if (state.svg && state.view) state.svg.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
  }

  function installPanZoom(svg) {
    svg.style.cursor = 'grab';
    svg.style.touchAction = 'none';
    const clearDrag = () => { state.drag = null; svg.style.cursor = 'grab'; };
    svg.addEventListener('pointerdown', e => {
      if (e.button !== 0 || (e.buttons & 1) !== 1) return;
      state.drag = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, viewX: state.view.x, viewY: state.view.y };
      try { svg.setPointerCapture(e.pointerId); } catch {}
      svg.style.cursor = 'grabbing';
      e.preventDefault();
    });
    svg.addEventListener('pointermove', e => {
      if (!state.drag || state.drag.pointerId !== e.pointerId || (e.buttons & 1) !== 1) {
        if (state.drag && (e.buttons & 1) !== 1) clearDrag();
        return;
      }
      const rect = svg.getBoundingClientRect();
      state.view.x = state.drag.viewX - (e.clientX - state.drag.clientX) / rect.width * state.view.w;
      state.view.y = state.drag.viewY - (e.clientY - state.drag.clientY) / rect.height * state.view.h;
      applyView();
      e.preventDefault();
    });
    svg.addEventListener('pointerup', clearDrag);
    svg.addEventListener('pointercancel', clearDrag);
    svg.addEventListener('lostpointercapture', clearDrag);
    window.addEventListener('blur', clearDrag);
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
    svg.addEventListener('dblclick', () => { state.view = { ...state.fitView }; applyView(); });
  }

  function render() {
    const { model, positions, wrapper } = state;
    if (!model || !positions || !wrapper) return;
    document.getElementById('folityn-v3-overlay')?.remove();
    document.getElementById('folityn-v3-controls')?.remove();
    const bg = state.dark ? '#101827' : '#f6f8fb';
    const fg = state.dark ? '#e6edf7' : '#172033';
    const halo = state.dark ? '#101827' : '#f6f8fb';
    const transfer = state.dark ? '#aeb9c9' : '#455166';
    wrapper.style.position = 'relative';
    const overlay = document.createElement('div');
    overlay.id = 'folityn-v3-overlay';
    Object.assign(overlay.style, { position: 'absolute', inset: '0', zIndex: '30', background: bg, overflow: 'hidden' });
    const svg = svgEl('svg', { width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet' });
    svg.style.display = 'block'; overlay.appendChild(svg); wrapper.appendChild(overlay);
    const routeLayer = svgEl('g'), transferLayer = svgEl('g'), stationLayer = svgEl('g'), labelLayer = svgEl('g');
    svg.append(routeLayer, transferLayer, stationLayer, labelLayer);

    for (const edge of model.edges.values()) {
      const a = positions.get(edge.a), b = positions.get(edge.b);
      if (!a || !b) continue;
      const routeIds = edgeRouteIds(edge, model);
      if (!routeIds.length) continue;
      const center = octilinearPoints(a, b);
      routeIds.forEach((routeId, index) => {
        const group = model.routeGroups.get(routeId);
        const offset = (index - (routeIds.length - 1) / 2) * CFG.laneGap;
        routeLayer.appendChild(svgEl('path', { d: roundedPath(offsetPolyline(center, offset)), fill: 'none', stroke: colorHex(group?.color), 'stroke-width': CFG.lineWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
      });
    }

    if (state.transfers) for (const key of model.transferPairs) {
      const [aId, bId] = key.split('|');
      const a = positions.get(aId), b = positions.get(bId);
      if (!a || !b) continue;
      transferLayer.appendChild(svgEl('path', { d: roundedPath(octilinearPoints(a, b), 10), fill: 'none', stroke: transfer, 'stroke-width': 2.2, 'stroke-dasharray': '7 6', 'vector-effect': 'non-scaling-stroke' }));
    }

    for (const [id, p] of positions) {
      const visibleRoutes = [...(model.nodeRouteGroups.get(id) || [])].filter(rid => state.visible.has(model.routeGroups.get(rid)?.mode || 'bus'));
      if (!visibleRoutes.length) continue;
      const meta = model.stationMeta.get(id), count = visibleRoutes.length;
      const r = 3.6 + Math.min(7.5, Math.log2(count + 1) * 2.1);
      const major = count >= 4 || (model.adjacency.get(id)?.length || 0) >= 3;
      const marker = major ? svgEl('rect', { x: p.x - r * 1.45, y: p.y - r, width: r * 2.9, height: r * 2, rx: r, ry: r, fill: bg, stroke: fg, 'stroke-width': 2.2, 'vector-effect': 'non-scaling-stroke' }) : svgEl('circle', { cx: p.x, cy: p.y, r, fill: bg, stroke: fg, 'stroke-width': 1.8, 'vector-effect': 'non-scaling-stroke' });
      const title = svgEl('title'); title.textContent = `${meta?.name || id} · ${count} route${count === 1 ? '' : 's'}`; marker.appendChild(title); stationLayer.appendChild(marker);
      const showLabel = state.labels === 'all' || (state.labels === 'key' && (major || count >= 2));
      if (showLabel && meta?.name) {
        const text = svgEl('text', { x: p.x + r + 5, y: p.y - r - 3, fill: fg, 'font-size': major ? 11 : 9.5, 'font-family': 'system-ui, sans-serif', 'font-weight': major ? 700 : 550, 'paint-order': 'stroke', stroke: halo, 'stroke-width': 3.8, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' });
        text.textContent = meta.name; labelLayer.appendChild(text);
      }
    }

    state.overlay = overlay; state.svg = svg; state.fitView = fitForPositions(positions);
    if (!state.view) state.view = { ...state.fitView };
    applyView(); installPanZoom(svg); installControls(); setOriginalVisible(!state.enabled);
  }

  function button(text) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    Object.assign(b.style, { border: '1px solid #4b5563', borderRadius: '7px', padding: '6px 8px', background: '#1f2937', color: '#fff', cursor: 'pointer', font: 'inherit' });
    return b;
  }

  function checkbox(label, mode) {
    const wrap = document.createElement('label'); wrap.style.cssText = 'display:flex;align-items:center;gap:6px;min-height:24px;cursor:pointer';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = state.visible.has(mode);
    const text = document.createElement('span'); text.textContent = label;
    input.onchange = () => { input.checked ? state.visible.add(mode) : state.visible.delete(mode); localStorage.setItem(KEY + 'modes', JSON.stringify([...state.visible])); render(); };
    wrap.append(input, text); return wrap;
  }

  function installControls() {
    const panel = document.createElement('div'); panel.id = 'folityn-v3-controls';
    Object.assign(panel.style, { position: 'fixed', left: '14px', bottom: '14px', zIndex: '1000000', width: '282px', padding: '11px', borderRadius: '11px', background: 'rgba(17,24,39,.97)', color: '#fff', boxShadow: '0 6px 22px rgba(0,0,0,.35)', font: '600 12px/1.35 system-ui,sans-serif' });
    const title = document.createElement('div'); title.innerHTML = '<strong style="font-size:14px">Folityn schematic v3</strong><div style="opacity:.62;font-weight:500;margin-top:2px">strict 0° / 45° / 90° geometry</div>';
    const modes = document.createElement('div'); modes.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:3px 8px;margin-top:9px';
    modes.append(checkbox('Light Rail', 'light_rail'), checkbox('Rail', 'rail'), checkbox('High Speed', 'high_speed'), checkbox('Bus / other', 'bus'));
    const opts = document.createElement('div'); opts.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin-top:8px';
    const darkLabel = document.createElement('label'); darkLabel.style.cssText = 'display:flex;gap:6px;align-items:center';
    const dark = document.createElement('input'); dark.type = 'checkbox'; dark.checked = state.dark; dark.onchange = () => { state.dark = dark.checked; localStorage.setItem(KEY + 'dark', state.dark ? '1' : '0'); render(); }; darkLabel.append(dark, document.createTextNode('Dark'));
    const transferLabel = document.createElement('label'); transferLabel.style.cssText = 'display:flex;gap:6px;align-items:center';
    const transfers = document.createElement('input'); transfers.type = 'checkbox'; transfers.checked = state.transfers; transfers.onchange = () => { state.transfers = transfers.checked; localStorage.setItem(KEY + 'transfers', state.transfers ? '1' : '0'); render(); }; transferLabel.append(transfers, document.createTextNode('Transfers')); opts.append(darkLabel, transferLabel);
    const labels = document.createElement('select'); labels.innerHTML = '<option value="key">Key labels</option><option value="all">All labels</option><option value="none">No labels</option>'; labels.value = state.labels;
    Object.assign(labels.style, { width: '100%', marginTop: '8px', padding: '6px', borderRadius: '7px', border: '1px solid #4b5563', background: '#1f2937', color: '#fff' }); labels.onchange = () => { state.labels = labels.value; localStorage.setItem(KEY + 'labels', state.labels); render(); };
    const row = document.createElement('div'); row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 70px;gap:6px;margin-top:8px';
    const schematic = button('Schematic'), original = button('Original'), fit = button('Fit');
    schematic.onclick = () => { state.enabled = true; localStorage.setItem(KEY + 'enabled', '1'); setOriginalVisible(false); };
    original.onclick = () => { state.enabled = false; localStorage.setItem(KEY + 'enabled', '0'); setOriginalVisible(true); };
    fit.onclick = () => { state.view = { ...state.fitView }; applyView(); }; row.append(schematic, original, fit);
    const note = document.createElement('div'); note.style.cssText = 'opacity:.58;font-weight:500;font-size:10.5px;margin-top:7px'; note.textContent = 'Drag only while holding left mouse · wheel zoom · double-click fit · opposite directions are merged';
    panel.append(title, modes, opts, labels, row, note); document.body.appendChild(panel);
  }

  async function main() {
    try {
      document.getElementById('mtr-schematic-overlay')?.remove(); document.getElementById('mtr-schematic-controls')?.remove();
      const [{ wrapper, canvas }, data] = await Promise.all([waitForMap(), loadNetwork()]);
      state.wrapper = wrapper; state.canvas = canvas; state.model = buildModel(data); state.positions = simplifyCorridors(state.model); render();
      console.log('[MTR Map Tools] Folityn schematic v3 loaded', { publicRoutes: state.model.groups.length, physicalEdges: state.model.edges.size, stations: state.positions.size, modes: [...new Set(state.model.groups.map(r => r.mode))] });
    } catch (error) { console.error('[MTR Map Tools] Folityn schematic v3 failed:', error); }
  }

  main();
})();