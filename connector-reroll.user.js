// ==UserScript==
// @name         MTR Map Tools - Folityn Schematic v3.4
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      3.4.0
// @description  Poznan-style Folityn renderer: one stroke per public line, shared corridor geometry, directional stop symbols.
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
  const KEY = 'folityn-schematic-v34-';
  const CFG = {
    targetSpacing: 82,
    lineWidth: 5.2,
    laneGap: 7,
    cornerRadius: 18,
    pad: 165,
    centerDx: 78,
    centerDy: 88,
    stopLength: 13,
    stopWidth: 5.6,
  };

  const state = {
    enabled: localStorage.getItem(KEY + 'enabled') !== '0',
    dark: localStorage.getItem(KEY + 'dark') !== '0',
    labels: localStorage.getItem(KEY + 'labels') || 'key',
    transfers: localStorage.getItem(KEY + 'transfers') !== '0',
    visible: new Set(JSON.parse(localStorage.getItem(KEY + 'modes') || '["light_rail","rail","high_speed"]')),
    wrapper: null,
    overlay: null,
    svg: null,
    layers: null,
    model: null,
    positions: null,
    view: null,
    fitView: null,
    drag: null,
  };

  const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const colorHex = v => `#${((Number(v) >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  function median(values) {
    if (!values.length) return 1;
    const a = [...values].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function modeOf(type) {
    const t = String(type || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (t === 'train_light_rail') return 'light_rail';
    if (t === 'train_normal') return 'rail';
    if (t === 'train_high_speed') return 'high_speed';
    return null;
  }

  function modeOrder(mode) {
    return ({ high_speed: 0, rail: 1, light_rail: 2 })[mode] ?? 9;
  }

  function publicLabel(route) {
    return String(route.name ?? route.routeNumber ?? route.route_number ?? route.number ?? route.id).trim();
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
      if (wrapper && canvas) return wrapper;
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
      if (!stationMeta.has(id)) {
        stationMeta.set(id, { id, name: String(raw?.name || rawId), rawIds: new Set([rawId]), connections: new Set() });
      }
      return id;
    }

    const occurrences = new Map();
    const routeGroups = new Map();

    for (const raw of data.routes || []) {
      if (raw.hidden || !Array.isArray(raw.stations) || raw.stations.length < 2) continue;
      const mode = modeOf(raw.type);
      if (!mode) continue;

      const label = publicLabel(raw);
      const groupKey = `${mode}|${norm(label)}`;
      let group = routeGroups.get(groupKey);
      if (!group) {
        group = {
          id: groupKey,
          label,
          mode,
          color: Number(raw.color ?? 0),
          colorCounts: new Map(),
          variants: [],
          variantSigs: new Set(),
          edges: new Set(),
          nodes: new Set(),
          baseVariant: [],
          stopOrientations: new Map(),
        };
        routeGroups.set(groupKey, group);
      }

      const color = Number(raw.color ?? 0);
      group.colorCounts.set(color, (group.colorCounts.get(color) || 0) + 1);

      const ids = [];
      for (const stop of raw.stations) {
        if (!stop?.id || !Number.isFinite(Number(stop.x)) || !Number.isFinite(Number(stop.z))) continue;
        const node = ensureLogical(stop.id);
        if (ids.at(-1) !== node) ids.push(node);
        if (!occurrences.has(node)) occurrences.set(node, []);
        occurrences.get(node).push({ x: Number(stop.x), y: Number(stop.z) });
      }
      if (ids.length < 2) continue;

      const sig = ids.join('>');
      if (!group.variantSigs.has(sig)) {
        group.variantSigs.add(sig);
        group.variants.push(ids);
      }
      for (const id of ids) group.nodes.add(id);
    }

    for (const group of routeGroups.values()) {
      let bestColor = group.color, bestCount = -1;
      for (const [color, count] of group.colorCounts) {
        if (count > bestCount) { bestColor = color; bestCount = count; }
      }
      group.color = bestColor;

      group.baseVariant = [...group.variants].sort((a, b) => b.length - a.length)[0] || [];
      const baseIndex = new Map(group.baseVariant.map((id, i) => [id, i]));

      for (let i = 1; i < group.baseVariant.length; i++) {
        group.edges.add(pairKey(group.baseVariant[i - 1], group.baseVariant[i]));
      }

      // Other direction/variants are service patterns, not alternate geometry.
      // If two nodes already lie on the base corridor, do NOT add a shortcut edge.
      for (const variant of group.variants) {
        for (let i = 1; i < variant.length; i++) {
          const a = variant[i - 1], b = variant[i];
          const ia = baseIndex.get(a), ib = baseIndex.get(b);
          if (ia !== undefined && ib !== undefined) continue;
          group.edges.add(pairKey(a, b));
        }
      }

      // Work out which direction(s) serve each stop.
      for (const variant of group.variants) {
        let orientation = 1;
        let firstIndex = null;
        for (const id of variant) {
          const bi = baseIndex.get(id);
          if (bi === undefined) continue;
          if (firstIndex === null) firstIndex = bi;
          else if (bi !== firstIndex) {
            orientation = bi > firstIndex ? 1 : -1;
            break;
          }
        }
        for (const id of variant) {
          if (!group.stopOrientations.has(id)) group.stopOrientations.set(id, new Set());
          group.stopOrientations.get(id).add(orientation);
        }
      }
    }

    const edges = new Map();
    const nodeRouteGroups = new Map();
    const routeEndpoints = new Set();

    for (const group of routeGroups.values()) {
      for (const id of group.nodes) {
        if (!nodeRouteGroups.has(id)) nodeRouteGroups.set(id, new Set());
        nodeRouteGroups.get(id).add(group.id);
      }
      for (const variant of group.variants) {
        if (variant.length) {
          routeEndpoints.add(variant[0]);
          routeEndpoints.add(variant.at(-1));
        }
      }
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

    const groups = [...routeGroups.values()].sort((a, b) =>
      modeOrder(a.mode) - modeOrder(b.mode) ||
      a.label.localeCompare(b.label, undefined, { numeric: true }) ||
      a.id.localeCompare(b.id)
    );
    const routeRank = new Map(groups.map((g, i) => [g.id, i]));

    const original = new Map();
    for (const [id, pts] of occurrences) {
      original.set(id, {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      });
    }

    const lengths = [];
    for (const edge of edges.values()) {
      const a = original.get(edge.a), b = original.get(edge.b);
      if (a && b) lengths.push(dist(a, b));
    }
    const scale = CFG.targetSpacing / Math.max(1, median(lengths));
    const vals = [...original.values()];
    const cx = vals.reduce((s, p) => s + p.x, 0) / Math.max(1, vals.length);
    const cy = vals.reduce((s, p) => s + p.y, 0) / Math.max(1, vals.length);

    const geo = new Map();
    for (const [id, p] of original) {
      const dx = (p.x - cx) * scale;
      const dy = (p.y - cy) * scale;
      const r = Math.hypot(dx, dy);
      const compressed = r > 840 ? 840 + Math.sqrt(r - 840) * 12 : r;
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
      for (const other of meta.connections || []) {
        if (geo.has(other) && other !== meta.id) transferPairs.add(pairKey(meta.id, other));
      }
    }

    return {
      stationMeta, routeGroups, groups, routeRank, edges, original, geo, adjacency,
      nodeRouteGroups, routeEndpoints, transferPairs,
    };
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
    for (let i = 1; i < points.length; i++) {
      const len = dist(points[i - 1], points[i]);
      lens.push(len);
      total += len;
    }
    if (!total) return { ...points[0] };
    let target = clamp(fraction, 0, 1) * total;
    for (let i = 0; i < lens.length; i++) {
      if (target <= lens[i] || i === lens.length - 1) {
        const u = lens[i] ? target / lens[i] : 0;
        return {
          x: points[i].x + (points[i + 1].x - points[i].x) * u,
          y: points[i].y + (points[i + 1].y - points[i].y) * u,
        };
      }
      target -= lens[i];
    }
    return { ...points.at(-1) };
  }

  function simplifyCorridors(model) {
    const pos = new Map([...model.geo].map(([id, p]) => [id, { ...p }]));
    const transferNodes = new Set();
    for (const key of model.transferPairs) for (const id of key.split('|')) transferNodes.add(id);

    const anchors = new Set();
    for (const id of pos.keys()) {
      const degree = model.adjacency.get(id)?.length || 0;
      if (degree !== 2 || model.routeEndpoints.has(id) || transferNodes.has(id)) anchors.add(id);
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
          current = next;
          edge = options[0];
        }
        if (chain.length < 3) continue;
        const a = pos.get(chain[0]), b = pos.get(chain.at(-1));
        if (!a || !b) continue;
        const spine = octilinearPoints(a, b);
        for (let i = 1; i < chain.length - 1; i++) {
          pos.set(chain[i], pointAlongPolyline(spine, i / (chain.length - 1)));
        }
      }
    }

    const byName = new Map([...model.stationMeta.values()].map(s => [norm(s.name), s.id]));

    const rogNames = ['Rogowska Centrum Miejskie', 'Witkowskiego', 'Rogowska/Dąbka', 'Rogowska'];
    const rog = rogNames.map(n => byName.get(norm(n))).filter(id => id && pos.has(id));
    if (rog.length >= 3) {
      const firstId = rog[0], lastId = rog.at(-1);
      const first = { ...pos.get(firstId) };
      const rawFirst = model.geo.get(firstId), rawLast = model.geo.get(lastId);
      const sx = Math.sign((rawLast?.x ?? first.x + 1) - (rawFirst?.x ?? first.x)) || 1;
      const sy = Math.sign((rawLast?.y ?? first.y + 1) - (rawFirst?.y ?? first.y)) || 1;
      const inv = 1 / Math.sqrt(2);
      let cursor = 0;
      pos.set(firstId, first);
      for (let i = 1; i < rog.length; i++) {
        const ar = model.geo.get(rog[i - 1]), br = model.geo.get(rog[i]);
        cursor += clamp(ar && br ? dist(ar, br) : CFG.targetSpacing, CFG.targetSpacing * 0.72, CFG.targetSpacing * 1.35);
        pos.set(rog[i], { x: first.x + sx * inv * cursor, y: first.y + sy * inv * cursor });
      }
    }

    const centralny = byName.get(norm('Folityn Centralny'));
    const larcho = byName.get(norm('Rondo Larcho'));
    const rcm = byName.get(norm('Rogowska Centrum Miejskie'));
    if (centralny && larcho && rcm && pos.has(centralny) && pos.has(larcho) && pos.has(rcm)) {
      const base = pos.get(centralny);
      const old = new Map([
        [centralny, { ...pos.get(centralny) }],
        [larcho, { ...pos.get(larcho) }],
        [rcm, { ...pos.get(rcm) }],
      ]);
      const target = new Map([
        [centralny, { x: base.x, y: base.y - CFG.centerDy * 0.55 }],
        [larcho, { x: base.x - CFG.centerDx, y: base.y + CFG.centerDy * 0.45 }],
        [rcm, { x: base.x + CFG.centerDx, y: base.y + CFG.centerDy * 0.45 }],
      ]);
      for (const [id, p] of target) pos.set(id, p);
      for (const hub of [centralny, larcho, rcm]) {
        const before = old.get(hub), after = target.get(hub);
        const dx = after.x - before.x, dy = after.y - before.y;
        for (const edge of model.adjacency.get(hub) || []) {
          const other = edge.a === hub ? edge.b : edge.a;
          if ([centralny, larcho, rcm].includes(other) || !pos.has(other)) continue;
          const p = pos.get(other);
          pos.set(other, { x: p.x + dx * 0.42, y: p.y + dy * 0.42 });
        }
      }
    }

    return pos;
  }

  function roundedPath(points, radius = CFG.cornerRadius) {
    if (points.length < 2) return '';
    if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1], cur = points[i], next = points[i + 1];
      const l1 = dist(prev, cur), l2 = dist(cur, next);
      const r = Math.min(radius, l1 * 0.38, l2 * 0.38);
      if (r < 0.5) {
        d += ` L ${cur.x} ${cur.y}`;
        continue;
      }
      const u1 = { x: (cur.x - prev.x) / l1, y: (cur.y - prev.y) / l1 };
      const u2 = { x: (next.x - cur.x) / l2, y: (next.y - cur.y) / l2 };
      const pIn = { x: cur.x - u1.x * r, y: cur.y - u1.y * r };
      const pOut = { x: cur.x + u2.x * r, y: cur.y + u2.y * r };
      d += ` L ${pIn.x} ${pIn.y} Q ${cur.x} ${cur.y} ${pOut.x} ${pOut.y}`;
    }
    return d + ` L ${points.at(-1).x} ${points.at(-1).y}`;
  }

  function visibleRouteIds(edge, model) {
    return [...edge.routes]
      .filter(id => state.visible.has(model.routeGroups.get(id)?.mode))
      .sort((a, b) => (model.routeRank.get(a) ?? 0) - (model.routeRank.get(b) ?? 0));
  }

  function edgeGeometry(edge, positions) {
    const a = positions.get(edge.a), b = positions.get(edge.b);
    return a && b ? octilinearPoints(a, b) : [];
  }

  function edgeLaneInfo(edge, routeId, model) {
    const shared = visibleRouteIds(edge, model);
    const index = shared.indexOf(routeId);
    if (index < 0) return null;
    return { offset: (index - (shared.length - 1) / 2) * CFG.laneGap };
  }

  function offsetEdge(points, offset) {
    if (points.length < 2 || Math.abs(offset) < 0.001) return points.map(p => ({ ...p }));
    const out = [];
    for (let i = 0; i < points.length; i++) {
      let dx, dy;
      if (i === points.length - 1) {
        dx = points[i].x - points[i - 1].x;
        dy = points[i].y - points[i - 1].y;
      } else {
        dx = points[i + 1].x - points[i].x;
        dy = points[i + 1].y - points[i].y;
      }
      const len = Math.max(0.001, Math.hypot(dx, dy));
      const nx = -dy / len, ny = dx / len;
      out.push({ x: points[i].x + nx * offset, y: points[i].y + ny * offset });
    }
    return out;
  }

  function routePathData(group, model, positions) {
    const chunks = [];
    for (const key of group.edges) {
      const edge = model.edges.get(key);
      if (!edge) continue;
      const lane = edgeLaneInfo(edge, group.id, model);
      if (!lane) continue;
      const center = edgeGeometry(edge, positions);
      if (center.length < 2) continue;
      chunks.push(roundedPath(offsetEdge(center, lane.offset)));
    }
    return chunks.join(' ');
  }

  function stationTangentForGroup(nodeId, group, model, positions) {
    for (const key of group.edges) {
      const edge = model.edges.get(key);
      if (!edge || (edge.a !== nodeId && edge.b !== nodeId)) continue;
      const pts = edgeGeometry(edge, positions);
      if (pts.length < 2) continue;
      if (edge.a === nodeId) {
        return { dx: pts[1].x - pts[0].x, dy: pts[1].y - pts[0].y, edge };
      }
      const n = pts.length;
      return { dx: pts[n - 2].x - pts[n - 1].x, dy: pts[n - 2].y - pts[n - 1].y, edge };
    }
    return null;
  }

  function lanePointAtStation(nodeId, group, model, positions) {
    const p = positions.get(nodeId);
    const tangent = stationTangentForGroup(nodeId, group, model, positions);
    if (!p || !tangent) return null;
    const lane = edgeLaneInfo(tangent.edge, group.id, model);
    if (!lane) return null;
    const len = Math.max(0.001, Math.hypot(tangent.dx, tangent.dy));
    const nx = -tangent.dy / len, ny = tangent.dx / len;
    return {
      x: p.x + nx * lane.offset,
      y: p.y + ny * lane.offset,
      angle: Math.atan2(tangent.dy, tangent.dx) * 180 / Math.PI,
      nx, ny,
    };
  }

  function stopServiceKind(group, nodeId) {
    const dirs = group.stopOrientations.get(nodeId);
    if (!dirs || !dirs.size) return 'none';
    if (dirs.has(1) && dirs.has(-1)) return 'both';
    if (group.variants.length >= 2 && dirs.size === 1) return dirs.has(-1) ? 'minus' : 'plus';
    return 'both';
  }

  function drawRouteStop(layer, group, nodeId, bg, fg, model, positions) {
    const service = stopServiceKind(group, nodeId);
    if (service === 'none') return;
    const lp = lanePointAtStation(nodeId, group, model, positions);
    if (!lp) return;

    const full = service === 'both';
    const length = full ? CFG.stopLength : CFG.stopLength * 0.62;
    const side = service === 'minus' ? -1 : 1;
    const cx = full ? lp.x : lp.x + lp.nx * side * CFG.stopLength * 0.24;
    const cy = full ? lp.y : lp.y + lp.ny * side * CFG.stopLength * 0.24;

    layer.appendChild(svgEl('rect', {
      x: cx - CFG.stopWidth / 2,
      y: cy - length / 2,
      width: CFG.stopWidth,
      height: length,
      rx: CFG.stopWidth / 2,
      ry: CFG.stopWidth / 2,
      fill: bg,
      stroke: fg,
      'stroke-width': 1.6,
      'vector-effect': 'non-scaling-stroke',
      transform: `rotate(${lp.angle} ${cx} ${cy})`,
    }));
  }

  function drawCentralComplex(layer, bg, fg) {
    const byName = new Map([...state.model.stationMeta.values()].map(s => [norm(s.name), s.id]));
    const c = state.positions.get(byName.get(norm('Folityn Centralny')));
    const l = state.positions.get(byName.get(norm('Rondo Larcho')));
    const r = state.positions.get(byName.get(norm('Rogowska Centrum Miejskie')));
    if (!c || !l || !r) return;
    layer.appendChild(svgEl('polygon', {
      points: `${c.x},${c.y} ${r.x},${r.y} ${l.x},${l.y}`,
      fill: bg,
      'fill-opacity': 0.88,
      stroke: fg,
      'stroke-opacity': 0.38,
      'stroke-width': 1.35,
      'stroke-dasharray': '5 5',
      'vector-effect': 'non-scaling-stroke',
    }));
  }

  function setOriginalVisible(show) {
    if (!state.wrapper) return;
    const canvas = state.wrapper.querySelector('canvas');
    if (canvas) canvas.style.visibility = show ? '' : 'hidden';
    state.wrapper.querySelectorAll('.label').forEach(el => el.style.visibility = show ? '' : 'hidden');
    if (state.overlay) state.overlay.style.display = show ? 'none' : '';
  }

  function fitForPositions(positions) {
    const vals = [...positions.values()];
    const minX = Math.min(...vals.map(p => p.x)), maxX = Math.max(...vals.map(p => p.x));
    const minY = Math.min(...vals.map(p => p.y)), maxY = Math.max(...vals.map(p => p.y));
    return {
      x: minX - CFG.pad,
      y: minY - CFG.pad,
      w: Math.max(500, maxX - minX + CFG.pad * 2),
      h: Math.max(360, maxY - minY + CFG.pad * 2),
    };
  }

  function applyView() {
    if (state.svg && state.view) state.svg.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
  }

  function installPanZoom(svg) {
    svg.style.cursor = 'grab';
    svg.style.userSelect = 'none';
    const endDrag = () => { state.drag = null; svg.style.cursor = 'grab'; };

    svg.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      state.drag = { x: e.clientX, y: e.clientY, viewX: state.view.x, viewY: state.view.y };
      svg.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
    }, true);

    window.addEventListener('mousemove', e => {
      if (!state.drag || (e.buttons & 1) !== 1) {
        if (state.drag && (e.buttons & 1) !== 1) endDrag();
        return;
      }
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      state.view.x = state.drag.viewX - (e.clientX - state.drag.x) / rect.width * state.view.w;
      state.view.y = state.drag.viewY - (e.clientY - state.drag.y) / rect.height * state.view.h;
      applyView();
      e.preventDefault();
    }, true);

    window.addEventListener('mouseup', endDrag, true);
    window.addEventListener('blur', endDrag, true);

    svg.addEventListener('wheel', e => {
      e.preventDefault();
      e.stopPropagation();
      const rect = svg.getBoundingClientRect();
      const mx = state.view.x + (e.clientX - rect.left) / rect.width * state.view.w;
      const my = state.view.y + (e.clientY - rect.top) / rect.height * state.view.h;
      const factor = e.deltaY > 0 ? 1.12 : 0.89;
      state.view.x = mx + (state.view.x - mx) * factor;
      state.view.y = my + (state.view.y - my) * factor;
      state.view.w *= factor;
      state.view.h *= factor;
      applyView();
    }, { passive: false, capture: true });

    svg.addEventListener('dblclick', e => {
      e.preventDefault();
      state.view = { ...state.fitView };
      applyView();
    });
  }

  function draw() {
    if (!state.layers) return;
    const { complexLayer, routeLayer, transferLayer, stopLayer, stationLayer, labelLayer } = state.layers;
    for (const layer of [complexLayer, routeLayer, transferLayer, stopLayer, stationLayer, labelLayer]) layer.replaceChildren();

    const bg = state.dark ? '#101827' : '#f6f8fb';
    const fg = state.dark ? '#e6edf7' : '#172033';
    const halo = bg;
    const transferColor = state.dark ? '#aeb9c9' : '#455166';
    state.overlay.style.background = bg;

    drawCentralComplex(complexLayer, bg, fg);

    for (const group of state.model.groups) {
      if (!state.visible.has(group.mode)) continue;
      const d = routePathData(group, state.model, state.positions);
      if (!d) continue;
      routeLayer.appendChild(svgEl('path', {
        d,
        fill: 'none',
        stroke: colorHex(group.color),
        'stroke-width': CFG.lineWidth,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke',
        'data-mode': group.mode,
        'data-route': group.label,
      }));
    }

    if (state.transfers) {
      for (const key of state.model.transferPairs) {
        const [aId, bId] = key.split('|');
        const a = state.positions.get(aId), b = state.positions.get(bId);
        if (!a || !b) continue;
        transferLayer.appendChild(svgEl('path', {
          d: roundedPath(octilinearPoints(a, b), 10),
          fill: 'none',
          stroke: transferColor,
          'stroke-width': 2.1,
          'stroke-dasharray': '7 6',
          'vector-effect': 'non-scaling-stroke',
        }));
      }
    }

    const centralNames = new Set([
      norm('Folityn Centralny'),
      norm('Rondo Larcho'),
      norm('Rogowska Centrum Miejskie'),
    ]);

    for (const group of state.model.groups) {
      if (!state.visible.has(group.mode)) continue;
      for (const nodeId of group.nodes) {
        const meta = state.model.stationMeta.get(nodeId);
        const routeCount = [...(state.model.nodeRouteGroups.get(nodeId) || [])]
          .filter(rid => state.visible.has(state.model.routeGroups.get(rid)?.mode)).length;
        const degree = state.model.adjacency.get(nodeId)?.length || 0;
        const isCentral = centralNames.has(norm(meta?.name));
        const major = isCentral || routeCount >= 4 || degree >= 3;
        if (!major) drawRouteStop(stopLayer, group, nodeId, bg, fg, state.model, state.positions);
      }
    }

    for (const [id, p] of state.positions) {
      const routeIds = [...(state.model.nodeRouteGroups.get(id) || [])]
        .filter(rid => state.visible.has(state.model.routeGroups.get(rid)?.mode));
      if (!routeIds.length) continue;
      const meta = state.model.stationMeta.get(id);
      const count = routeIds.length;
      const degree = state.model.adjacency.get(id)?.length || 0;
      const isCentral = centralNames.has(norm(meta?.name));
      const major = isCentral || count >= 4 || degree >= 3;
      if (!major) continue;
      const r = isCentral ? 10.5 : 7 + Math.min(7, Math.log2(count + 1) * 1.6);
      stationLayer.appendChild(svgEl('rect', {
        x: p.x - r * 1.55,
        y: p.y - r,
        width: r * 3.1,
        height: r * 2,
        rx: r,
        ry: r,
        fill: bg,
        stroke: fg,
        'stroke-width': isCentral ? 2.8 : 2.2,
        'vector-effect': 'non-scaling-stroke',
      }));
    }

    for (const [id, p] of state.positions) {
      const routeIds = [...(state.model.nodeRouteGroups.get(id) || [])]
        .filter(rid => state.visible.has(state.model.routeGroups.get(rid)?.mode));
      if (!routeIds.length) continue;
      const meta = state.model.stationMeta.get(id);
      if (!meta?.name) continue;
      const degree = state.model.adjacency.get(id)?.length || 0;
      const isCentral = centralNames.has(norm(meta.name));
      const major = isCentral || routeIds.length >= 4 || degree >= 3;
      const show = state.labels === 'all' || (state.labels === 'key' && (major || routeIds.length >= 2));
      if (!show) continue;
      const text = svgEl('text', {
        x: p.x + (major ? 18 : 9),
        y: p.y - (major ? 12 : 7),
        fill: fg,
        'font-size': isCentral ? 12.5 : (major ? 11 : 9.5),
        'font-family': 'system-ui, sans-serif',
        'font-weight': isCentral ? 800 : (major ? 700 : 550),
        'paint-order': 'stroke',
        stroke: halo,
        'stroke-width': 3.8,
        'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke',
      });
      text.textContent = meta.name;
      labelLayer.appendChild(text);
    }
  }

  function button(text) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    Object.assign(b.style, {
      border: '1px solid #4b5563',
      borderRadius: '7px',
      padding: '6px 8px',
      background: '#1f2937',
      color: '#fff',
      cursor: 'pointer',
      font: 'inherit',
    });
    return b;
  }

  function modeCheckbox(label, mode) {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;min-height:26px;cursor:pointer';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.visible.has(mode);
    input.addEventListener('change', () => {
      input.checked ? state.visible.add(mode) : state.visible.delete(mode);
      localStorage.setItem(KEY + 'modes', JSON.stringify([...state.visible]));
      draw();
    });
    wrap.append(input, document.createTextNode(label));
    return wrap;
  }

  function installControls() {
    document.getElementById('folityn-v34-controls')?.remove();
    const panel = document.createElement('div');
    panel.id = 'folityn-v34-controls';
    Object.assign(panel.style, {
      position: 'fixed',
      left: '14px',
      bottom: '14px',
      zIndex: '1000000',
      width: '286px',
      padding: '11px',
      borderRadius: '11px',
      background: 'rgba(17,24,39,.97)',
      color: '#fff',
      boxShadow: '0 6px 22px rgba(0,0,0,.35)',
      font: '600 12px/1.35 system-ui,sans-serif',
    });

    const title = document.createElement('div');
    title.innerHTML = '<strong style="font-size:14px">Folityn schematic v3.4</strong><div style="opacity:.62;font-weight:500;margin-top:2px">Poznań-style: one route stroke · directional stops only</div>';

    const modes = document.createElement('div');
    modes.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin-top:9px';
    modes.append(
      modeCheckbox('Light Rail', 'light_rail'),
      modeCheckbox('Rail', 'rail'),
      modeCheckbox('High Speed', 'high_speed')
    );

    const opts = document.createElement('div');
    opts.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin-top:8px';

    const darkLabel = document.createElement('label');
    darkLabel.style.cssText = 'display:flex;gap:6px;align-items:center';
    const dark = document.createElement('input');
    dark.type = 'checkbox';
    dark.checked = state.dark;
    dark.addEventListener('change', () => {
      state.dark = dark.checked;
      localStorage.setItem(KEY + 'dark', state.dark ? '1' : '0');
      draw();
    });
    darkLabel.append(dark, document.createTextNode('Dark'));

    const transferLabel = document.createElement('label');
    transferLabel.style.cssText = 'display:flex;gap:6px;align-items:center';
    const transfers = document.createElement('input');
    transfers.type = 'checkbox';
    transfers.checked = state.transfers;
    transfers.addEventListener('change', () => {
      state.transfers = transfers.checked;
      localStorage.setItem(KEY + 'transfers', state.transfers ? '1' : '0');
      draw();
    });
    transferLabel.append(transfers, document.createTextNode('Transfers'));
    opts.append(darkLabel, transferLabel);

    const labels = document.createElement('select');
    labels.innerHTML = '<option value="key">Key labels</option><option value="all">All labels</option><option value="none">No labels</option>';
    labels.value = state.labels;
    Object.assign(labels.style, {
      width: '100%',
      marginTop: '8px',
      padding: '6px',
      borderRadius: '7px',
      border: '1px solid #4b5563',
      background: '#1f2937',
      color: '#fff',
    });
    labels.addEventListener('change', () => {
      state.labels = labels.value;
      localStorage.setItem(KEY + 'labels', state.labels);
      draw();
    });

    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 70px;gap:6px;margin-top:8px';
    const schematic = button('Schematic');
    const original = button('Original');
    const fit = button('Fit');
    schematic.addEventListener('click', () => {
      state.enabled = true;
      localStorage.setItem(KEY + 'enabled', '1');
      setOriginalVisible(false);
    });
    original.addEventListener('click', () => {
      state.enabled = false;
      localStorage.setItem(KEY + 'enabled', '0');
      setOriginalVisible(true);
    });
    fit.addEventListener('click', () => {
      state.view = { ...state.fitView };
      applyView();
    });
    row.append(schematic, original, fit);

    const note = document.createElement('div');
    note.style.cssText = 'opacity:.58;font-weight:500;font-size:10.5px;margin-top:7px';
    note.textContent = 'One public line = one map line · half stop = one direction only · hold left mouse to pan';

    panel.append(title, modes, opts, labels, row, note);
    document.body.appendChild(panel);
  }

  function createOverlay() {
    [
      'folityn-v3-overlay','folityn-v31-overlay','folityn-v32-overlay','folityn-v33-overlay','folityn-v34-overlay',
      'folityn-v3-controls','folityn-v31-controls','folityn-v32-controls','folityn-v33-controls','folityn-v34-controls'
    ].forEach(id => document.getElementById(id)?.remove());

    state.wrapper.style.position = 'relative';
    const overlay = document.createElement('div');
    overlay.id = 'folityn-v34-overlay';
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '30',
      overflow: 'hidden',
      pointerEvents: 'auto',
    });

    const svg = svgEl('svg', {
      width: '100%',
      height: '100%',
      preserveAspectRatio: 'xMidYMid meet',
    });
    svg.style.display = 'block';
    svg.style.pointerEvents = 'all';

    const complexLayer = svgEl('g');
    const routeLayer = svgEl('g');
    const transferLayer = svgEl('g');
    const stopLayer = svgEl('g');
    const stationLayer = svgEl('g');
    const labelLayer = svgEl('g');
    svg.append(complexLayer, routeLayer, transferLayer, stopLayer, stationLayer, labelLayer);
    overlay.appendChild(svg);
    state.wrapper.appendChild(overlay);

    state.overlay = overlay;
    state.svg = svg;
    state.layers = { complexLayer, routeLayer, transferLayer, stopLayer, stationLayer, labelLayer };
    state.fitView = fitForPositions(state.positions);
    state.view = { ...state.fitView };

    installPanZoom(svg);
    installControls();
    draw();
    setOriginalVisible(!state.enabled);
  }

  async function main() {
    try {
      const [wrapper, data] = await Promise.all([waitForMap(), loadNetwork()]);
      state.wrapper = wrapper;
      state.model = buildModel(data);
      state.positions = simplifyCorridors(state.model);
      createOverlay();
      console.log('[MTR Map Tools] Folityn schematic v3.4 loaded', {
        publicRoutes: state.model.groups.length,
        physicalEdges: state.model.edges.size,
        stations: state.positions.size,
        modes: [...new Set(state.model.groups.map(r => r.mode))],
      });
    } catch (error) {
      console.error('[MTR Map Tools] Folityn schematic v3.4 failed:', error);
    }
  }

  main();
})();