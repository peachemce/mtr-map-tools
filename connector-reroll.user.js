// ==UserScript==
// @name         MTR Map Tools - Schematic Network Layout
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      0.5.0
// @description  Re-layout the MTR system map as a schematic 0/45/90-degree transit diagram while preserving network topology.
// @match        http://localhost:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==

(() => {
  'use strict';

  const KEY_ENABLED = 'mtr-map-tools-schematic-enabled';
  const KEY_STRENGTH = 'mtr-map-tools-schematic-strength';
  const KEY_SPACING = 'mtr-map-tools-schematic-spacing';
  const KEY_SEED = 'mtr-map-tools-schematic-seed';
  const KEY_COMPACT = 'mtr-map-tools-schematic-compact';

  const enabled = localStorage.getItem(KEY_ENABLED) !== '0';
  const strength = clamp(Number(localStorage.getItem(KEY_STRENGTH) ?? '0.90'), 0, 1);
  const spacingUniformity = clamp(Number(localStorage.getItem(KEY_SPACING) ?? '0.72'), 0, 1);
  const seed = Math.max(1, Number(localStorage.getItem(KEY_SEED) ?? '1') | 0);
  const compactness = clamp(Number(localStorage.getItem(KEY_COMPACT) ?? '0.88'), 0.55, 1.1);

  const nativeParse = JSON.parse.bind(JSON);
  const nativeResponseJson = window.Response?.prototype?.json;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function hash32(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
  }

  function payloadOf(value) {
    const d = value?.data ?? value;
    return d && Array.isArray(d.routes) && Array.isArray(d.stations) ? d : null;
  }

  function looksLikeStationsAndRoutes(value) {
    const d = payloadOf(value);
    if (!d || d.routes.length === 0) return false;
    let checked = 0;
    for (const route of d.routes) {
      if (!Array.isArray(route?.stations) || route.stations.length < 2) continue;
      const s = route.stations[0];
      if (s && typeof s.id === 'string' && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.z))) checked++;
      if (checked >= 2) return true;
    }
    return checked > 0;
  }

  function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

  function median(values) {
    if (!values.length) return 1;
    const a = [...values].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function transformNetwork(value) {
    if (!enabled || !looksLikeStationsAndRoutes(value)) return value;
    const d = payloadOf(value);
    if (d.__mtrMapToolsSchematic) return value;

    const occurrences = new Map();
    const routeEdgeCounts = new Map();

    for (const route of d.routes) {
      if (route?.hidden || !Array.isArray(route?.stations) || route.stations.length < 2) continue;
      for (const stop of route.stations) {
        if (!stop?.id) continue;
        const x = Number(stop.x), z = Number(stop.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        if (!occurrences.has(stop.id)) occurrences.set(stop.id, []);
        occurrences.get(stop.id).push({ x, z });
      }
      for (let i = 1; i < route.stations.length; i++) {
        const a = route.stations[i - 1]?.id;
        const b = route.stations[i]?.id;
        if (!a || !b || a === b) continue;
        const key = pairKey(a, b);
        routeEdgeCounts.set(key, (routeEdgeCounts.get(key) || 0) + 1);
      }
    }

    if (occurrences.size < 2 || routeEdgeCounts.size < 1) return value;

    const original = new Map();
    for (const [id, list] of occurrences) {
      const sx = list.reduce((n, p) => n + p.x, 0) / list.length;
      const sz = list.reduce((n, p) => n + p.z, 0) / list.length;
      original.set(id, { x: sx, z: sz });
    }

    const edges = [];
    const degrees = new Map([...original.keys()].map(id => [id, 0]));
    const rawLengths = [];

    for (const [key, count] of routeEdgeCounts) {
      const [a, b] = key.split('|');
      if (!original.has(a) || !original.has(b)) continue;
      const pa = original.get(a), pb = original.get(b);
      const dx = pb.x - pa.x, dz = pb.z - pa.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      rawLengths.push(len);
      degrees.set(a, (degrees.get(a) || 0) + 1);
      degrees.set(b, (degrees.get(b) || 0) + 1);
      edges.push({ a, b, count, dx, dz, len });
    }

    if (!edges.length) return value;

    const medianLength = median(rawLengths);
    const snapStep = Math.PI / 4;

    for (const e of edges) {
      const angle = Math.atan2(e.dz, e.dx);
      const scaled = angle / snapStep;
      const lower = Math.floor(scaled);
      const frac = scaled - lower;
      let snappedIndex = Math.round(scaled);
      if (Math.abs(frac - 0.5) < 0.16) {
        const h = hash32(`${e.a}|${e.b}|${seed}`);
        snappedIndex = (h & 1) ? lower : lower + 1;
      }
      e.angle = snappedIndex * snapStep;

      const geoBlend = Math.exp(
        lerp(Math.log(Math.max(1, e.len)), Math.log(Math.max(1, medianLength)), spacingUniformity)
      );
      e.targetLength = clamp(geoBlend, medianLength * 0.55, medianLength * 2.25);
      e.vx = Math.cos(e.angle) * e.targetLength;
      e.vz = Math.sin(e.angle) * e.targetLength;
    }

    const pos = new Map();
    for (const [id, p] of original) pos.set(id, { x: p.x, z: p.z });

    let anchorId = null;
    let anchorDegree = -1;
    for (const [id, degree] of degrees) {
      if (degree > anchorDegree) { anchorDegree = degree; anchorId = id; }
    }
    const anchorOriginal = anchorId ? original.get(anchorId) : null;

    const iterations = 180;
    const ids = [...pos.keys()];
    const minSep = medianLength * 0.34;

    for (let iter = 0; iter < iterations; iter++) {
      const t = iter / Math.max(1, iterations - 1);
      const step = lerp(0.24, 0.08, t);

      for (const e of edges) {
        const a = pos.get(e.a), b = pos.get(e.b);
        const errX = (b.x - a.x) - e.vx;
        const errZ = (b.z - a.z) - e.vz;
        const w = Math.min(1.8, 0.8 + Math.log2(1 + e.count) * 0.28);
        const cx = errX * step * 0.5 * w;
        const cz = errZ * step * 0.5 * w;
        if (e.a !== anchorId) { a.x += cx; a.z += cz; }
        if (e.b !== anchorId) { b.x -= cx; b.z -= cz; }
      }

      const geographyPull = (1 - strength) * 0.045;
      if (geographyPull > 0) {
        for (const id of ids) {
          if (id === anchorId) continue;
          const p = pos.get(id), o = original.get(id);
          p.x += (o.x - p.x) * geographyPull;
          p.z += (o.z - p.z) * geographyPull;
        }
      }

      if (iter % 5 === 0 && ids.length <= 650) {
        for (let i = 0; i < ids.length; i++) {
          const idA = ids[i], a = pos.get(idA);
          for (let j = i + 1; j < ids.length; j++) {
            const idB = ids[j], b = pos.get(idB);
            let dx = b.x - a.x, dz = b.z - a.z;
            let dist = Math.hypot(dx, dz);
            if (dist >= minSep) continue;
            if (dist < 1e-6) {
              const h = hash32(`${idA}|${idB}`);
              dx = (h & 1) ? 1 : -1;
              dz = (h & 2) ? 1 : -1;
              dist = Math.SQRT2;
            }
            const push = (minSep - dist) * 0.08;
            const ux = dx / dist, uz = dz / dist;
            if (idA !== anchorId) { a.x -= ux * push; a.z -= uz * push; }
            if (idB !== anchorId) { b.x += ux * push; b.z += uz * push; }
          }
        }
      }

      if (anchorId && anchorOriginal) {
        const a = pos.get(anchorId);
        a.x = anchorOriginal.x;
        a.z = anchorOriginal.z;
      }
    }

    const blended = new Map();
    for (const id of ids) {
      const o = original.get(id), p = pos.get(id);
      blended.set(id, {
        x: lerp(o.x, p.x, strength),
        z: lerp(o.z, p.z, strength),
      });
    }

    function bbox(map) {
      const values = [...map.values()];
      return {
        minX: Math.min(...values.map(p => p.x)), maxX: Math.max(...values.map(p => p.x)),
        minZ: Math.min(...values.map(p => p.z)), maxZ: Math.max(...values.map(p => p.z)),
      };
    }
    const bo = bbox(original), bn = bbox(blended);
    const spanO = Math.max(1, Math.hypot(bo.maxX - bo.minX, bo.maxZ - bo.minZ));
    const spanN = Math.max(1, Math.hypot(bn.maxX - bn.minX, bn.maxZ - bn.minZ));
    const scale = (spanO / spanN) * compactness;
    const cxO = (bo.minX + bo.maxX) / 2, czO = (bo.minZ + bo.maxZ) / 2;
    const cxN = (bn.minX + bn.maxX) / 2, czN = (bn.minZ + bn.maxZ) / 2;

    for (const p of blended.values()) {
      p.x = cxO + (p.x - cxN) * scale;
      p.z = czO + (p.z - czN) * scale;
    }

    for (const route of d.routes) {
      if (!Array.isArray(route?.stations)) continue;
      for (const stop of route.stations) {
        const p = blended.get(stop?.id);
        if (!p) continue;
        stop.x = p.x;
        stop.z = p.z;
      }
    }

    try {
      Object.defineProperty(d, '__mtrMapToolsSchematic', { value: true, enumerable: false });
    } catch (_) {
      d.__mtrMapToolsSchematic = true;
    }
    window.__mtrMapToolsSchematicApplied = true;
    console.log('[MTR Map Tools] schematic layout applied', {
      stations: original.size,
      edges: edges.length,
      strength,
      spacingUniformity,
      seed,
      compactness,
    });
    return value;
  }

  JSON.parse = function (text, reviver) {
    const value = nativeParse(text, reviver);
    try { return transformNetwork(value); } catch (error) {
      console.error('[MTR Map Tools] schematic transform failed:', error);
      return value;
    }
  };

  if (nativeResponseJson) {
    Response.prototype.json = async function (...args) {
      const value = await nativeResponseJson.apply(this, args);
      try { return transformNetwork(value); } catch (error) {
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

  function addControls() {
    if (!document.body || document.getElementById('mtr-schematic-controls')) return;
    const panel = document.createElement('div');
    panel.id = 'mtr-schematic-controls';
    Object.assign(panel.style, {
      position: 'fixed', left: '14px', bottom: '14px', zIndex: '1000000', width: '318px',
      padding: '11px', borderRadius: '11px', background: 'rgba(17,24,39,.96)', color: '#fff',
      font: '600 12px/1.3 system-ui,sans-serif', boxShadow: '0 5px 20px rgba(0,0,0,.3)',
      userSelect: 'none',
    });

    const title = document.createElement('div');
    title.innerHTML = `<strong style="font-size:14px">Schematic network</strong><div style="opacity:.65;font-weight:500;margin-top:2px">Poznań-style topology-first layout · ${enabled ? 'ON' : 'original'}</div>`;

    const strengthRow = sliderRow('Schematic', 0, 100, Math.round(strength * 100), '%');
    const spacingRow = sliderRow('Equal spacing', 0, 100, Math.round(spacingUniformity * 100), '%');
    const compactRow = sliderRow('Map size', 55, 110, Math.round(compactness * 100), '%');

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:9px';
    const apply = makeButton('Apply');
    const alternate = makeButton('Alternate layout');
    const originalBtn = makeButton('Original');
    buttons.append(apply, alternate, originalBtn);

    const presets = document.createElement('div');
    presets.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px';
    const poznan = makeButton('Poznań preset');
    const balanced = makeButton('Balanced');
    presets.append(poznan, balanced);

    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:8px;opacity:.60;font-size:11px;font-weight:500';
    hint.textContent = 'Repositions stations before MTR draws them. Route order/topology is unchanged; corridors are simplified to 0°/45°/90° directions.';

    function saveAndReload(on = true, newSeed = seed) {
      localStorage.setItem(KEY_ENABLED, on ? '1' : '0');
      localStorage.setItem(KEY_STRENGTH, String(Number(strengthRow.input.value) / 100));
      localStorage.setItem(KEY_SPACING, String(Number(spacingRow.input.value) / 100));
      localStorage.setItem(KEY_COMPACT, String(Number(compactRow.input.value) / 100));
      localStorage.setItem(KEY_SEED, String(newSeed));
      location.reload();
    }

    apply.onclick = () => saveAndReload(true, seed);
    alternate.onclick = () => saveAndReload(true, seed + 1);
    originalBtn.onclick = () => saveAndReload(false, seed);
    poznan.onclick = () => {
      strengthRow.input.value = '94'; strengthRow.update();
      spacingRow.input.value = '82'; spacingRow.update();
      compactRow.input.value = '86'; compactRow.update();
      saveAndReload(true, seed);
    };
    balanced.onclick = () => {
      strengthRow.input.value = '78'; strengthRow.update();
      spacingRow.input.value = '58'; spacingRow.update();
      compactRow.input.value = '92'; compactRow.update();
      saveAndReload(true, seed);
    };

    panel.append(title, strengthRow.row, spacingRow.row, compactRow.row, buttons, presets, hint);
    document.body.appendChild(panel);
  }

  function sliderRow(label, min, max, value, suffix) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:82px 1fr 44px;align-items:center;gap:7px;margin-top:8px';
    const l = document.createElement('span'); l.textContent = label;
    const input = document.createElement('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = '1'; input.value = String(value);
    const out = document.createElement('span'); out.style.textAlign = 'right';
    const update = () => { out.textContent = `${input.value}${suffix}`; };
    input.oninput = update; update();
    row.append(l, input, out);
    return { row, input, out, update };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addControls, { once: true });
  else addControls();
})();
