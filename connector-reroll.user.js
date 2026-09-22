// ==UserScript==
// @name         MTR Map Tools - Topology-Safe Schematic Layout
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      0.6.0
// @description  Deterministic topology-preserving octilinear layout for the MTR web map.
// @match        http://localhost:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==

(() => {
  'use strict';

  // v2 keys intentionally ignore the experimental v0.5 settings.
  const KEY_ENABLED = 'mtr-map-tools-schematic-v2-enabled';
  const KEY_STRENGTH = 'mtr-map-tools-schematic-v2-strength';
  const KEY_SPACING = 'mtr-map-tools-schematic-v2-spacing';
  const KEY_STRAIGHT = 'mtr-map-tools-schematic-v2-straightening';
  const KEY_SCALE = 'mtr-map-tools-schematic-v2-scale';

  const enabled = localStorage.getItem(KEY_ENABLED) === '1';
  const strength = clamp(Number(localStorage.getItem(KEY_STRENGTH) ?? '0.72'), 0, 1);
  const spacingUniformity = clamp(Number(localStorage.getItem(KEY_SPACING) ?? '0.65'), 0, 1);
  const straightening = clamp(Number(localStorage.getItem(KEY_STRAIGHT) ?? '0.55'), 0, 1);
  const mapScale = clamp(Number(localStorage.getItem(KEY_SCALE) ?? '0.90'), 0.6, 1.25);

  const nativeParse = JSON.parse.bind(JSON);
  const nativeResponseJson = window.Response?.prototype?.json;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

  function median(values) {
    if (!values.length) return 1;
    const a = [...values].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function payloadOf(value) {
    const d = value?.data ?? value;
    return d && Array.isArray(d.routes) && Array.isArray(d.stations) ? d : null;
  }

  function looksLikeStationsAndRoutes(value) {
    const d = payloadOf(value);
    if (!d || !d.routes.length) return false;
    return d.routes.some(route => Array.isArray(route?.stations) && route.stations.length > 1 &&
      route.stations.some(stop => stop?.id && Number.isFinite(Number(stop.x)) && Number.isFinite(Number(stop.z))));
  }

  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  }

  function snapAngle(angle) {
    const step = Math.PI / 4;
    return Math.round(angle / step) * step;
  }

  function targetLength(rawLength, medianLength) {
    const safeRaw = Math.max(1, rawLength);
    const safeMedian = Math.max(1, medianLength);
    const blended = Math.exp(lerp(Math.log(safeRaw), Math.log(safeMedian), spacingUniformity));
    return clamp(blended, safeMedian * 0.48, safeMedian * 2.0) * mapScale;
  }

  function transformNetwork(value) {
    if (!enabled || !looksLikeStationsAndRoutes(value)) return value;
    const d = payloadOf(value);
    if (d.__mtrMapToolsSchematicV2) return value;

    // 1) One global original position per station, shared by ALL transport modes/routes.
    const occurrences = new Map();
    for (const route of d.routes) {
      if (!Array.isArray(route?.stations)) continue;
      for (const stop of route.stations) {
        if (!stop?.id) continue;
        const x = Number(stop.x), z = Number(stop.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        if (!occurrences.has(stop.id)) occurrences.set(stop.id, []);
        occurrences.get(stop.id).push({ x, z });
      }
    }

    const original = new Map();
    for (const [id, pts] of occurrences) {
      if (!pts.length) continue;
      original.set(id, {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
      });
    }
    if (original.size < 2) return value;

    // 2) Build route edges across every mode, and collect corridor-direction proposals.
    const routeEdges = new Map();
    const rawRouteLengths = [];

    function ensureRouteEdge(idA, idB) {
      const key = pairKey(idA, idB);
      let edge = routeEdges.get(key);
      if (!edge) {
        const a = idA < idB ? idA : idB;
        const b = idA < idB ? idB : idA;
        const pa = original.get(a), pb = original.get(b);
        if (!pa || !pb) return null;
        const dx = pb.x - pa.x, dz = pb.z - pa.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) return null;
        edge = { key, a, b, len, rawAngle: Math.atan2(dz, dx), count: 0, angleVotes: new Map() };
        routeEdges.set(key, edge);
        rawRouteLengths.push(len);
      }
      return edge;
    }

    const corridorTolerance = lerp(15, 62, straightening) * Math.PI / 180;

    for (const route of d.routes) {
      if (route?.hidden || !Array.isArray(route?.stations) || route.stations.length < 2) continue;
      const stops = route.stations.filter(stop => stop?.id && original.has(stop.id));
      if (stops.length < 2) continue;

      const segments = [];
      for (let i = 1; i < stops.length; i++) {
        const s1 = stops[i - 1], s2 = stops[i];
        if (s1.id === s2.id) continue;
        const p1 = original.get(s1.id), p2 = original.get(s2.id);
        const dx = p2.x - p1.x, dz = p2.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        const edge = ensureRouteEdge(s1.id, s2.id);
        if (!edge) continue;
        edge.count++;
        segments.push({ from: s1.id, to: s2.id, angle: Math.atan2(dz, dx), edge });
      }
      if (!segments.length) continue;

      // Group gentle bends into one corridor so a route trunk becomes one clean axis.
      let start = 0;
      while (start < segments.length) {
        let end = start;
        let sumX = Math.cos(segments[start].angle);
        let sumY = Math.sin(segments[start].angle);
        let mean = Math.atan2(sumY, sumX);

        while (end + 1 < segments.length) {
          const next = segments[end + 1];
          if (segments[end].to !== next.from) break;
          if (angleDiff(next.angle, mean) > corridorTolerance) break;
          end++;
          sumX += Math.cos(next.angle);
          sumY += Math.sin(next.angle);
          mean = Math.atan2(sumY, sumX);
        }

        const first = segments[start];
        const last = segments[end];
        const pStart = original.get(first.from);
        const pEnd = original.get(last.to);
        const overall = Math.atan2(pEnd.z - pStart.z, pEnd.x - pStart.x);
        const corridorAngle = snapAngle(overall);

        for (let i = start; i <= end; i++) {
          const seg = segments[i];
          const edge = seg.edge;
          // Convert traversal direction to the edge's canonical a->b direction.
          let directedAngle = corridorAngle;
          if (seg.from !== edge.a) directedAngle += Math.PI;
          const idx = ((Math.round(directedAngle / (Math.PI / 4)) % 8) + 8) % 8;
          edge.angleVotes.set(idx, (edge.angleVotes.get(idx) || 0) + 1);
        }
        start = end + 1;
      }
    }

    if (!routeEdges.size) return value;
    const medianLength = median(rawRouteLengths);

    // 3) Add station/interchange connections. These were missing in v0.5 and caused splits.
    const transferEdges = new Map();
    for (const station of d.stations) {
      if (!station?.id || !original.has(station.id) || !Array.isArray(station.connections)) continue;
      for (const otherId of station.connections) {
        if (!original.has(otherId) || otherId === station.id) continue;
        const key = pairKey(station.id, otherId);
        if (routeEdges.has(key) || transferEdges.has(key)) continue;
        const a = station.id < otherId ? station.id : otherId;
        const b = station.id < otherId ? otherId : station.id;
        const pa = original.get(a), pb = original.get(b);
        const dx = pb.x - pa.x, dz = pb.z - pa.z;
        let len = Math.hypot(dx, dz);
        let angle = Math.atan2(dz, dx);
        if (len < 1e-6) { len = medianLength * 0.18; angle = 0; }
        transferEdges.set(key, { key, a, b, len, angle });
      }
    }

    // 4) Turn voted route geometry into deterministic 0/45/90-degree constraints.
    const constraints = [];
    for (const edge of routeEdges.values()) {
      let bestIdx = null, bestVotes = -1;
      for (const [idx, votes] of edge.angleVotes) {
        if (votes > bestVotes || (votes === bestVotes && (bestIdx === null || idx < bestIdx))) {
          bestIdx = idx;
          bestVotes = votes;
        }
      }
      if (bestIdx === null) bestIdx = ((Math.round(edge.rawAngle / (Math.PI / 4)) % 8) + 8) % 8;
      const angle = bestIdx * Math.PI / 4;
      const len = targetLength(edge.len, medianLength);
      constraints.push({
        a: edge.a, b: edge.b,
        vx: Math.cos(angle) * len,
        vz: Math.sin(angle) * len,
        weight: 1 + Math.min(1.5, Math.log2(1 + edge.count) * 0.35),
        type: 'route',
      });
    }

    for (const edge of transferEdges.values()) {
      const angle = snapAngle(edge.angle);
      // Keep interchange links local instead of allowing giant dashed cross-map lines.
      const len = clamp(edge.len, medianLength * 0.10, medianLength * 0.45) * mapScale;
      constraints.push({
        a: edge.a, b: edge.b,
        vx: Math.cos(angle) * len,
        vz: Math.sin(angle) * len,
        weight: 2.8,
        type: 'transfer',
      });
    }

    // 5) Combined graph = route edges + transfer edges. Find connected components and pin each one.
    const neighbors = new Map([...original.keys()].map(id => [id, new Set()]));
    for (const c of constraints) {
      neighbors.get(c.a)?.add(c.b);
      neighbors.get(c.b)?.add(c.a);
    }

    const components = [];
    const seen = new Set();
    for (const id of original.keys()) {
      if (seen.has(id)) continue;
      const stack = [id], ids = [];
      seen.add(id);
      while (stack.length) {
        const cur = stack.pop();
        ids.push(cur);
        for (const n of neighbors.get(cur) || []) {
          if (!seen.has(n)) { seen.add(n); stack.push(n); }
        }
      }
      components.push(ids);
    }

    const anchors = new Set();
    components.forEach(ids => {
      let anchor = ids[0], bestDegree = -1;
      for (const id of ids) {
        const degree = neighbors.get(id)?.size || 0;
        if (degree > bestDegree) { bestDegree = degree; anchor = id; }
      }
      anchors.add(anchor);
    });

    const pos = new Map([...original].map(([id, p]) => [id, { x: p.x, z: p.z }]));
    const iterations = 260;

    for (let iter = 0; iter < iterations; iter++) {
      const t = iter / (iterations - 1);
      const baseStep = lerp(0.18, 0.045, t);

      for (const c of constraints) {
        const a = pos.get(c.a), b = pos.get(c.b);
        if (!a || !b) continue;
        const errX = (b.x - a.x) - c.vx;
        const errZ = (b.z - a.z) - c.vz;
        const gain = baseStep * clamp(c.weight, 0.8, 2.8) / 2.8;
        const mx = errX * gain * 0.5;
        const mz = errZ * gain * 0.5;
        if (!anchors.has(c.a)) { a.x += mx; a.z += mz; }
        if (!anchors.has(c.b)) { b.x -= mx; b.z -= mz; }
      }

      // Mild geographic memory: enough to preserve north/east ordering, not enough to block schematization.
      const geographyPull = (1 - strength) * 0.018;
      if (geographyPull > 0) {
        for (const [id, p] of pos) {
          if (anchors.has(id)) continue;
          const o = original.get(id);
          p.x += (o.x - p.x) * geographyPull;
          p.z += (o.z - p.z) * geographyPull;
        }
      }

      // Keep every component anchor exactly at its original station.
      for (const anchor of anchors) {
        const p = pos.get(anchor), o = original.get(anchor);
        p.x = o.x; p.z = o.z;
      }
    }

    // 6) Recenter EACH connected component on its original centroid. No random islands/drift.
    components.forEach(ids => {
      if (!ids.length) return;
      let ox = 0, oz = 0, nx = 0, nz = 0;
      for (const id of ids) {
        const o = original.get(id), p = pos.get(id);
        ox += o.x; oz += o.z; nx += p.x; nz += p.z;
      }
      ox /= ids.length; oz /= ids.length; nx /= ids.length; nz /= ids.length;
      const dx = ox - nx, dz = oz - nz;
      for (const id of ids) {
        const p = pos.get(id);
        p.x += dx; p.z += dz;
      }
    });

    // 7) Final blend keeps the result readable but recognisably related to geography.
    const finalPos = new Map();
    for (const [id, o] of original) {
      const p = pos.get(id) || o;
      finalPos.set(id, { x: lerp(o.x, p.x, strength), z: lerp(o.z, p.z, strength) });
    }

    // Write the SAME position to every occurrence of each station in every route/mode.
    for (const route of d.routes) {
      if (!Array.isArray(route?.stations)) continue;
      for (const stop of route.stations) {
        const p = finalPos.get(stop?.id);
        if (!p) continue;
        stop.x = p.x;
        stop.z = p.z;
      }
    }

    try {
      Object.defineProperty(d, '__mtrMapToolsSchematicV2', { value: true, enumerable: false });
    } catch (_) {
      d.__mtrMapToolsSchematicV2 = true;
    }

    console.log('[MTR Map Tools] topology-safe schematic applied', {
      stations: original.size,
      routeEdges: routeEdges.size,
      transferEdges: transferEdges.size,
      components: components.length,
      strength,
      spacingUniformity,
      straightening,
      mapScale,
    });
    return value;
  }

  JSON.parse = function (text, reviver) {
    const value = nativeParse(text, reviver);
    try { return transformNetwork(value); }
    catch (error) {
      console.error('[MTR Map Tools] schematic transform failed:', error);
      return value;
    }
  };

  if (nativeResponseJson) {
    Response.prototype.json = async function (...args) {
      const value = await nativeResponseJson.apply(this, args);
      try { return transformNetwork(value); }
      catch (error) {
        console.error('[MTR Map Tools] fetch schematic transform failed:', error);
        return value;
      }
    };
  }

  function makeButton(text) {
    const b = document.createElement('button');
    b.textContent = text;
    Object.assign(b.style, {
      border: '1px solid #4b5563', borderRadius: '7px', padding: '6px 8px',
      background: '#1f2937', color: '#fff', cursor: 'pointer', font: 'inherit',
    });
    return b;
  }

  function sliderRow(label, min, max, value) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:92px 1fr 44px;gap:7px;align-items:center;margin-top:7px';
    const lab = document.createElement('span'); lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = '1'; input.value = String(value);
    const out = document.createElement('span'); out.style.textAlign = 'right'; out.textContent = `${value}%`;
    input.oninput = () => out.textContent = `${input.value}%`;
    row.append(lab, input, out);
    return { row, input };
  }

  function saveAndReload(values, turnOn) {
    localStorage.setItem(KEY_STRENGTH, String(values.strength));
    localStorage.setItem(KEY_SPACING, String(values.spacing));
    localStorage.setItem(KEY_STRAIGHT, String(values.straight));
    localStorage.setItem(KEY_SCALE, String(values.scale));
    localStorage.setItem(KEY_ENABLED, turnOn ? '1' : '0');
    location.reload();
  }

  function addControls() {
    if (!document.body || document.getElementById('mtr-schematic-v2-controls')) return;
    const panel = document.createElement('div');
    panel.id = 'mtr-schematic-v2-controls';
    Object.assign(panel.style, {
      position: 'fixed', left: '14px', bottom: '14px', zIndex: '1000000', width: '330px',
      padding: '11px', borderRadius: '11px', background: 'rgba(17,24,39,.96)', color: '#fff',
      font: '600 12px/1.3 system-ui,sans-serif', boxShadow: '0 5px 20px rgba(0,0,0,.3)', userSelect: 'none',
    });

    const title = document.createElement('div');
    title.innerHTML = `<strong style="font-size:14px">Topology-safe schematic</strong><div style="opacity:.65;font-weight:500;margin-top:2px">All modes share one station layout · ${enabled ? 'ON' : 'original'}</div>`;

    const strengthRow = sliderRow('Schematic', 0, 100, Math.round(strength * 100));
    const spacingRow = sliderRow('Equal spacing', 0, 100, Math.round(spacingUniformity * 100));
    const straightRow = sliderRow('Straighten', 0, 100, Math.round(straightening * 100));
    const scaleRow = sliderRow('Line length', 60, 125, Math.round(mapScale * 100));

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:10px';
    const apply = makeButton('Apply');
    const preset = makeButton('Poznań-like');
    const originalBtn = makeButton('Original');
    buttons.append(apply, preset, originalBtn);

    const gentle = makeButton('Gentle schematic');
    gentle.style.width = '100%';
    gentle.style.marginTop = '6px';

    const note = document.createElement('div');
    note.style.cssText = 'opacity:.60;font-size:11px;font-weight:500;margin-top:8px';
    note.textContent = 'Deterministic: no random layouts. Interchange/station links are part of the graph, so connected pieces stay together.';

    apply.onclick = () => saveAndReload({
      strength: Number(strengthRow.input.value) / 100,
      spacing: Number(spacingRow.input.value) / 100,
      straight: Number(straightRow.input.value) / 100,
      scale: Number(scaleRow.input.value) / 100,
    }, true);

    preset.onclick = () => saveAndReload({ strength: 0.78, spacing: 0.70, straight: 0.62, scale: 0.90 }, true);
    gentle.onclick = () => saveAndReload({ strength: 0.50, spacing: 0.42, straight: 0.38, scale: 0.96 }, true);
    originalBtn.onclick = () => { localStorage.setItem(KEY_ENABLED, '0'); location.reload(); };

    panel.append(title, strengthRow.row, spacingRow.row, straightRow.row, scaleRow.row, buttons, gentle, note);
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addControls, { once: true });
  } else {
    addControls();
  }
})();
