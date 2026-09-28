// Route identity + octilinear drawing fixes for the standalone Folityn map.
// Loaded after app.js/orientation-fix.js, while app.js is waiting on the network fetch.
(() => {
  // A route is numbered only when its actual MTR number or visible route name is numeric.
  // Do NOT turn names such as "ŁC Regio 3" into line 3.
  window.routeNumber = function routeNumberFixed(r) {
    const direct = String(r?.number ?? '').trim();
    if (/^\d{1,3}$/.test(direct)) return Number(direct);

    const name = String(r?.name ?? r?.routeName ?? r?.route_name ?? '').trim();
    if (/^\d{1,3}$/.test(name)) return Number(name);

    // Accept a numeric line prefix only when it is clearly formatted as a line designator,
    // e.g. "175 - Airport". Never pick up a number later in a textual name.
    const prefixed = name.match(/^(\d{1,3})\s*(?:[-–—:]\s*.+)$/);
    return prefixed ? Number(prefixed[1]) : null;
  };

  window.routeClass = function routeClassFixed(r) {
    const t = String(r?.type ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const n = window.routeNumber(r);
    const name = String(r?.name ?? r?.routeName ?? r?.route_name ?? '').trim().toLowerCase();
    const light = t.includes('light_rail');

    if (light && Number.isFinite(n) && n >= 1 && n <= 20) return 'tram';
    if (light && Number.isFinite(n) && n >= 100) return 'bus';
    if (t.includes('high_speed') || /^ic(?:\b|\s|[-–—:])/.test(name)) return 'high';
    if (!light && (t.includes('train_normal') || t === 'rail' || t.includes('train'))) return 'rail';

    // Named light-rail routes in this network are surface services; keeping them named
    // prevents them being merged with numeric tram lines by accident.
    if (light) return 'bus';
    if (Number.isFinite(n) && n >= 100) return 'bus';
    if (Number.isFinite(n) && n >= 1 && n <= 20) return 'tram';
    return 'rail';
  };

  window.serviceKey = function serviceKeyFixed(r) {
    const cls = window.routeClass(r);
    const n = window.routeNumber(r);
    if ((cls === 'tram' || cls === 'bus') && Number.isFinite(n)) return `${cls}:${n}`;

    let name = String(r?.name ?? r?.routeName ?? r?.route_name ?? '').trim();
    // Remove only obvious directional suffixes. Keep the actual service name intact.
    name = name.replace(/\s+(?:to|towards?)\s+.+$/i, '').trim();
    const key = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return `${cls}:${key || String(r?.id ?? 'unnamed')}`;
  };

  window.serviceLabel = function serviceLabelFixed(r) {
    const n = window.routeNumber(r);
    return Number.isFinite(n) ? String(n) : String(r?.name ?? r?.routeName ?? r?.route_name ?? 'unnamed');
  };

  // Prefer a reasonably complete direction without rewarding huge detours.
  window.variantScore = function variantScoreFixed(seq, nodes) {
    if (!seq || seq.length < 2) return 1e12;
    let length = 0;
    for (let i = 1; i < seq.length; i++) {
      const a = nodes.get(seq[i - 1]), b = nodes.get(seq[i]);
      if (!a || !b) continue;
      length += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const a = nodes.get(seq[0]), b = nodes.get(seq[seq.length - 1]);
    const direct = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    const detour = direct > 1 ? length / direct : 1;
    const detourPenalty = Math.max(0, detour - 1.45) * 5000;
    return detourPenalty - seq.length * 35 - direct * 0.02;
  };

  function octilinearPoints(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
    const eps = 0.75;

    if (ax < eps || ay < eps || Math.abs(ax - ay) < eps) return [[x1, y1], [x2, y2]];

    // One 45° leg + one horizontal/vertical leg. This guarantees that every piece
    // is 0°, 45° or 90° while keeping both station endpoints fixed.
    if (ax > ay) {
      return [[x1, y1], [x1 + sx * ay, y2], [x2, y2]];
    }
    return [[x1, y1], [x2, y1 + sy * ax], [x2, y2]];
  }

  function convertLine(line) {
    if (!(line instanceof SVGLineElement) || line.dataset.octilinear === '1') return;
    const x1 = Number(line.getAttribute('x1')), y1 = Number(line.getAttribute('y1'));
    const x2 = Number(line.getAttribute('x2')), y2 = Number(line.getAttribute('y2'));
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    for (const attr of line.getAttributeNames()) {
      if (!['x1', 'y1', 'x2', 'y2'].includes(attr)) poly.setAttribute(attr, line.getAttribute(attr));
    }
    poly.setAttribute('points', octilinearPoints(x1, y1, x2, y2).map(p => p.join(',')).join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    poly.dataset.octilinear = '1';
    if (line.onclick) poly.onclick = line.onclick;
    line.replaceWith(poly);
  }

  function octilinearize(root = document) {
    root.querySelectorAll?.('#corridorsLayer line.corridor-base, #routesLayer line.route-line').forEach(convertLine);
  }

  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.('line.corridor-base, line.route-line')) convertLine(n);
        octilinearize(n);
      }
    }
  });

  function startObserver() {
    const corridor = document.getElementById('corridorsLayer');
    const routes = document.getElementById('routesLayer');
    if (!corridor || !routes) return setTimeout(startObserver, 25);
    observer.observe(corridor, { childList: true, subtree: true });
    observer.observe(routes, { childList: true, subtree: true });
    octilinearize();

    // If the first build happened before this patch loaded, force one rebuild through the
    // existing reset button so the corrected service identities are applied immediately.
    let attempts = 0;
    const rebuildWhenReady = setInterval(() => {
      attempts++;
      const status = document.getElementById('snapshotStatus')?.textContent || '';
      if (/Live MTR|Saved MTR/.test(status)) {
        clearInterval(rebuildWhenReady);
        document.getElementById('resetLayout')?.click();
        setTimeout(octilinearize, 50);
      } else if (attempts > 80) clearInterval(rebuildWhenReady);
    }, 50);
  }

  startObserver();
})();
