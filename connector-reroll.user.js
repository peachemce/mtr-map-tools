// ==UserScript==
// @name         MTR Map Tools - Connector Approach Reroller
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      0.1.0
// @description  Reroll MTR system-map connector approach directions without changing the Minecraft network.
// @match        http://localhost:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// ==/UserScript==

(() => {
  'use strict';

  const KEY_ENABLED = 'mtr-map-tools-connector-reroll-enabled';
  const KEY_SEED = 'mtr-map-tools-connector-reroll-seed';
  const KEY_STRENGTH = 'mtr-map-tools-connector-reroll-strength';

  const nativePush = Array.prototype.push;

  const enabled = localStorage.getItem(KEY_ENABLED) === '1';
  const seed = Number(localStorage.getItem(KEY_SEED) || '1') || 1;
  const strength = Math.max(0, Math.min(1, Number(localStorage.getItem(KEY_STRENGTH) || '0.65')));

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

  function looksLikeMtrLineConnection(value) {
    return !!value &&
      typeof value === 'object' &&
      Array.isArray(value.lineConnectionParts) &&
      Number.isInteger(value.direction1) &&
      Number.isInteger(value.direction2) &&
      value.direction1 >= 0 && value.direction1 <= 3 &&
      value.direction2 >= 0 && value.direction2 <= 3 &&
      typeof value.stationId1 === 'string' &&
      typeof value.stationId2 === 'string' &&
      typeof value.x1 === 'number' &&
      typeof value.x2 === 'number' &&
      typeof value.z1 === 'number' &&
      typeof value.z2 === 'number' &&
      typeof value.relativeLength === 'number';
  }

  function rerollConnection(connection) {
    if (!enabled || !looksLikeMtrLineConnection(connection)) return;
    if (connection.__mtrMapToolsApproachRerolled) return;

    const base = `${connection.stationId1}|${connection.stationId2}|${seed}`;
    const choice = hash32(base);
    const probability = (choice & 0xffff) / 0xffff;

    // Leave some connectors untouched. This avoids turning the whole map into chaos.
    if (probability > strength) return;

    // +1 / -1 flips between the cardinal and diagonal approach families.
    // Applying the same shift at both ends preserves the connector's relative orientation.
    const shift = (choice >>> 16) & 1 ? 1 : 3;

    try {
      Object.defineProperty(connection, '__mtrMapToolsApproachRerolled', {
        value: true,
        enumerable: false,
        configurable: false,
      });
    } catch (_) {
      connection.__mtrMapToolsApproachRerolled = true;
    }

    connection.direction1 = (connection.direction1 + shift) & 3;
    connection.direction2 = (connection.direction2 + shift) & 3;
  }

  // MTR creates final LineConnection objects and pushes them into an array.
  // Catch only objects with the exact LineConnection-shaped fields and leave all other pushes alone.
  Array.prototype.push = function (...items) {
    for (let i = 0; i < items.length; i++) {
      rerollConnection(items[i]);
    }
    return nativePush.apply(this, items);
  };

  function addControls() {
    if (!document.body || document.getElementById('mtr-connector-reroll-controls')) return;

    const panel = document.createElement('div');
    panel.id = 'mtr-connector-reroll-controls';
    Object.assign(panel.style, {
      position: 'fixed',
      left: '14px',
      bottom: '14px',
      zIndex: '1000000',
      display: 'flex',
      alignItems: 'center',
      gap: '7px',
      padding: '8px',
      borderRadius: '10px',
      background: 'rgba(17,24,39,.94)',
      color: '#fff',
      font: '600 12px/1.2 system-ui, sans-serif',
      boxShadow: '0 5px 20px rgba(0,0,0,.3)',
    });

    const status = document.createElement('span');
    status.textContent = enabled ? `Approaches: alternate #${seed}` : 'Approaches: original';
    status.style.padding = '0 4px';

    const reroll = document.createElement('button');
    reroll.textContent = '↻ Regenerate approaches';
    styleButton(reroll);
    reroll.onclick = () => {
      localStorage.setItem(KEY_ENABLED, '1');
      localStorage.setItem(KEY_SEED, String(seed + 1));
      location.reload();
    };

    const reset = document.createElement('button');
    reset.textContent = 'Original';
    styleButton(reset);
    reset.onclick = () => {
      localStorage.setItem(KEY_ENABLED, '0');
      location.reload();
    };

    const strengthSelect = document.createElement('select');
    strengthSelect.title = 'How many connectors may be given an alternate approach';
    strengthSelect.innerHTML = `
      <option value="0.35">Light</option>
      <option value="0.65">Medium</option>
      <option value="1">All</option>
    `;
    strengthSelect.value = String(strength);
    Object.assign(strengthSelect.style, {
      border: '1px solid #4b5563',
      borderRadius: '7px',
      padding: '5px 6px',
      background: '#111827',
      color: '#fff',
      font: 'inherit',
    });
    strengthSelect.onchange = () => {
      localStorage.setItem(KEY_STRENGTH, strengthSelect.value);
      if (enabled) location.reload();
    };

    panel.append(status, reroll, reset, strengthSelect);
    document.body.appendChild(panel);
  }

  function styleButton(button) {
    Object.assign(button.style, {
      border: '1px solid #4b5563',
      borderRadius: '7px',
      padding: '6px 9px',
      background: '#1f2937',
      color: '#fff',
      cursor: 'pointer',
      font: 'inherit',
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addControls, { once: true });
  } else {
    addControls();
  }

  console.log('[MTR Map Tools] Connector approach reroller loaded', { enabled, seed, strength });
})();
