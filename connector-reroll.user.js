// ==UserScript==
// @name         MTR Map Tools - Folityn Schematic v5.1
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      5.1.0
// @description  Geography-first interactive Folityn schematic with stable lanes, smooth whole-route curves, collision-aware labels and custom interchange hubs.
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
  const KEY = 'folityn-v51-';
  const CFG = { spacing: 76, laneGap: 7.2, radius: 20, pad: 190, maxShortcutHops: 5, shortcutLengthRatio: 1.28, shortcutPerpRatio: 0.15 };

  const BACKBONES = [
    ['Folityn Drzewiec', 'Folityn Centralny'],
    ['Folityn Centralny', 'Folityn Wzgórzyn'],
    ['Folityn Wzgórzyn', 'Folityn Jamnikowsko'],
    ['Folityn Jamnikowsko', 'Szczecinki'],
    ['Folityn Centralny', 'Folityn Staniechowska'],
    ['Folityn Staniechowska', 'Folityn Airport West'],
    ['Folityn Drzewiec', 'Folityn Lipków'],
    ['Folityn Lipków', 'Lipków Wschód'],
  ];

  const VISUAL_GROUPS = [
    { id: 'hub:wity', label: 'Wity', names: ['Folityn Wity', 'Wity PKM'], hub: 'wity' },
  ];

  const state = {
    dark: localStorage.getItem(KEY + 'dark') !== '0',
    labels: localStorage.getItem(KEY + 'labels') || 'key',
    transfers: localStorage.getItem(KEY + 'transfers') !== '0',
    visible: new Set(JSON.parse(localStorage.getItem(KEY + 'modes') || '["light_rail","rail","high_speed"]')),
    wrapper: null, overlay: null, svg: null, layers: null, model: null, pos: null,
    view: null, fitView: null, drag: null, showOriginal: false,
    selectedRoute: null, selectedStation: null, panel: null,
  };

  const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const colorHex = n => `#${((Number(n) >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
  const median = v => { if (!v.length) return 1; const a = [...v].sort((x, y) => x - y), m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

  function modeOf(type) {
    const t = String(type || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (t === 'train_light_rail') return 'light_rail';
    if (t === 'train_normal') return 'rail';
    if (t === 'train_high_speed') return 'high_speed';
    return null;
  }
  const modeLabel = m => ({ light_rail: 'Light Rail', rail: 'Rail', high_speed: 'High Speed' })[m] || m;
  const modeOrder = m => ({ high_speed: 0, rail: 1, light_rail: 2 })[m] ?? 9;
  const routeLabel = r => String(r.name ?? r.routeNumber ?? r.route_number ?? r.number ?? r.id).trim();

  function svgEl(tag, attrs = {}) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; }
  async function waitForMap() { for (;;) { const w = document.querySelector('app-map .wrapper, .wrapper'); if (w?.querySelector('canvas')) return w; await new Promise(r => setTimeout(r, 250)); } }
  async function loadNetwork() { const r = await fetch('/mtr/api/map/stations-and-routes?dimension=0', { cache: 'no-store' }); if (!r.ok) throw new Error(`MTR network request failed (${r.status})`); const j = await r.json(); return j?.data ?? j; }
  function overlapRatio(a, b) { const A = new Set(a), B = new Set(b); let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.max(1, Math.min(A.size, B.size)); }
  function pointSegmentDistance(p, a, b) { const vx = b.x - a.x, vy = b.y - a.y, wx = p.x - a.x, wy = p.y - a.y, vv = vx * vx + vy * vy; if (!vv) return dist(p, a); const t = clamp((wx * vx + wy * vy) / vv, 0, 1); return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t)); }

  function buildModel(data) {
    const groupByName = new Map();
    for (const g of VISUAL_GROUPS) for (const n of g.names) groupByName.set(norm(n), g);
    const rawStation = new Map(), rawToLogical = new Map(), stationMeta = new Map();

    function logicalDescriptor(s) {
      const vg = groupByName.get(norm(s.name));
      if (vg) return { key: vg.id, label: vg.label, hub: vg.hub };
      const k = norm(s.name) || `id:${s.id}`;
      return { key: `name:${k}`, label: String(s.name || s.id), hub: null };
    }

    for (const s of data.stations || []) {
      rawStation.set(s.id, s);
      const d = logicalDescriptor(s);
      let meta = stationMeta.get(d.key);
      if (!meta) { meta = { id: d.key, name: d.label, hub: d.hub, rawIds: new Set(), memberNames: new Set(), connections: new Set() }; stationMeta.set(d.key, meta); }
      meta.rawIds.add(s.id); meta.memberNames.add(String(s.name || s.id)); rawToLogical.set(s.id, d.key);
    }
    for (const s of data.stations || []) {
      const from = rawToLogical.get(s.id), meta = stationMeta.get(from); if (!meta) continue;
      for (const rr of s.connections || []) { const to = rawToLogical.get(rr); if (to && to !== from) meta.connections.add(to); }
    }
    function ensure(rawId) {
      if (rawToLogical.has(rawId)) return rawToLogical.get(rawId);
      const s = rawStation.get(rawId) || { id: rawId, name: rawId }, d = logicalDescriptor(s);
      rawToLogical.set(rawId, d.key);
      if (!stationMeta.has(d.key)) stationMeta.set(d.key, { id: d.key, name: d.label, hub: d.hub, rawIds: new Set([rawId]), memberNames: new Set([String(s.name || rawId)]), connections: new Set() });
      return d.key;
    }

    const occurrences = new Map(), rawServices = [];
    for (const r of data.routes || []) {
      if (r.hidden || !Array.isArray(r.stations) || r.stations.length < 2) continue;
      const mode = modeOf(r.type); if (!mode) continue;
      const nodes = [];
      for (const st of r.stations) {
        if (!st?.id || !Number.isFinite(+st.x) || !Number.isFinite(+st.z)) continue;
        const node = ensure(st.id); if (nodes.at(-1) !== node) nodes.push(node);
        if (!occurrences.has(node)) occurrences.set(node, []);
        occurrences.get(node).push({ x: +st.x, y: +st.z, rawId: st.id });
      }
      if (nodes.length >= 2) rawServices.push({ id: r.id, label: routeLabel(r), mode, color: Number(r.color ?? 0), nodes });
    }

    const original = new Map();
    for (const [id, pts] of occurrences) original.set(id, { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

    const parent = rawServices.map((_, i) => i);
    const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    for (let i = 0; i < rawServices.length; i++) for (let j = i + 1; j < rawServices.length; j++) {
      const a = rawServices[i], b = rawServices[j]; if (a.mode !== b.mode) continue;
      const sameLabel = norm(a.label) === norm(b.label), sameColour = a.color === b.color, overlap = overlapRatio(a.nodes, b.nodes);
      if (sameLabel || (sameColour && overlap >= 0.68)) union(i, j);
    }

    const clusters = new Map(); rawServices.forEach((s, i) => { const root = find(i); if (!clusters.has(root)) clusters.set(root, []); clusters.get(root).push(s); });
    const groups = []; let groupIndex = 0;

    for (const list of clusters.values()) {
      const mode = list[0].mode, colorCounts = new Map(), labelCounts = new Map();
      for (const s of list) { colorCounts.set(s.color, (colorCounts.get(s.color) || 0) + 1); labelCounts.set(s.label, (labelCounts.get(s.label) || 0) + 1); }
      const color = [...colorCounts].sort((a, b) => b[1] - a[1])[0][0], label = [...labelCounts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
      const candidate = new Map();
      for (const s of list) for (let i = 1; i < s.nodes.length; i++) { const key = pairKey(s.nodes[i - 1], s.nodes[i]); if (!candidate.has(key)) { const [a, b] = key.split('|'); candidate.set(key, { key, a, b }); } }
      const adj = new Map();
      for (const e of candidate.values()) { if (!adj.has(e.a)) adj.set(e.a, []); if (!adj.has(e.b)) adj.set(e.b, []); adj.get(e.a).push(e); adj.get(e.b).push(e); }

      function alternateFor(edge) {
        const A = original.get(edge.a), B = original.get(edge.b); if (!A || !B) return null;
        const direct = Math.max(1, dist(A, B)), stack = [{ node: edge.a, path: [edge.a], len: 0 }]; let best = null;
        while (stack.length) {
          const cur = stack.pop(); if (cur.path.length - 1 >= CFG.maxShortcutHops) continue;
          for (const e of adj.get(cur.node) || []) {
            if (e.key === edge.key) continue; const next = e.a === cur.node ? e.b : e.a; if (cur.path.includes(next)) continue;
            const p = original.get(cur.node), q = original.get(next); if (!p || !q) continue;
            const len = cur.len + dist(p, q); if (len > direct * 1.55) continue; const path = [...cur.path, next];
            if (next === edge.b && path.length >= 3) {
              const mids = path.slice(1, -1).map(id => original.get(id)).filter(Boolean), maxPerp = mids.length ? Math.max(...mids.map(m => pointSegmentDistance(m, A, B))) : Infinity;
              if (len / direct <= CFG.shortcutLengthRatio && maxPerp <= direct * CFG.shortcutPerpRatio) { const score = len / direct + maxPerp / direct; if (!best || score < best.score) best = { path, score }; }
            } else stack.push({ node: next, path, len });
          }
        }
        return best;
      }

      const dropped = new Set(); for (const e of candidate.values()) if (alternateFor(e)) dropped.add(e.key);
      const edges = new Set([...candidate.keys()].filter(k => !dropped.has(k))), nodes = new Set();
      for (const k of edges) for (const id of k.split('|')) nodes.add(id);
      const stopCounts = new Map(); for (const s of list) for (const n of new Set(s.nodes)) stopCounts.set(n, (stopCounts.get(n) || 0) + 1);
      groups.push({ id: `${mode}|${color}|${groupIndex++}`, label, mode, color, services: list, edges, nodes, stopCounts, serviceCount: list.length });
    }

    groups.sort((a, b) => modeOrder(a.mode) - modeOrder(b.mode) || a.label.localeCompare(b.label, undefined, { numeric: true }) || a.id.localeCompare(b.id));
    const groupById = new Map(groups.map(g => [g.id, g])), rank = new Map(groups.map((g, i) => [g.id, i])), edges = new Map(), nodeGroups = new Map(), endpoints = new Set();
    for (const g of groups) {
      for (const n of g.nodes) { if (!nodeGroups.has(n)) nodeGroups.set(n, new Set()); nodeGroups.get(n).add(g.id); }
      for (const s of g.services) if (s.nodes.length) { endpoints.add(s.nodes[0]); endpoints.add(s.nodes.at(-1)); }
      for (const k of g.edges) { let e = edges.get(k); if (!e) { const [a, b] = k.split('|'); e = { key: k, a, b, routes: new Set() }; edges.set(k, e); } e.routes.add(g.id); }
    }

    const rawLengths = []; for (const e of edges.values()) { const a = original.get(e.a), b = original.get(e.b); if (a && b) rawLengths.push(dist(a, b)); }
    const scale = CFG.spacing / Math.max(1, median(rawLengths)), vals = [...original.values()], cx = vals.reduce((s, p) => s + p.x, 0) / Math.max(1, vals.length), cy = vals.reduce((s, p) => s + p.y, 0) / Math.max(1, vals.length);
    const geo = new Map(); for (const [id, p] of original) geo.set(id, { x: (p.x - cx) * scale, y: (p.y - cy) * scale });
    const adjacency = new Map([...geo.keys()].map(id => [id, []]));
    for (const e of edges.values()) if (geo.has(e.a) && geo.has(e.b)) { adjacency.get(e.a).push(e); adjacency.get(e.b).push(e); }
    const transfers = new Set(); for (const m of stationMeta.values()) for (const other of m.connections || []) if (geo.has(m.id) && geo.has(other) && other !== m.id) transfers.add(pairKey(m.id, other));
    return { stationMeta, groups, groupById, rank, edges, nodeGroups, endpoints, original, geo, adjacency, transfers };
  }

  function octilinear(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, ax = Math.abs(dx), ay = Math.abs(dy), eps = 0.5;
    if (ax < eps || ay < eps || Math.abs(ax - ay) < eps) return [{ ...a }, { ...b }];
    const sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1, mid = ax > ay ? { x: a.x + sx * (ax - ay), y: a.y } : { x: a.x, y: a.y + sy * (ay - ax) };
    return dist(a, mid) < eps || dist(mid, b) < eps ? [{ ...a }, { ...b }] : [{ ...a }, mid, { ...b }];
  }
  function pointAlong(points, fraction) {
    const lens = []; let total = 0; for (let i = 1; i < points.length; i++) { const l = dist(points[i - 1], points[i]); lens.push(l); total += l; }
    if (!total) return { ...points[0] }; let target = clamp(fraction, 0, 1) * total;
    for (let i = 0; i < lens.length; i++) { if (target <= lens[i] || i === lens.length - 1) { const u = lens[i] ? target / lens[i] : 0; return { x: points[i].x + (points[i + 1].x - points[i].x) * u, y: points[i].y + (points[i + 1].y - points[i].y) * u }; } target -= lens[i]; }
    return { ...points.at(-1) };
  }
  function shortestPath(model, start, goal) {
    if (!start || !goal || start === goal) return start ? [start] : null;
    const d = new Map([[start, 0]]), prev = new Map(), open = new Set([start]);
    while (open.size) { let cur = null, best = Infinity; for (const n of open) { const v = d.get(n) ?? Infinity; if (v < best) { best = v; cur = n; } } if (cur === null) break; open.delete(cur); if (cur === goal) break;
      for (const e of model.adjacency.get(cur) || []) { const next = e.a === cur ? e.b : e.a, p = model.geo.get(cur), q = model.geo.get(next); if (!p || !q) continue; const nd = best + dist(p, q); if (nd < (d.get(next) ?? Infinity)) { d.set(next, nd); prev.set(next, cur); open.add(next); } }
    }
    if (!d.has(goal)) return null; const path = [goal]; while (path[0] !== start) { const p = prev.get(path[0]); if (!p) return null; path.unshift(p); } return path;
  }
  function projectPath(pos, path, polyline) { if (!path || path.length < 3) return; const pts = path.map(id => pos.get(id)); let total = 0; const cum = [0]; for (let i = 1; i < pts.length; i++) { total += dist(pts[i - 1], pts[i]); cum.push(total); } if (!total) return; for (let i = 1; i < path.length - 1; i++) pos.set(path[i], pointAlong(polyline, cum[i] / total)); }
  function findName(byName, names) { for (const n of names) { const id = byName.get(norm(n)); if (id) return id; } return null; }

  function applyBackbones(model) {
    const pos = new Map([...model.geo].map(([id, p]) => [id, { ...p }])), byName = new Map([...model.stationMeta.values()].map(s => [norm(s.name), s.id]));
    for (const [fromName, toName] of BACKBONES) {
      const from = byName.get(norm(fromName)), to = byName.get(norm(toName)); if (!from || !to || !pos.has(from) || !pos.has(to)) continue;
      const path = shortestPath(model, from, to); if (!path || path.length < 3) continue;
      const direct = dist(pos.get(from), pos.get(to)); let len = 0; for (let i = 1; i < path.length; i++) len += dist(pos.get(path[i - 1]), pos.get(path[i]));
      if (len <= direct * 2.2) projectPath(pos, path, octilinear(pos.get(from), pos.get(to)));
    }
    const wiadukt = byName.get(norm('Wiadukt Torowy')), rcm = byName.get(norm('Rogowska Centrum Miejskie'));
    if (wiadukt && rcm && pos.has(wiadukt) && pos.has(rcm)) { const w = pos.get(wiadukt), r = pos.get(rcm); if (w.y >= r.y - 12) pos.set(wiadukt, { x: w.x, y: r.y - Math.max(38, Math.abs(w.y - r.y)) }); }
    const target = findName(byName, ['Szwedzka/Norweska', 'Szwedzka Norweska', 'Szwedzka Stadion']);
    if (rcm && target && pos.has(rcm) && pos.has(target)) {
      const path = shortestPath(model, rcm, target);
      if (path && path.length >= 2) { const a = pos.get(rcm), rawB = pos.get(target), L = dist(a, rawB), sx = Math.sign(rawB.x - a.x) || 1, sy = Math.sign(rawB.y - a.y) || 1, u = L / Math.sqrt(2), b = { x: a.x + sx * u, y: a.y + sy * u }; pos.set(target, b); projectPath(pos, path, [a, b]); }
    }
    return pos;
  }

  function roundedPath(points, radius = CFG.radius) {
    if (points.length < 2) return ''; if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) { const a = points[i - 1], b = points[i], c = points[i + 1], l1 = dist(a, b), l2 = dist(b, c); if (l1 < 0.001 || l2 < 0.001) continue; const r = Math.min(radius, l1 * 0.42, l2 * 0.42), u1 = { x: (b.x - a.x) / l1, y: (b.y - a.y) / l1 }, u2 = { x: (c.x - b.x) / l2, y: (c.y - b.y) / l2 }, pin = { x: b.x - u1.x * r, y: b.y - u1.y * r }, pout = { x: b.x + u2.x * r, y: b.y + u2.y * r }; d += ` L ${pin.x} ${pin.y} Q ${b.x} ${b.y} ${pout.x} ${pout.y}`; }
    const z = points.at(-1); return d + ` L ${z.x} ${z.y}`;
  }
  function appendOctilinear(out, a, b) { const seg = octilinear(a, b); for (let i = 1; i < seg.length; i++) { const p = seg[i], last = out.at(-1); if (!last || dist(last, p) > 0.01) out.push(p); } }
  function offsetPolyline(points, offset) {
    if (Math.abs(offset) < 0.001 || points.length < 2) return points.map(p => ({ ...p })); const normals = [];
    for (let i = 1; i < points.length; i++) { const dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y, l = Math.max(0.001, Math.hypot(dx, dy)); normals.push({ x: -dy / l, y: dx / l }); }
    return points.map((p, i) => { let n; if (i === 0) n = normals[0]; else if (i === points.length - 1) n = normals.at(-1); else { const x = normals[i - 1].x + normals[i].x, y = normals[i - 1].y + normals[i].y, l = Math.hypot(x, y); n = l < 0.001 ? normals[i] : { x: x / l, y: y / l }; } return { x: p.x + n.x * offset, y: p.y + n.y * offset }; });
  }

  function computeLaneOffsets(model) {
    const routeAdj = new Map(model.groups.map(g => [g.id, new Set()]));
    for (const e of model.edges.values()) { const ids = [...e.routes]; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { routeAdj.get(ids[i])?.add(ids[j]); routeAdj.get(ids[j])?.add(ids[i]); } }
    const order = [...model.groups].sort((a, b) => (routeAdj.get(b.id)?.size || 0) - (routeAdj.get(a.id)?.size || 0) || (model.rank.get(a.id) ?? 999) - (model.rank.get(b.id) ?? 999));
    const colour = new Map();
    for (const g of order) { const used = new Set([...(routeAdj.get(g.id) || [])].map(n => colour.get(n)).filter(v => v !== undefined)); let c = 0; while (used.has(c)) c++; colour.set(g.id, c); }
    const maxColour = Math.max(0, ...colour.values()), centre = maxColour / 2;
    return new Map(model.groups.map(g => [g.id, ((colour.get(g.id) || 0) - centre) * CFG.laneGap]));
  }

  function traceRoute(group) {
    const adj = new Map();
    for (const k of group.edges) { const [a, b] = k.split('|'); if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []); adj.get(a).push({ key: k, other: b }); adj.get(b).push({ key: k, other: a }); }
    const trails = [], visited = new Set(), starts = [...adj.keys()].filter(n => adj.get(n).length !== 2);
    const walk = (start, first) => { const nodes = [start]; let cur = start, edge = first; while (edge && !visited.has(edge.key)) { visited.add(edge.key); cur = edge.other; nodes.push(cur); if ((adj.get(cur)?.length || 0) !== 2) break; edge = adj.get(cur).find(e => !visited.has(e.key)); } if (nodes.length >= 2) trails.push(nodes); };
    for (const s of starts) for (const e of adj.get(s) || []) if (!visited.has(e.key)) walk(s, e);
    for (const [s, list] of adj) for (const e of list) if (!visited.has(e.key)) walk(s, e);
    return trails;
  }
  function trailGeometry(nodes) { if (nodes.length < 2) return []; const first = state.pos.get(nodes[0]); if (!first) return []; const out = [{ ...first }]; for (let i = 1; i < nodes.length; i++) { const a = state.pos.get(nodes[i - 1]), b = state.pos.get(nodes[i]); if (a && b) appendOctilinear(out, a, b); } return out; }

  function createOverlay() {
    const wrapper = state.wrapper; wrapper.style.position = wrapper.style.position || 'relative'; const overlay = document.createElement('div'); overlay.id = 'folityn-v51-overlay'; overlay.style.cssText = 'position:absolute;inset:0;z-index:30;overflow:hidden;cursor:grab;user-select:none;touch-action:none;'; const svg = svgEl('svg', { width: '100%', height: '100%', xmlns: NS }); svg.style.display = 'block'; overlay.appendChild(svg); wrapper.appendChild(overlay);
    const bg = svgEl('rect', { x: -100000, y: -100000, width: 200000, height: 200000 }), root = svgEl('g'), transfers = svgEl('g'), routes = svgEl('g'), stops = svgEl('g'), labels = svgEl('g'); root.append(transfers, routes, stops, labels); svg.append(bg, root); state.overlay = overlay; state.svg = svg; state.layers = { bg, root, transfers, routes, stops, labels };
  }
  function computeBounds() { const vals = [...state.pos.values()]; if (!vals.length) return { x: -500, y: -500, w: 1000, h: 1000 }; const minX = Math.min(...vals.map(p => p.x)) - CFG.pad, maxX = Math.max(...vals.map(p => p.x)) + CFG.pad, minY = Math.min(...vals.map(p => p.y)) - CFG.pad, maxY = Math.max(...vals.map(p => p.y)) + CFG.pad; return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }; }
  function applyView() { const v = state.view || state.fitView; if (v) state.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`); }
  function fit() { state.fitView = computeBounds(); state.view = { ...state.fitView }; applyView(); }

  function drawTransfers() {
    const g = state.layers.transfers; g.textContent = ''; if (!state.transfers) return;
    for (const k of state.model.transfers) { const [aId, bId] = k.split('|'), a = state.pos.get(aId), b = state.pos.get(bId); if (!a || !b) continue; g.appendChild(svgEl('path', { d: roundedPath(octilinear(a, b), 10), fill: 'none', stroke: state.dark ? '#9aa7ba' : '#667085', 'stroke-width': 1.5, 'stroke-dasharray': '5 6', 'stroke-linecap': 'round', opacity: 0.55 })); }
  }

  function drawRoutes() {
    const g = state.layers.routes; g.textContent = ''; const lane = state.model.laneOffsets;
    for (const route of state.model.groups) {
      if (!state.visible.has(route.mode)) continue; const selected = state.selectedRoute === route.id, dim = state.selectedRoute && !selected;
      for (const trail of traceRoute(route)) {
        const center = trailGeometry(trail); if (center.length < 2) continue; const pts = offsetPolyline(center, lane.get(route.id) || 0), width = (route.mode === 'high_speed' ? 5.8 : route.mode === 'rail' ? 5.4 : 4.9) + (selected ? 2.2 : 0);
        const p = svgEl('path', { d: roundedPath(pts), fill: 'none', stroke: colorHex(route.color), 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: dim ? 0.16 : 1, 'data-route': route.id }); p.style.cursor = 'pointer'; p.style.pointerEvents = 'stroke'; const title = svgEl('title'); title.textContent = `${route.label} · ${modeLabel(route.mode)}`; p.appendChild(title); p.addEventListener('click', e => { e.stopPropagation(); state.selectedStation = null; state.selectedRoute = route.id; showRoutePanel(route.id); render(); }); g.appendChild(p);
      }
    }
  }

  function drawHubIcon(group, p, type, bg, fg) {
    const g = svgEl('g'); g.style.cursor = 'pointer'; g.style.pointerEvents = 'all'; const r = type === 'central' ? 19 : 14; g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r, fill: bg, stroke: fg, 'stroke-width': type === 'central' ? 2.8 : 2.2 })); const text = svgEl('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', fill: fg, 'font-size': type === 'central' ? 10 : 8.5, 'font-family': 'Arial, sans-serif', 'font-weight': 700 }); text.textContent = type === 'central' ? '🚆🚌' : '🚆'; g.appendChild(text); group.appendChild(g); return g;
  }
  function rectsOverlap(a, b, gap = 3) { return !(a.x + a.w + gap < b.x || b.x + b.w + gap < a.x || a.y + a.h + gap < b.y || b.y + b.h + gap < a.y); }
  function labelPlacement(items, occupied) {
    const out = [], candidates = [[10,-19,'start'],[12,4,'start'],[10,18,'start'],[-10,-19,'end'],[-12,4,'end'],[-10,18,'end'],[0,-23,'middle'],[0,25,'middle']];
    for (const it of items) {
      const fs = it.fontSize, w = Math.max(28, it.text.length * fs * 0.58), h = fs + 5; let chosen = null;
      for (const [dx, dy, anchor] of candidates) { const x = it.p.x + dx, y = it.p.y + dy, bx = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x, box = { x: bx, y: y - h + 3, w, h }; if (![...occupied, ...out.map(x => x.box)].some(o => rectsOverlap(box, o))) { chosen = { x, y, anchor, box }; break; } }
      if (!chosen) { if (state.labels === 'key' && !it.force) continue; const [dx, dy, anchor] = candidates[0], x = it.p.x + dx, y = it.p.y + dy; chosen = { x, y, anchor, box: { x, y: y - h, w, h } }; }
      out.push({ ...it, ...chosen });
    }
    return out;
  }

  function drawStopsAndLabels() {
    const sg = state.layers.stops, lg = state.layers.labels; sg.textContent = ''; lg.textContent = ''; const bg = state.dark ? '#0f1828' : '#f7f8fa', fg = state.dark ? '#e9eef7' : '#172033', labelItems = [], occupied = [];
    for (const [node, idsSet] of state.model.nodeGroups) {
      const ids = [...idsSet].filter(id => state.visible.has(state.model.groupById.get(id)?.mode)); if (!ids.length) continue; const p = state.pos.get(node), meta = state.model.stationMeta.get(node); if (!p || !meta) continue;
      const isCentral = norm(meta.name) === norm('Folityn Centralny'), isWity = meta.hub === 'wity', isTransfer = meta.connections?.size > 0, major = ids.length >= 3 || isTransfer || isCentral || isWity; let hit;
      if (isCentral) { hit = drawHubIcon(sg, p, 'central', bg, fg); occupied.push({ x: p.x - 22, y: p.y - 22, w: 44, h: 44 }); }
      else if (isWity) { hit = drawHubIcon(sg, p, 'wity', bg, fg); occupied.push({ x: p.x - 17, y: p.y - 17, w: 34, h: 34 }); }
      else if (major) { const w = clamp(23 + ids.length * 4.5, 30, 58); hit = svgEl('rect', { x: p.x - w / 2, y: p.y - 7.5, width: w, height: 15, rx: 7.5, fill: bg, stroke: fg, 'stroke-width': 1.8 }); hit.style.cursor = 'pointer'; hit.style.pointerEvents = 'all'; sg.appendChild(hit); occupied.push({ x: p.x - w / 2 - 2, y: p.y - 10, w: w + 4, h: 20 }); }
      else { hit = svgEl('circle', { cx: p.x, cy: p.y, r: 4.2, fill: bg, stroke: fg, 'stroke-width': 1.6 }); hit.style.cursor = 'pointer'; hit.style.pointerEvents = 'all'; sg.appendChild(hit); occupied.push({ x: p.x - 6, y: p.y - 6, w: 12, h: 12 }); }
      hit.addEventListener('click', e => { e.stopPropagation(); state.selectedRoute = null; state.selectedStation = node; showStationPanel(node); render(); });
      let show = state.labels === 'all'; if (state.labels === 'key') show = major || state.model.endpoints.has(node);
      if (show) labelItems.push({ node, p, text: meta.name, fontSize: isCentral ? 14 : isWity ? 12.5 : major ? 12 : 10.8, force: isCentral || isWity, priority: isCentral ? 100 : isWity ? 90 : major ? 60 : 20 });
    }
    labelItems.sort((a, b) => b.priority - a.priority);
    for (const it of labelPlacement(labelItems, occupied)) { const t = svgEl('text', { x: it.x, y: it.y, 'text-anchor': it.anchor, fill: fg, 'font-size': it.fontSize, 'font-family': 'Arial, sans-serif', 'font-weight': it.force ? 650 : 500, 'paint-order': 'stroke', stroke: bg, 'stroke-width': 3.4 }); t.textContent = it.text; t.style.cursor = 'pointer'; t.style.pointerEvents = 'all'; t.addEventListener('click', e => { e.stopPropagation(); state.selectedRoute = null; state.selectedStation = it.node; showStationPanel(it.node); render(); }); lg.appendChild(t); }
  }

  function render() { state.layers.bg.setAttribute('fill', state.dark ? '#0f1828' : '#f7f8fa'); drawTransfers(); drawRoutes(); drawStopsAndLabels(); }

  function panelBase(title) {
    if (!state.panel) { const p = document.createElement('div'); p.id = 'folityn-detail-panel'; p.style.cssText = 'position:fixed;right:18px;top:64px;z-index:100001;width:310px;max-height:calc(100vh - 90px);overflow:auto;background:rgba(12,18,30,.97);color:#eef3fb;border:1px solid #ffffff22;border-radius:14px;padding:14px;box-shadow:0 12px 36px #0009;font:13px/1.4 Arial,sans-serif;'; document.body.appendChild(p); state.panel = p; }
    state.panel.style.display = 'block'; state.panel.innerHTML = `<button id="folityn-close" style="float:right;border:0;background:#25324a;color:#fff;border-radius:7px;padding:3px 7px;cursor:pointer">×</button><div style="font-size:17px;font-weight:750;margin:0 34px 10px 0">${title}</div><div id="folityn-panel-body"></div>`; state.panel.querySelector('#folityn-close').onclick = () => { state.panel.style.display = 'none'; state.selectedRoute = null; state.selectedStation = null; render(); }; return state.panel.querySelector('#folityn-panel-body');
  }
  function showRoutePanel(id) {
    const route = state.model.groupById.get(id); if (!route) return; const body = panelBase(`<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${colorHex(route.color)};margin-right:7px"></span>${route.label}`), stationIds = new Set(); for (const s of route.services) for (const n of s.nodes) stationIds.add(n); const names = [...stationIds].map(n => state.model.stationMeta.get(n)?.name || n); body.innerHTML = `<div style="opacity:.7;margin-bottom:8px">${modeLabel(route.mode)} · ${names.length} stops</div><div style="display:flex;flex-wrap:wrap;gap:5px">${names.map(n => `<span style="background:#ffffff12;border-radius:6px;padding:3px 6px">${n}</span>`).join('')}</div>`;
  }
  function showStationPanel(node) {
    const meta = state.model.stationMeta.get(node), pRaw = state.model.original.get(node); if (!meta) return; const body = panelBase(meta.name), routes = [...(state.model.nodeGroups.get(node) || [])].map(id => state.model.groupById.get(id)).filter(Boolean), members = [...meta.memberNames], memberBlock = members.length > 1 ? `<div style="margin:9px 0"><div style="opacity:.65;font-size:11px;text-transform:uppercase">Grouped MTR stops</div>${members.map(x => `<div>• ${x}</div>`).join('')}</div>` : '', coord = pRaw ? `<div style="opacity:.65;margin:8px 0">Minecraft: X ${Math.round(pRaw.x)} · Z ${Math.round(pRaw.y)}</div>` : '';
    body.innerHTML = `${memberBlock}${coord}<div style="opacity:.65;font-size:11px;text-transform:uppercase;margin-top:10px">Services</div><div id="folityn-route-buttons" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:5px"></div>`; const wrap = body.querySelector('#folityn-route-buttons'); for (const r of routes) { const b = document.createElement('button'); b.textContent = r.label; b.style.cssText = `border:0;border-left:5px solid ${colorHex(r.color)};background:#ffffff12;color:#fff;padding:5px 8px;border-radius:6px;cursor:pointer`; b.onclick = () => { state.selectedStation = null; state.selectedRoute = r.id; showRoutePanel(r.id); render(); }; wrap.appendChild(b); }
  }

  function buildControls() {
    const box = document.createElement('div'); box.id = 'folityn-v51-controls'; box.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:99999;background:rgba(12,18,30,.94);color:#fff;padding:12px 13px;border-radius:12px;font:13px/1.35 Arial,sans-serif;box-shadow:0 6px 24px #0008;min-width:215px;'; box.innerHTML = '<div style="font-weight:700;font-size:14px">Folityn schematic v5.1</div><div style="opacity:.7;font-size:11px;margin:2px 0 9px">geography locked · interactive</div>';
    for (const [mode, label] of [['light_rail','Light Rail'],['rail','Rail'],['high_speed','High Speed']]) { const row = document.createElement('label'); row.style.cssText = 'display:block;margin:5px 0;cursor:pointer'; const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = state.visible.has(mode); cb.style.marginRight = '7px'; cb.onchange = () => { if (cb.checked) state.visible.add(mode); else state.visible.delete(mode); localStorage.setItem(KEY + 'modes', JSON.stringify([...state.visible])); render(); }; row.append(cb, document.createTextNode(label)); box.appendChild(row); }
    const hr = document.createElement('div'); hr.style.cssText = 'height:1px;background:#ffffff22;margin:9px 0'; box.appendChild(hr);
    const mkCheck = (label, checked, fn) => { const row = document.createElement('label'); row.style.cssText = 'display:block;margin:5px 0;cursor:pointer'; const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked; cb.style.marginRight = '7px'; cb.onchange = () => fn(cb.checked); row.append(cb, document.createTextNode(label)); box.appendChild(row); };
    mkCheck('Dark mode', state.dark, v => { state.dark = v; localStorage.setItem(KEY + 'dark', v ? '1' : '0'); render(); }); mkCheck('Transfer links', state.transfers, v => { state.transfers = v; localStorage.setItem(KEY + 'transfers', v ? '1' : '0'); render(); });
    const select = document.createElement('select'); select.style.cssText = 'width:100%;margin:7px 0;padding:5px;background:#172033;color:#fff;border:1px solid #ffffff33;border-radius:6px'; select.innerHTML = '<option value="key">Key labels</option><option value="all">All labels</option><option value="none">No labels</option>'; select.value = state.labels; select.onchange = () => { state.labels = select.value; localStorage.setItem(KEY + 'labels', state.labels); render(); }; box.appendChild(select);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px;margin-top:6px'; const button = (text, fn) => { const b = document.createElement('button'); b.textContent = text; b.style.cssText = 'flex:1;padding:6px;border:0;border-radius:7px;background:#25324a;color:#fff;cursor:pointer'; b.onclick = fn; return b; }; row.append(button('Fit', fit), button('Original', () => { state.showOriginal = !state.showOriginal; state.overlay.style.display = state.showOriginal ? 'none' : 'block'; })); box.appendChild(row); document.body.appendChild(box);
  }

  function installInteraction() {
    const ov = state.overlay;
    ov.addEventListener('mousedown', e => { if (e.button !== 0) return; state.drag = { x: e.clientX, y: e.clientY, view: { ...state.view } }; ov.style.cursor = 'grabbing'; });
    window.addEventListener('mousemove', e => { if (!state.drag) return; if (!(e.buttons & 1)) { state.drag = null; ov.style.cursor = 'grab'; return; } const rect = ov.getBoundingClientRect(), dx = (e.clientX - state.drag.x) * state.drag.view.w / Math.max(1, rect.width), dy = (e.clientY - state.drag.y) * state.drag.view.h / Math.max(1, rect.height); state.view = { ...state.drag.view, x: state.drag.view.x - dx, y: state.drag.view.y - dy }; applyView(); });
    window.addEventListener('mouseup', () => { state.drag = null; ov.style.cursor = 'grab'; });
    ov.addEventListener('wheel', e => { e.preventDefault(); const rect = ov.getBoundingClientRect(), mx = (e.clientX - rect.left) / rect.width, my = (e.clientY - rect.top) / rect.height, factor = Math.exp(e.deltaY * 0.0012), old = state.view, nw = clamp(old.w * factor, state.fitView.w * 0.07, state.fitView.w * 8), nh = nw * old.h / old.w; state.view = { x: old.x + mx * (old.w - nw), y: old.y + my * (old.h - nh), w: nw, h: nh }; applyView(); }, { passive: false });
    ov.addEventListener('dblclick', fit); ov.addEventListener('click', e => { if (e.target === ov || e.target === state.svg || e.target === state.layers.bg) { state.selectedRoute = null; state.selectedStation = null; if (state.panel) state.panel.style.display = 'none'; render(); } });
  }

  async function init() {
    try { state.wrapper = await waitForMap(); const data = await loadNetwork(); state.model = buildModel(data); state.pos = applyBackbones(state.model); state.model.laneOffsets = computeLaneOffsets(state.model); createOverlay(); fit(); render(); buildControls(); installInteraction(); }
    catch (err) { console.error('[Folityn v5.1]', err); }
  }
  init();
})();