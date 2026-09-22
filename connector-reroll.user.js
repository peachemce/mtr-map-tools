// ==UserScript==
// @name         MTR Map Tools - Connector Geometry Editor
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      0.3.1
// @description  Give individual MTR map connections real alternate geometry using virtual bend points.
// @match        http://localhost:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==

(() => {
  'use strict';

  const KEY_OVERRIDES = 'mtr-map-tools-geometry-overrides-v1';
  const nativePush = Array.prototype.push;
  const overrides = loadOverrides();

  // IMPORTANT: once Array.prototype.push is patched, this script must never call
  // .push() internally. Always use this saved native implementation.
  function safePush(array, ...items) {
    return nativePush.apply(array, items);
  }

  function loadOverrides() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY_OVERRIDES) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) {
      return {};
    }
  }

  function saveOverrides() {
    localStorage.setItem(KEY_OVERRIDES, JSON.stringify(overrides));
  }

  function connectionKey(id1, id2) {
    return id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
  }

  function looksLikeMtrLineConnection(value) {
    return !!value &&
      typeof value === 'object' &&
      Array.isArray(value.lineConnectionParts) &&
      Number.isInteger(value.direction1) &&
      Number.isInteger(value.direction2) &&
      typeof value.stationId1 === 'string' &&
      typeof value.stationId2 === 'string' &&
      typeof value.x1 === 'number' &&
      typeof value.x2 === 'number' &&
      typeof value.z1 === 'number' &&
      typeof value.z2 === 'number' &&
      typeof value.relativeLength === 'number';
  }

  function directionForSegment(a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const ax = Math.abs(dx);
    const az = Math.abs(dz);
    const eps = 1e-6;

    if (az < eps) return 0;
    if (ax < eps) return 2;
    if (Math.abs(ax - az) < eps) return dx * dz < 0 ? 1 : 3;

    let angle = Math.atan2(dz, dx) % Math.PI;
    if (angle < 0) angle += Math.PI;
    return ((Math.round(angle / (Math.PI / 4)) % 4) + 4) % 4;
  }

  function uniquePoints(points) {
    const out = [];
    for (const point of points) {
      const last = out[out.length - 1];
      if (!last || Math.hypot(last.x - point.x, last.z - point.z) > 1e-6) {
        safePush(out, point);
      }
    }
    return out;
  }

  function geometryPoints(connection, setting) {
    const a = { x: connection.x1, z: connection.z1 };
    const b = { x: connection.x2, z: connection.z2 };
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const ax = Math.abs(dx);
    const az = Math.abs(dz);
    const sx = Math.sign(dx) || 1;
    const sz = Math.sign(dz) || 1;
    const diagonal = Math.min(ax, az);
    const amount = Number(setting.amount) || 0.22;
    const margin = Math.max(120, Math.min(1200, Math.hypot(dx, dz) * amount));

    switch (setting.shape) {
      case 'HV':
        return uniquePoints([a, { x: b.x, z: a.z }, b]);
      case 'VH':
        return uniquePoints([a, { x: a.x, z: b.z }, b]);
      case 'DIAG_FIRST':
        return uniquePoints([a, { x: a.x + sx * diagonal, z: a.z + sz * diagonal }, b]);
      case 'DIAG_LAST':
        return uniquePoints([a, { x: b.x - sx * diagonal, z: b.z - sz * diagonal }, b]);
      case 'ABOVE': {
        const z = Math.min(a.z, b.z) - margin;
        return uniquePoints([a, { x: a.x, z }, { x: b.x, z }, b]);
      }
      case 'BELOW': {
        const z = Math.max(a.z, b.z) + margin;
        return uniquePoints([a, { x: a.x, z }, { x: b.x, z }, b]);
      }
      case 'LEFT': {
        const x = Math.min(a.x, b.x) - margin;
        return uniquePoints([a, { x, z: a.z }, { x, z: b.z }, b]);
      }
      case 'RIGHT': {
        const x = Math.max(a.x, b.x) + margin;
        return uniquePoints([a, { x, z: a.z }, { x, z: b.z }, b]);
      }
      default:
        return [a, b];
    }
  }

  function splitConnection(connection, setting) {
    if (!setting || setting.shape === 'NATIVE') return [connection];

    const points = geometryPoints(connection, setting);
    if (points.length < 2) return [connection];

    const lengths = [];
    let totalLength = 0;
    for (let i = 1; i < points.length; i++) {
      const length = Math.hypot(
        points[i].x - points[i - 1].x,
        points[i].z - points[i - 1].z,
      );
      safePush(lengths, length);
      totalLength += length;
    }

    const result = [];
    for (let i = 1; i < points.length; i++) {
      const p1 = points[i - 1];
      const p2 = points[i];
      const direction = directionForSegment(p1, p2);
      const partLength = lengths[i - 1];

      safePush(result, {
        ...connection,
        x1: p1.x,
        z1: p1.z,
        x2: p2.x,
        z2: p2.z,
        direction1: direction,
        direction2: direction,
        length: partLength,
        relativeLength: totalLength > 0
          ? connection.relativeLength * partLength / totalLength
          : connection.relativeLength,
        __mtrMapToolsSynthetic: true,
      });
    }

    return result;
  }

  // Intercept only finished MTR LineConnection objects. Everything else passes
  // through the original Array.push unchanged.
  Array.prototype.push = function (...items) {
    let needsTransform = false;

    for (const item of items) {
      if (looksLikeMtrLineConnection(item) && !item.__mtrMapToolsSynthetic) {
        const setting = overrides[connectionKey(item.stationId1, item.stationId2)];
        if (setting && setting.shape !== 'NATIVE') {
          needsTransform = true;
          break;
        }
      }
    }

    // Fast path: almost every push in Angular/MTR lands here.
    if (!needsTransform) return nativePush.apply(this, items);

    const transformed = [];
    for (const item of items) {
      if (looksLikeMtrLineConnection(item) && !item.__mtrMapToolsSynthetic) {
        const setting = overrides[connectionKey(item.stationId1, item.stationId2)];
        if (setting && setting.shape !== 'NATIVE') {
          nativePush.apply(transformed, splitConnection(item, setting));
        } else {
          safePush(transformed, item);
        }
      } else {
        safePush(transformed, item);
      }
    }

    return nativePush.apply(this, transformed);
  };

  async function getNetwork() {
    const response = await fetch('/mtr/api/map/stations-and-routes?dimension=0', { cache: 'no-store' });
    if (!response.ok) throw new Error(`MTR API ${response.status}`);
    const json = await response.json();
    return json?.data ?? json;
  }

  function getEditablePairs(data) {
    const stationNames = new Map(
      (data.stations || []).map(station => [station.id, station.name || station.id]),
    );
    const pairs = new Map();

    for (const route of data.routes || []) {
      if (route.hidden) continue;
      const stops = route.stations || [];
      for (let i = 1; i < stops.length; i++) {
        const a = stops[i - 1];
        const b = stops[i];
        if (!a?.id || !b?.id || a.id === b.id) continue;
        const key = connectionKey(a.id, b.id);
        if (!pairs.has(key)) {
          pairs.set(key, {
            key,
            name1: stationNames.get(a.id) || a.id,
            name2: stationNames.get(b.id) || b.id,
          });
        }
      }
    }

    return [...pairs.values()].sort((p, q) =>
      `${p.name1} ${p.name2}`.localeCompare(`${q.name1} ${q.name2}`),
    );
  }

  function makeButton(text) {
    const element = document.createElement('button');
    element.textContent = text;
    Object.assign(element.style, {
      border: '1px solid #4b5563',
      borderRadius: '7px',
      padding: '6px 8px',
      background: '#1f2937',
      color: '#fff',
      cursor: 'pointer',
      font: 'inherit',
    });
    return element;
  }

  function styleInput(element) {
    Object.assign(element.style, {
      width: '100%',
      boxSizing: 'border-box',
      border: '1px solid #4b5563',
      borderRadius: '7px',
      padding: '6px 7px',
      background: '#111827',
      color: '#fff',
      font: 'inherit',
    });
  }

  async function addControls() {
    if (!document.body || document.getElementById('mtr-real-geometry-editor')) return;

    const panel = document.createElement('div');
    panel.id = 'mtr-real-geometry-editor';
    Object.assign(panel.style, {
      position: 'fixed',
      left: '14px',
      bottom: '14px',
      zIndex: '1000000',
      width: '360px',
      padding: '11px',
      borderRadius: '11px',
      background: 'rgba(17,24,39,.97)',
      color: '#fff',
      font: '600 12px/1.3 system-ui, sans-serif',
      boxShadow: '0 5px 20px rgba(0,0,0,.3)',
    });

    panel.innerHTML = `
      <div style="font-size:14px;margin-bottom:8px">Real Connector Geometry</div>
      <div id="mtr-geom-loading" style="opacity:.7">Loading station connections…</div>
    `;
    document.body.appendChild(panel);

    try {
      const data = await getNetwork();
      const pairs = getEditablePairs(data);
      panel.innerHTML = '';

      const title = document.createElement('div');
      title.innerHTML = '<strong style="font-size:14px">Real Connector Geometry</strong><div style="opacity:.65;font-weight:500;margin-top:2px">Edit one station-to-station connector at a time.</div>';

      const pairSelect = document.createElement('select');
      styleInput(pairSelect);
      pairSelect.style.marginTop = '9px';
      pairSelect.innerHTML = '<option value="">Choose connection…</option>' + pairs.map(pair =>
        `<option value="${pair.key}">${escapeHtml(pair.name1)} ↔ ${escapeHtml(pair.name2)}</option>`
      ).join('');

      const shapeSelect = document.createElement('select');
      styleInput(shapeSelect);
      shapeSelect.style.marginTop = '7px';
      shapeSelect.innerHTML = `
        <option value="NATIVE">Native MTR geometry</option>
        <option value="HV">Horizontal → vertical</option>
        <option value="VH">Vertical → horizontal</option>
        <option value="DIAG_FIRST">45° diagonal → straight</option>
        <option value="DIAG_LAST">Straight → 45° diagonal</option>
        <option value="ABOVE">Detour above</option>
        <option value="BELOW">Detour below</option>
        <option value="LEFT">Detour left</option>
        <option value="RIGHT">Detour right</option>
      `;

      const amountRow = document.createElement('div');
      amountRow.style.cssText = 'display:grid;grid-template-columns:78px 1fr 45px;gap:7px;align-items:center;margin-top:8px';
      const amountLabel = document.createElement('span');
      amountLabel.textContent = 'Detour size';
      const amount = document.createElement('input');
      amount.type = 'range';
      amount.min = '0.08';
      amount.max = '0.60';
      amount.step = '0.02';
      amount.value = '0.22';
      const amountValue = document.createElement('span');
      amountValue.textContent = '22%';
      amount.oninput = () => {
        amountValue.textContent = `${Math.round(Number(amount.value) * 100)}%`;
      };
      amountRow.append(amountLabel, amount, amountValue);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:9px';
      const apply = makeButton('Apply');
      const clear = makeButton('Clear this');
      const clearAll = makeButton('Clear all');
      actions.append(apply, clear, clearAll);

      const status = document.createElement('div');
      status.style.cssText = 'margin-top:8px;opacity:.72;font-weight:500;min-height:15px';

      pairSelect.onchange = () => {
        const current = overrides[pairSelect.value];
        shapeSelect.value = current?.shape || 'NATIVE';
        amount.value = String(current?.amount ?? 0.22);
        amountValue.textContent = `${Math.round(Number(amount.value) * 100)}%`;
        status.textContent = current ? `Override active: ${shapeSelect.options[shapeSelect.selectedIndex].text}` : '';
      };

      apply.onclick = () => {
        const key = pairSelect.value;
        if (!key) {
          status.textContent = 'Choose a connection first.';
          return;
        }
        if (shapeSelect.value === 'NATIVE') {
          delete overrides[key];
        } else {
          overrides[key] = {
            shape: shapeSelect.value,
            amount: Number(amount.value),
          };
        }
        saveOverrides();
        location.reload();
      };

      clear.onclick = () => {
        if (!pairSelect.value) return;
        delete overrides[pairSelect.value];
        saveOverrides();
        location.reload();
      };

      clearAll.onclick = () => {
        localStorage.removeItem(KEY_OVERRIDES);
        location.reload();
      };

      const hint = document.createElement('div');
      hint.style.cssText = 'margin-top:7px;opacity:.58;font-size:11px;font-weight:500';
      hint.textContent = 'Overrides only affect the map drawing. Minecraft routes and stations are unchanged.';

      panel.append(title, pairSelect, shapeSelect, amountRow, actions, status, hint);
    } catch (error) {
      const loading = panel.querySelector('#mtr-geom-loading');
      if (loading) loading.textContent = `Could not load MTR network: ${error.message}`;
      console.error('[MTR Map Tools] Geometry editor UI failed:', error);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addControls, { once: true });
  } else {
    addControls();
  }

  console.log('[MTR Map Tools] Connector Geometry Editor 0.3.1 loaded', {
    overrides: Object.keys(overrides).length,
  });
})();
