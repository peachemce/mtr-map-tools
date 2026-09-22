// ==UserScript==
// @name         MTR Map Tools - Connector Geometry Lab
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      0.2.0
// @description  Rotate and smooth MTR system-map connector approach directions without changing the Minecraft network.
// @match        http://localhost:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==

(() => {
  'use strict';

  const KEY_ENABLED = 'mtr-map-tools-geometry-enabled';
  const KEY_ROTATION = 'mtr-map-tools-geometry-rotation';
  const KEY_SMOOTHING = 'mtr-map-tools-geometry-smoothing';

  const enabled = localStorage.getItem(KEY_ENABLED) === '1';
  const rotationDegrees = clamp(Number(localStorage.getItem(KEY_ROTATION) ?? '0'), -45, 45);
  const smoothing = clamp(Number(localStorage.getItem(KEY_SMOOTHING) ?? '0.85'), 0, 1);

  const nativePush = Array.prototype.push;
  const QUARTER_TURN = Math.PI / 4;
  const HALF_TURN = Math.PI;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
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

  // MTR only has four undirected connector approach axes:
  //   0° / 45° / 90° / 135°.
  // We rotate the real station-to-station vector continuously, then snap it back
  // to the nearest legal MTR axis. This gives controlled alternates instead of chaos.
  function idealDirection(connection) {
    const dx = connection.x2 - connection.x1;
    const dz = connection.z2 - connection.z1;
    if (Math.abs(dx) + Math.abs(dz) < 1e-9) return connection.direction1;

    let angle = Math.atan2(dz, dx) + rotationDegrees * Math.PI / 180;
    angle = normalizeAxisAngle(angle);
    return ((Math.round(angle / QUARTER_TURN) % 4) + 4) % 4;
  }

  function normalizeAxisAngle(angle) {
    angle %= HALF_TURN;
    if (angle < 0) angle += HALF_TURN;
    return angle;
  }

  // Blend between two *axes* rather than directed arrows. A line at 0° is the
  // same axis as one at 180°, so the shortest delta lives in [-90°, +90°].
  function blendAxisDirection(originalDirection, targetDirection, amount) {
    const original = originalDirection * QUARTER_TURN;
    const target = targetDirection * QUARTER_TURN;

    let delta = target - original;
    while (delta >= Math.PI / 2) delta -= HALF_TURN;
    while (delta < -Math.PI / 2) delta += HALF_TURN;

    const blended = normalizeAxisAngle(original + delta * amount);
    return ((Math.round(blended / QUARTER_TURN) % 4) + 4) % 4;
  }

  function optimizeConnection(connection) {
    if (!enabled || !looksLikeMtrLineConnection(connection)) return;
    if (connection.__mtrMapToolsGeometryOptimized) return;

    const target = idealDirection(connection);

    // At 100% both ends approach on the same axis as the actual connector vector.
    // This is what gets rid of needless U-shapes and opposite-facing hooks.
    connection.direction1 = blendAxisDirection(connection.direction1, target, smoothing);
    connection.direction2 = blendAxisDirection(connection.direction2, target, smoothing);

    try {
      Object.defineProperty(connection, '__mtrMapToolsGeometryOptimized', {
        value: true,
        enumerable: false,
        configurable: false,
      });
    } catch (_) {
      connection.__mtrMapToolsGeometryOptimized = true;
    }
  }

  // MTR pushes final LineConnection objects into its calculated connection array.
  // Intercept only that exact object shape; all unrelated Array.push calls are untouched.
  Array.prototype.push = function (...items) {
    for (let i = 0; i < items.length; i++) optimizeConnection(items[i]);
    return nativePush.apply(this, items);
  };

  function addControls() {
    if (!document.body || document.getElementById('mtr-geometry-controls')) return;

    const panel = document.createElement('div');
    panel.id = 'mtr-geometry-controls';
    Object.assign(panel.style, {
      position: 'fixed',
      left: '14px',
      bottom: '14px',
      zIndex: '1000000',
      width: '300px',
      padding: '10px 11px',
      borderRadius: '11px',
      background: 'rgba(17,24,39,.96)',
      color: '#fff',
      font: '600 12px/1.25 system-ui, sans-serif',
      boxShadow: '0 5px 20px rgba(0,0,0,.3)',
      userSelect: 'none',
    });

    const title = document.createElement('div');
    title.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
    title.innerHTML = `<strong>Connector Geometry</strong><span style="opacity:.72">${enabled ? 'ON' : 'original'}</span>`;

    const rotationRow = makeSliderRow(
      'Rotation',
      -45,
      45,
      5,
      rotationDegrees,
      value => `${value > 0 ? '+' : ''}${value}°`,
    );

    const smoothingRow = makeSliderRow(
      'Smoothing',
      0,
      100,
      5,
      Math.round(smoothing * 100),
      value => `${value}%`,
    );

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:9px';

    const left = makeButton('↶ −15°');
    const apply = makeButton('Apply');
    const right = makeButton('+15° ↷');
    const straight = makeButton('Smooth 100%');
    const original = makeButton('Original');
    const zero = makeButton('0°');

    left.onclick = () => saveAndReload(
      clamp(Number(rotationRow.input.value) - 15, -45, 45),
      Number(smoothingRow.input.value) / 100,
      true,
    );

    right.onclick = () => saveAndReload(
      clamp(Number(rotationRow.input.value) + 15, -45, 45),
      Number(smoothingRow.input.value) / 100,
      true,
    );

    apply.onclick = () => saveAndReload(
      Number(rotationRow.input.value),
      Number(smoothingRow.input.value) / 100,
      true,
    );

    straight.onclick = () => saveAndReload(
      Number(rotationRow.input.value),
      1,
      true,
    );

    zero.onclick = () => saveAndReload(
      0,
      Number(smoothingRow.input.value) / 100,
      true,
    );

    original.onclick = () => {
      localStorage.setItem(KEY_ENABLED, '0');
      location.reload();
    };

    buttons.append(left, apply, right, zero, straight, original);

    const hint = document.createElement('div');
    hint.textContent = 'Tip: start with 0° / 100%, then try ±15° if a corridor chooses the wrong diagonal.';
    hint.style.cssText = 'margin-top:8px;opacity:.68;font-weight:500;font-size:11px';

    panel.append(title, rotationRow.row, smoothingRow.row, buttons, hint);
    document.body.appendChild(panel);
  }

  function makeSliderRow(label, min, max, step, value, format) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:72px 1fr 48px;align-items:center;gap:7px;margin:6px 0';

    const text = document.createElement('span');
    text.textContent = label;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.style.width = '100%';

    const output = document.createElement('span');
    output.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums';
    output.textContent = format(Number(input.value));
    input.oninput = () => { output.textContent = format(Number(input.value)); };

    row.append(text, input, output);
    return { row, input, output };
  }

  function makeButton(text) {
    const button = document.createElement('button');
    button.textContent = text;
    Object.assign(button.style, {
      border: '1px solid #4b5563',
      borderRadius: '7px',
      padding: '6px 7px',
      background: '#1f2937',
      color: '#fff',
      cursor: 'pointer',
      font: 'inherit',
    });
    return button;
  }

  function saveAndReload(rotation, smooth, turnOn) {
    localStorage.setItem(KEY_ROTATION, String(clamp(rotation, -45, 45)));
    localStorage.setItem(KEY_SMOOTHING, String(clamp(smooth, 0, 1)));
    localStorage.setItem(KEY_ENABLED, turnOn ? '1' : '0');
    location.reload();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addControls, { once: true });
  } else {
    addControls();
  }

  console.log('[MTR Map Tools] Connector Geometry Lab loaded', {
    enabled,
    rotationDegrees,
    smoothing,
  });
})();
