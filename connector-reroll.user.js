// ==UserScript==
// @name         MTR Map Tools - Global Schematic Layout
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      0.8.0
// @description  Global topology-preserving schematic layout with hard corridor constraints for the MTR web map.
// @match        http://localhost:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==

(() => {
  'use strict';

  const KEY_ENABLED = 'mtr-map-tools-global-schematic-enabled';
  const KEY_STRENGTH = 'mtr-map-tools-global-schematic-strength';
  const KEY_SPACING = 'mtr-map-tools-global-schematic-spacing';
  const KEY_SCALE = 'mtr-map-tools-global-schematic-scale';
  const KEY_ROGOWSKA = 'mtr-map-tools-global-rogowska-lock';

  const enabled = localStorage.getItem(KEY_ENABLED) === '1';
  const strength = clamp(Number(localStorage.getItem(KEY_STRENGTH) ?? '0.82'), 0, 1);
  const spacingUniformity = clamp(Number(localStorage.getItem(KEY_SPACING) ?? '0.68'), 0, 1);
  const mapScale = clamp(Number(localStorage.getItem(KEY_SCALE) ?? '0.92'), 0.55, 1.35);
  const rogowskaLock = localStorage.getItem(KEY_ROGOWSKA) !== '0';

  const nativeParse = JSON.parse.bind(JSON);
  const nativeResponseJson = window.Response?.prototype?.json;

  const IDS = {
    cm: '6F672E3D1720B426',
    witkowskiego: '62772A81FDB4C4EE',
    dabka: '48FB32622C692EA6',
    rogowska: 'FE2C8F860C7EC732',
    grochowa: '4B43818A1376929F',
  };

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
    return !!d && d.routes.some(route =>
      Array.isArray(route?.stations) && route.stations.length > 1 &&
      route.stations.some(stop => stop?.id && Number.isFinite(Number(stop.x)) && Number.isFinite(Number(stop.z)))
    );
  }

  function snapAngle(angle) {
    const step = Math.PI / 4;
    return Math.round(angle / step) * step;
  }

  function targetLength(rawLength, med) {
    const safeRaw = Math.max(1, rawLength);
    const safeMed = Math.max(1, med);
    const mixed = Math.exp(lerp(Math.log(safeRaw), Math.log(safeMed), spacingUniformity));
    return clamp(mixed, safeMed * 0.50, safeMed * 1.85) * mapScale;
  }

  function transformNetwork(value) {
    if (!enabled || !looksLikeStationsAndRoutes(value)) return value;
    const d = payloadOf(value);
    if (d.__mtrMapToolsGlobalSchematic) return value;

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

    const routeEdges = new Map();
    const rawLengths = [];

    for (const route of d.routes) {
      if (route?.hidden || !Array.isArray(route?.stations) || route.stations.length < 2) continue;
      for (let i = 1; i < route.stations.length; i++) {
        const s1 = route.stations[i - 1];
        const s2 = route.stations[i];
        if (!s1?.id || !s2?.id || s1.id === s2.id) continue;
        const p1 = original.get(s1.id), p2 = original.get(s2.id);
        if (!p1 || !p2) continue;
        const dx = p2.x - p1.x, dz = p2.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;

        const key = pairKey(s1.id, s2.id);
        let edge = routeEdges.get(key);
        if (!edge) {
          const a = s1.id < s2.id ? s1.id : s2.id;
          const b = s1.id < s2.id ? s2.id : s1.id;
          const pa = original.get(a), pb = original.get(b);
          const ex = pb.x - pa.x, ez = pb.z - pa.z;
          edge = {
            key, a, b,
            rawLength: Math.hypot(ex, ez),
            rawAngle: Math.atan2(ez, ex),
            count: 0,
          };
          routeEdges.set(key, edge);
          rawLengths.push(edge.rawLength);
        }
        edge.count++;
      }
    }

    if (!routeEdges.size) return value;
    const med = median(rawLengths);

    const constraints = [];
    const hardKeys = new Set();

    function addHardDirected(fromId, toId, angle) {
      if (!original.has(fromId) || !original.has(toId)) return;
      const edge = routeEdges.get(pairKey(fromId, toId));
      const rawLength = edge?.rawLength ?? med;
      const len = targetLength(rawLength, med);
      constraints.push({
        a: fromId,
        b: toId,
        vx: Math.cos(angle) * len,
        vz: Math.sin(angle) * len,
        hard: true,
        weight: 1,
      });
      hardKeys.add(pairKey(fromId, toId));
    }

    if (rogowskaLock) {
      addHardDirected(IDS.cm, IDS.witkowskiego, 0);
      addHardDirected(IDS.witkowskiego, IDS.dabka, 0);
      addHardDirected(IDS.dabka, IDS.rogowska, 0);
      addHardDirected(IDS.cm, IDS.grochowa, -Math.PI / 4);
    }

    for (const edge of routeEdges.values()) {
      if (hardKeys.has(edge.key)) continue;
      const angle = snapAngle(edge.rawAngle);
      const len = targetLength(edge.rawLength, med);
      constraints.push({
        a: edge.a,
        b: edge.b,
        vx: Math.cos(angle) * len,
        vz: Math.sin(angle) * len,
        hard: false,
        weight: 1 + Math.min(1.2, Math.log2(1 + edge.count) * 0.30),
      });
    }

    const transferKeys = new Set();
    for (const station of d.stations) {
      if (!station?.id || !original.has(station.id) || !Array.isArray(station.connections)) continue;
      for (const otherId of station.connections) {
        if (!original.has(otherId) || otherId === station.id) continue;
        const key = pairKey(station.id, otherId);
        if (routeEdges.has(key) || transferKeys.has(key)) continue;
        transferKeys.add(key);

        const a = station.id < otherId ? station.id : otherId;
        const b = station.id < otherId ? otherId : station.id;
        const pa = original.get(a), pb = original.get(b);
        const dx = pb.x - pa.x, dz = pb.z - pa.z;
        let len = Math.hypot(dx, dz);
        let angle = Math.atan2(dz, dx);
        if (len < 1e-6) { len = med * 0.18; angle = 0; }
        len = clamp(len, med * 0.10, med * 0.38) * mapScale;
        angle = snapAngle(angle);

        constraints.push({
          a, b,
          vx: Math.cos(angle) * len,
          vz: Math.sin(angle) * len,
          hard: false,
          weight: 2.2,
        });
      }
    }

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

    const anchorFor = new Map();
    for (const ids of components) {
      let anchor = ids[0];
      if (ids.includes(IDS.cm)) anchor = IDS.cm;
      else {
        let best = -1;
        for (const id of ids) {
          const deg = neighbors.get(id)?.size || 0;
          if (deg > best) { best = deg; anchor = id; }
        }
      }
      anchorFor.set(anchor, { ...original.get(anchor) });
    }
    const anchors = new Set(anchorFor.keys());

    const pos = new Map([...original].map(([id, p]) => [id, { ...p }]));
    const hardConstraints = constraints.filter(c => c.hard);
    const softConstraints = constraints.filter(c => !c.hard);
    const ids = [...pos.keys()];
    const minSep = med * 0.22 * mapScale;

    function projectHard(c) {
      const a = pos.get(c.a), b = pos.get(c.b);
      if (!a || !b) return;
      const tx = a.x + c.vx;
      const tz = a.z + c.vz;

      if (anchors.has(c.a)) {
        b.x = tx; b.z = tz;
      } else if (anchors.has(c.b)) {
        a.x = b.x - c.vx; a.z = b.z - c.vz;
      } else {
        const ex = b.x - tx;
        const ez = b.z - tz;
        a.x += ex * 0.5; a.z += ez * 0.5;
        b.x -= ex * 0.5; b.z -= ez * 0.5;
      }
    }

    const iterations = 420;
    for (let iter = 0; iter < iterations; iter++) {
      const t = iter / (iterations - 1);
      const step = lerp(0.16, 0.035, t);

      for (const c of softConstraints) {
        const a = pos.get(c.a), b = pos.get(c.b);
        if (!a || !b) continue;
        const errX = (b.x - a.x) - c.vx;
        const errZ = (b.z - a.z) - c.vz;
        const gain = step * clamp(c.weight, 0.8, 2.2) / 2.2;
        const mx = errX * gain * 0.5;
        const mz = errZ * gain * 0.5;
        if (!anchors.has(c.a)) { a.x += mx; a.z += mz; }
        if (!anchors.has(c.b)) { b.x -= mx; b.z -= mz; }
      }

      for (let pass = 0; pass < 3; pass++) {
        for (const c of hardConstraints) projectHard(c);
      }

      const geographyPull = (1 - strength) * 0.012;
      if (geographyPull > 0) {
        for (const [id, p] of pos) {
          if (anchors.has(id)) continue;
          const o = original.get(id);
          p.x += (o.x - p.x) * geographyPull;
          p.z += (o.z - p.z) * geographyPull;
        }
      }

      if (iter % 12 === 0 && ids.length <= 500) {
        for (let i = 0; i < ids.length; i++) {
          const idA = ids[i], a = pos.get(idA);
          for (let j = i + 1; j < ids.length; j++) {
            const idB = ids[j], b = pos.get(idB);
            let dx = b.x - a.x, dz = b.z - a.z;
            let dist = Math.hypot(dx, dz);
            if (dist >= minSep) continue;
            if (dist < 1e-5) { dx = 1; dz = 0; dist = 1; }
            const push = (minSep - dist) * 0.025;
            const ux = dx / dist, uz = dz / dist;
            if (!anchors.has(idA)) { a.x -= ux * push; a.z -= uz * push; }
            if (!anchors.has(idB)) { b.x += ux * push; b.z += uz * push; }
          }
        }
      }

      for (const [id, fixed] of anchorFor) {
        const p = pos.get(id);
        p.x = fixed.x; p.z = fixed.z;
      }
      for (let pass = 0; pass < 3; pass++) {
        for (const c of hardConstraints) projectHard(c);
      }
    }

    for (const component of components) {
      if (!component.length) continue;
      let ox = 0, oz = 0, nx = 0, nz = 0;
      for (const id of component) {
        const o = original.get(id), p = pos.get(id);
        ox += o.x; oz += o.z; nx += p.x; nz += p.z;
      }
      ox /= component.length; oz /= component.length;
      nx /= component.length; nz /= component.length;
      const dx = ox - nx, dz = oz - nz;
      for (const id of component) {
        const p = pos.get(id);
        p.x += dx; p.z += dz;
      }
    }

    for (const route of d.routes) {
      if (!Array.isArray(route?.stations)) continue;
      for (const stop of route.stations) {
        const p = pos.get(stop?.id);
        if (!p) continue;
        stop.x = p.x;
        stop.z = p.z;
      }
    }

    try {
      Object.defineProperty(d, '__mtrMapToolsGlobalSchematic', { value: true, enumerable: false });
    } catch (_) {
      d.__mtrMapToolsGlobalSchematic = true;
    }

    console.log('[MTR Map Tools] global schematic applied', {
      stations: original.size,
      routeEdges: routeEdges.size,
      transferEdges: transferKeys.size,
      components: components.length,
      hardConstraints: hardConstraints.length,
      strength,
      spacingUniformity,
      mapScale,
      rogowskaLock,
    });

    return value;
  }

  JSON.parse = function (text, reviver) {
    const value = nativeParse(text, reviver);
    try { return transformNetwork(value); }
    catch (error) {
      console.error('[MTR Map Tools] global schematic transform failed:', error);
      return value;
    }
  };

  if (nativeResponseJson) {
    Response.prototype.json = async function (...args) {
      const value = await nativeResponseJson.apply(this, args);
      try { return transformNetwork(value); }
      catch (error) {
        console.error('[MTR Map Tools] fetch transform failed:', error);
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

  function saveAndReload(values, turnOn = true) {
    localStorage.setItem(KEY_STRENGTH, String(values.strength));
    localStorage.setItem(KEY_SPACING, String(values.spacing));
    localStorage.setItem(KEY_SCALE, String(values.scale));
    localStorage.setItem(KEY_ROGOWSKA, values.rogowska ? '1' : '0');
    localStorage.setItem(KEY_ENABLED, turnOn ? '1' : '0');
    location.reload();
  }

  function addControls() {
    if (!document.body || document.getElementById('mtr-global-schematic-controls')) return;

    const panel = document.createElement('div');
    panel.id = 'mtr-global-schematic-controls';
    Object.assign(panel.style, {
      position: 'fixed', left: '14px', bottom: '14px', zIndex: '1000000', width: '330px',
      padding: '11px', borderRadius: '11px', background: 'rgba(17,24,39,.96)', color: '#fff',
      font: '600 12px/1.3 system-ui,sans-serif', boxShadow: '0 5px 20px rgba(0,0,0,.3)', userSelect: 'none',
    });

    const title = document.createElement('div');
    title.innerHTML = `<strong style="font-size:14px">Global schematic layout</strong><div style="opacity:.65;font-weight:500;margin-top:2px">Hard corridors reshape the whole connected network · ${enabled ? 'ON' : 'original'}</div>`;

    const strengthRow = sliderRow('Schematic', 0, 100, Math.round(strength * 100));
    const spacingRow = sliderRow('Equal spacing', 0, 100, Math.round(spacingUniformity * 100));
    const scaleRow = sliderRow('Line length', 55, 135, Math.round(mapScale * 100));

    const lockRow = document.createElement('label');
    lockRow.style.cssText = 'display:flex;align-items:flex-start;gap:7px;margin-top:9px;font-weight:500;cursor:pointer';
    const lock = document.createElement('input');
    lock.type = 'checkbox'; lock.checked = rogowskaLock;
    const lockText = document.createElement('span');
    lockText.textContent = 'Global Rogowska lock: CM→Witkowskiego→Dąbka→Rogowska horizontal; CM→Grochowa 45° up';
    lockRow.append(lock, lockText);

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:10px';
    const apply = makeButton('Apply');
    const preset = makeButton('Poznań-like');
    const originalBtn = makeButton('Original');
    buttons.append(apply, preset, originalBtn);

    const note = document.createElement('div');
    note.style.cssText = 'opacity:.62;font-size:11px;font-weight:500;margin-top:8px';
    note.textContent = 'v0.8: corridor locks are solved globally. Connected routes move with them instead of being stretched by a post-layout patch.';

    apply.onclick = () => saveAndReload({
      strength: Number(strengthRow.input.value) / 100,
      spacing: Number(spacingRow.input.value) / 100,
      scale: Number(scaleRow.input.value) / 100,
      rogowska: lock.checked,
    });

    preset.onclick = () => saveAndReload({ strength: 0.84, spacing: 0.72, scale: 0.90, rogowska: true });
    originalBtn.onclick = () => saveAndReload({ strength, spacing: spacingUniformity, scale: mapScale, rogowska: lock.checked }, false);

    panel.append(title, strengthRow.row, spacingRow.row, scaleRow.row, lockRow, buttons, note);
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addControls, { once: true });
  } else {
    addControls();
  }
})();
