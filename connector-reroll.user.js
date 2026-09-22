// ==UserScript==
// @name         MTR Map Tools - Whole Map Rotation
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      0.4.0
// @description  Rotate the entire MTR web map as one visual plane, with optional upright labels.
// @match        http://localhost:8888/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==

(() => {
  'use strict';

  const KEY_ANGLE = 'mtr-map-tools-map-rotation-angle';
  const KEY_SCALE = 'mtr-map-tools-map-rotation-scale';
  const KEY_UPRIGHT = 'mtr-map-tools-map-rotation-upright-labels';

  let angle = Number(localStorage.getItem(KEY_ANGLE) ?? '-30');
  let scale = Number(localStorage.getItem(KEY_SCALE) ?? '0.88');
  let uprightLabels = localStorage.getItem(KEY_UPRIGHT) !== '0';

  function waitForWrapper() {
    const wrapper = document.querySelector('app-map .wrapper, .wrapper');
    if (wrapper && wrapper.querySelector('canvas')) {
      init(wrapper);
      return;
    }
    setTimeout(waitForWrapper, 250);
  }

  function init(wrapper) {
    if (document.getElementById('mtr-map-rotation-controls')) return;

    wrapper.style.transformOrigin = '50% 50%';
    wrapper.style.transition = 'transform 180ms ease';
    wrapper.style.willChange = 'transform';

    const parent = wrapper.parentElement;
    if (parent) parent.style.overflow = 'hidden';

    const style = document.createElement('style');
    style.id = 'mtr-map-rotation-style';
    document.head.appendChild(style);

    function apply() {
      wrapper.style.transform = `rotate(${angle}deg) scale(${scale})`;

      if (uprightLabels) {
        style.textContent = `
          app-map .wrapper .label > *,
          .wrapper .label > * {
            transform: rotate(${-angle}deg) !important;
            transform-origin: center center !important;
          }
        `;
      } else {
        style.textContent = '';
      }

      angleValue.textContent = `${angle > 0 ? '+' : ''}${angle}°`;
      scaleValue.textContent = `${Math.round(scale * 100)}%`;
    }

    const panel = document.createElement('div');
    panel.id = 'mtr-map-rotation-controls';
    Object.assign(panel.style, {
      position: 'fixed',
      left: '14px',
      bottom: '14px',
      zIndex: '1000000',
      width: '300px',
      padding: '11px',
      borderRadius: '11px',
      background: 'rgba(17,24,39,.96)',
      color: '#fff',
      font: '600 12px/1.3 system-ui, sans-serif',
      boxShadow: '0 5px 20px rgba(0,0,0,.3)',
      userSelect: 'none',
    });

    const title = document.createElement('div');
    title.innerHTML = '<strong style="font-size:14px">Whole Map Rotation</strong><div style="opacity:.65;font-weight:500;margin-top:2px">Rotates every route and station together.</div>';

    const angleRow = document.createElement('div');
    angleRow.style.cssText = 'display:grid;grid-template-columns:58px 1fr 46px;gap:7px;align-items:center;margin-top:10px';
    const angleLabel = document.createElement('span');
    angleLabel.textContent = 'Angle';
    const angleInput = document.createElement('input');
    angleInput.type = 'range';
    angleInput.min = '-60';
    angleInput.max = '60';
    angleInput.step = '1';
    angleInput.value = String(angle);
    const angleValue = document.createElement('span');
    angleValue.style.textAlign = 'right';
    angleRow.append(angleLabel, angleInput, angleValue);

    const scaleRow = document.createElement('div');
    scaleRow.style.cssText = 'display:grid;grid-template-columns:58px 1fr 46px;gap:7px;align-items:center;margin-top:7px';
    const scaleLabel = document.createElement('span');
    scaleLabel.textContent = 'Fit';
    const scaleInput = document.createElement('input');
    scaleInput.type = 'range';
    scaleInput.min = '60';
    scaleInput.max = '110';
    scaleInput.step = '1';
    scaleInput.value = String(Math.round(scale * 100));
    const scaleValue = document.createElement('span');
    scaleValue.style.textAlign = 'right';
    scaleRow.append(scaleLabel, scaleInput, scaleValue);

    const uprightRow = document.createElement('label');
    uprightRow.style.cssText = 'display:flex;align-items:center;gap:7px;margin-top:9px;font-weight:500;cursor:pointer';
    const upright = document.createElement('input');
    upright.type = 'checkbox';
    upright.checked = uprightLabels;
    const uprightText = document.createElement('span');
    uprightText.textContent = 'Keep station labels upright';
    uprightRow.append(upright, uprightText);

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-top:10px';
    const bMinus30 = makeButton('−30°');
    const bMinus15 = makeButton('−15°');
    const bZero = makeButton('0°');
    const bPlus30 = makeButton('+30°');
    buttons.append(bMinus30, bMinus15, bZero, bPlus30);

    angleInput.oninput = () => {
      angle = Number(angleInput.value);
      localStorage.setItem(KEY_ANGLE, String(angle));
      apply();
    };

    scaleInput.oninput = () => {
      scale = Number(scaleInput.value) / 100;
      localStorage.setItem(KEY_SCALE, String(scale));
      apply();
    };

    upright.onchange = () => {
      uprightLabels = upright.checked;
      localStorage.setItem(KEY_UPRIGHT, uprightLabels ? '1' : '0');
      apply();
    };

    bMinus30.onclick = () => setAngle(-30);
    bMinus15.onclick = () => setAngle(-15);
    bZero.onclick = () => setAngle(0);
    bPlus30.onclick = () => setAngle(30);

    function setAngle(value) {
      angle = value;
      angleInput.value = String(value);
      localStorage.setItem(KEY_ANGLE, String(value));
      apply();
    }

    panel.append(title, angleRow, scaleRow, uprightRow, buttons);
    document.body.appendChild(panel);
    apply();
  }

  function makeButton(text) {
    const button = document.createElement('button');
    button.textContent = text;
    Object.assign(button.style, {
      border: '1px solid #4b5563',
      borderRadius: '7px',
      padding: '6px 5px',
      background: '#1f2937',
      color: '#fff',
      cursor: 'pointer',
      font: 'inherit',
    });
    return button;
  }

  waitForWrapper();
})();
