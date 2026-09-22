// ==UserScript==
// @name         MTR Map Tools - Folityn Professional Schematic v2.1
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      2.1.0
// @description  Folityn v2 renderer with strict 0/45/90 geometry and click-only panning.
// @match        http://localhost:8888/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @require      https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/folityn-professional-v21.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/folityn-professional-v21.user.js
// ==/UserScript==

(() => {
  'use strict';

  const PATCHED = 'folitynV21Patched';
  let activeSvg = null;
  let observer = null;

  function parseVertices(d) {
    const tokens = String(d || '').match(/[MLQ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
    if (!tokens?.length) return [];
    const commands = [];
    let i = 0;
    while (i < tokens.length) {
      const cmd = tokens[i++].toUpperCase();
      if (cmd === 'M' || cmd === 'L') {
        const x = Number(tokens[i++]), y = Number(tokens[i++]);
        if (Number.isFinite(x) && Number.isFinite(y)) commands.push({ cmd, x, y });
      } else if (cmd === 'Q') {
        const cx = Number(tokens[i++]), cy = Number(tokens[i++]);
        const x = Number(tokens[i++]), y = Number(tokens[i++]);
        if ([cx, cy, x, y].every(Number.isFinite)) commands.push({ cmd, cx, cy, x, y });
      } else {
        break;
      }
    }
    if (!commands.length || commands[0].cmd !== 'M') return [];

    const out = [{ x: commands[0].x, y: commands[0].y }];
    const hasCurve = commands.some(c => c.cmd === 'Q');
    if (hasCurve) {
      for (const c of commands) if (c.cmd === 'Q') out.push({ x: c.cx, y: c.cy });
      const last = commands.at(-1);
      if (last && (last.cmd === 'L' || last.cmd === 'Q')) out.push({ x: last.x, y: last.y });
    } else {
      for (let n = 1; n < commands.length; n++) {
        const c = commands[n];
        if (c.cmd === 'L') out.push({ x: c.x, y: c.y });
      }
    }
    return dedupe(out);
  }

  function dedupe(points) {
    const out = [];
    for (const p of points) {
      const q = out.at(-1);
      if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 0.75) out.push(p);
    }
    return out;
  }

  function octiBetween(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const m = Math.max(ax, ay, 1);

    // Exact/near horizontal, vertical or 45-degree diagonal: no artificial bend.
    if (Math.min(ax, ay) <= m * 0.035 || Math.abs(ax - ay) <= m * 0.035) return [a, b];

    // Always route the same physical segment the same way regardless of path direction.
    const canonicalForward = ax > 1e-6 ? dx > 0 : dy > 0;
    const start = canonicalForward ? a : b;
    const end = canonicalForward ? b : a;
    const ddx = end.x - start.x, ddy = end.y - start.y;
    const dax = Math.abs(ddx), day = Math.abs(ddy);
    const sx = Math.sign(ddx) || 1, sy = Math.sign(ddy) || 1;
    let bend;

    if (dax >= day) {
      // horizontal -> 45 degrees
      bend = { x: start.x + sx * (dax - day), y: start.y };
    } else {
      // vertical -> 45 degrees
      bend = { x: start.x, y: start.y + sy * (day - dax) };
    }

    const pts = [start, bend, end];
    return canonicalForward ? pts : pts.reverse();
  }

  function strictPath(vertices) {
    if (vertices.length < 2) return '';
    const pts = [vertices[0]];
    for (let i = 1; i < vertices.length; i++) {
      const leg = octiBetween(vertices[i - 1], vertices[i]);
      for (let j = 1; j < leg.length; j++) pts.push(leg[j]);
    }
    const clean = dedupe(pts);
    let d = `M ${clean[0].x} ${clean[0].y}`;
    for (let i = 1; i < clean.length; i++) d += ` L ${clean[i].x} ${clean[i].y}`;
    return d;
  }

  function patchRoutes(svg) {
    const groups = [...svg.children].filter(el => el.tagName?.toLowerCase() === 'g');
    for (const g of groups) {
      const paths = [...g.querySelectorAll(':scope > path')];
      if (!paths.some(p => p.querySelector(':scope > title'))) continue;
      for (const path of paths) {
        if (path.dataset[PATCHED] === '1') continue;
        const title = path.querySelector(':scope > title');
        if (!title) continue;
        const vertices = parseVertices(path.getAttribute('d'));
        if (vertices.length >= 2) {
          const d = strictPath(vertices);
          if (d) path.setAttribute('d', d);
          path.setAttribute('stroke-linejoin', 'round');
          path.setAttribute('stroke-linecap', 'round');
        }
        path.dataset[PATCHED] = '1';
      }
    }
  }

  function cancelStaleDrag(svg, e) {
    // The v2.0 renderer used pointer capture and Firefox could leave its drag state alive.
    // Stop its bubble listener whenever the physical left button is NOT held.
    if ((e.buttons & 1) === 0) {
      e.stopImmediatePropagation();
      try {
        svg.dispatchEvent(new PointerEvent('pointercancel', {
          pointerId: e.pointerId,
          bubbles: false,
          cancelable: false,
        }));
      } catch (_) {}
      svg.style.cursor = 'default';
    }
  }

  function installDragGuard(svg) {
    if (svg.dataset.folitynV21Drag === '1') return;
    svg.dataset.folitynV21Drag = '1';
    svg.style.cursor = 'default';
    svg.addEventListener('pointermove', e => cancelStaleDrag(svg, e), true);
    svg.addEventListener('pointerup', () => { svg.style.cursor = 'default'; }, true);
    svg.addEventListener('pointercancel', () => { svg.style.cursor = 'default'; }, true);
    window.addEventListener('blur', () => {
      try { svg.dispatchEvent(new PointerEvent('pointercancel', { bubbles: false })); } catch (_) {}
      svg.style.cursor = 'default';
    });
  }

  function attach(svg) {
    if (activeSvg === svg) {
      patchRoutes(svg);
      return;
    }
    observer?.disconnect();
    activeSvg = svg;
    installDragGuard(svg);
    patchRoutes(svg);
    observer = new MutationObserver(() => patchRoutes(svg));
    observer.observe(svg, { childList: true, subtree: true });
    console.log('[MTR Map Tools] Folityn v2.1 strict octilinear patch active');
  }

  function tick() {
    const svg = document.querySelector('#folityn-pro-overlay svg');
    if (svg) attach(svg);
  }

  setInterval(tick, 350);
  tick();
})();
