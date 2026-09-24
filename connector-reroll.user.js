// ==UserScript==
// @name         MTR Map Tools - Folityn Native Geometry v8
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      8.0.0
// @description  Keep the native MTR renderer and clean its input geometry: shared station coordinates, straight corridors, octilinear snapping, native interactions preserved.
// @match        http://localhost:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==

(() => {
'use strict';

const KEY = 'folityn-native-v8-';
const ENABLED = localStorage.getItem(KEY + 'enabled') !== '0';
const STRICT_45 = localStorage.getItem(KEY + 'strict45') !== '0';
const TARGET = /\/mtr\/api\/map\/stations-and-routes(?:\?|$)/;

const CFG = {
  straightAngleDeg: 18,
  snapAngleDeg: 18,
  straightPerpRatio: 0.12,
  maxMoveEdgeRatio: 0.28,
  maxMoveAbsolute: 240,
  sameNameMergeDistance: 220,
  passes: 5,
};

const EXPLICIT_GROUPS = [
  {name: 'Wity', aliases: ['folityn wity', 'wity pkm']},
  {name: 'Folityn Jamnikowsko', aliases: ['folityn jamnikowsko', 'jamnikowsko pkm']},
];

const FORCED_CORRIDORS = [
  {from: 'rogowska centrum miejskie', to: ['szwedzka stadion', 'szwedzka', 'norweska']},
];

const norm = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const median = values => {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const angle = (a, b) => Math.atan2(b.z - a.z, b.x - a.x);
const angleDiff = (a, b) => {
  let d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
};
const pointSegProjection = (p, a, b) => {
  const vx = b.x - a.x, vz = b.z - a.z;
  const vv = vx * vx + vz * vz;
  if (!vv) return {...a};
  const t = clamp(((p.x - a.x) * vx + (p.z - a.z) * vz) / vv, 0, 1);
  return {x: a.x + vx * t, z: a.z + vz * t};
};
const pointLineProjection = (p, origin, ux, uz) => {
  const t = (p.x - origin.x) * ux + (p.z - origin.z) * uz;
  return {x: origin.x + ux * t, z: origin.z + uz * t};
};

function routeStations(route) {
  if (Array.isArray(route?.stations)) return route.stations;
  if (Array.isArray(route?.routeStations)) return route.routeStations;
  if (Array.isArray(route?.platforms)) return route.platforms;
  return [];
}

function routeType(route) {
  return norm(route?.type).replace(/[\s-]+/g, '_');
}

function publicRouteKey(route) {
  return [routeType(route), Number(route?.color ?? 0), norm(route?.name ?? route?.routeNumber ?? route?.number ?? '')].join('|');
}

function cleanNetworkEnvelope(envelope) {
  if (!ENABLED || !envelope || typeof envelope !== 'object') return envelope;
  const root = envelope.data && typeof envelope.data === 'object' ? envelope.data : envelope;
  if (!Array.isArray(root.routes) || !Array.isArray(root.stations)) return envelope;

  const output = typeof structuredClone === 'function' ? structuredClone(envelope) : JSON.parse(JSON.stringify(envelope));
  const data = output.data && typeof output.data === 'object' ? output.data : output;
  const routes = data.routes || [];
  const stations = data.stations || [];
  const stationById = new Map(stations.map(s => [String(s.id ?? s.hexId ?? s.stationId ?? ''), s]));

  const coordsByRawId = new Map();
  const routeSeqsRaw = [];
  for (const route of routes) {
    const seq = [];
    for (const st of routeStations(route)) {
      const id = String(st?.id ?? st?.hexId ?? st?.stationId ?? '');
      const x = Number(st?.x ?? st?.position?.x);
      const z = Number(st?.z ?? st?.position?.z);
      if (!id || !Number.isFinite(x) || !Number.isFinite(z)) continue;
      seq.push(id);
      if (!coordsByRawId.has(id)) coordsByRawId.set(id, []);
      coordsByRawId.get(id).push({x, z});
    }
    if (seq.length >= 2) routeSeqsRaw.push({route, seq});
  }

  const rawPoint = new Map();
  for (const [id, pts] of coordsByRawId) {
    rawPoint.set(id, {x: median(pts.map(p => p.x)), z: median(pts.map(p => p.z))});
  }

  const ids = [...rawPoint.keys()];
  const parent = new Map(ids.map(id => [id, id]));
  const find = id => {
    let p = parent.get(id) ?? id;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p);
    let q = id;
    while ((parent.get(q) ?? q) !== p) { const n = parent.get(q); parent.set(q, p); q = n; }
    return p;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    a = find(a); b = find(b);
    if (a !== b) parent.set(b, a);
  };

  const idsByPublicName = new Map();
  for (const id of ids) {
    const n = norm(stationById.get(id)?.name ?? id);
    if (!idsByPublicName.has(n)) idsByPublicName.set(n, []);
    idsByPublicName.get(n).push(id);
  }

  for (const group of EXPLICIT_GROUPS) {
    const groupIds = [];
    for (const alias of group.aliases) groupIds.push(...(idsByPublicName.get(alias) || []));
    for (let i = 1; i < groupIds.length; i++) union(groupIds[0], groupIds[i]);
  }

  for (const groupIds of idsByPublicName.values()) {
    for (let i = 0; i < groupIds.length; i++) for (let j = i + 1; j < groupIds.length; j++) {
      const a = rawPoint.get(groupIds[i]), b = rawPoint.get(groupIds[j]);
      if (a && b && dist(a, b) <= CFG.sameNameMergeDistance) union(groupIds[i], groupIds[j]);
    }
  }

  const members = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(id);
  }

  const logicalForRaw = new Map();
  const logicalPoint = new Map();
  const logicalName = new Map();
  for (const [rep, memberIds] of members) {
    const pts = memberIds.map(id => rawPoint.get(id)).filter(Boolean);
    if (!pts.length) continue;
    const p = {x: median(pts.map(v => v.x)), z: median(pts.map(v => v.z))};
    logicalPoint.set(rep, p);
    const names = memberIds.map(id => String(stationById.get(id)?.name ?? '')).filter(Boolean);
    let display = names[0] || rep;
    for (const group of EXPLICIT_GROUPS) {
      if (names.some(n => group.aliases.includes(norm(n)))) { display = group.name; break; }
    }
    logicalName.set(rep, display);
    for (const id of memberIds) logicalForRaw.set(id, rep);
  }

  const routeSeqs = [];
  for (const {route, seq} of routeSeqsRaw) {
    const logical = [];
    for (const rawId of seq) {
      const id = logicalForRaw.get(rawId) ?? rawId;
      if (logical.at(-1) !== id) logical.push(id);
    }
    if (logical.length >= 2) routeSeqs.push({route, key: publicRouteKey(route), seq: logical});
  }

  const edgeLengths = [];
  for (const {seq} of routeSeqs) for (let i = 1; i < seq.length; i++) {
    const a = logicalPoint.get(seq[i - 1]), b = logicalPoint.get(seq[i]);
    if (a && b) edgeLengths.push(dist(a, b));
  }
  const typicalEdge = Math.max(40, median(edgeLengths));
  const maxMove = Math.min(CFG.maxMoveAbsolute, typicalEdge * CFG.maxMoveEdgeRatio);
  const straightAngle = CFG.straightAngleDeg * Math.PI / 180;
  const snapError = CFG.snapAngleDeg * Math.PI / 180;

  for (let pass = 0; pass < CFG.passes; pass++) {
    const proposals = new Map();
    for (const {seq} of routeSeqs) {
      for (let i = 1; i < seq.length - 1; i++) {
        const aid = seq[i - 1], pid = seq[i], bid = seq[i + 1];
        const a = logicalPoint.get(aid), p = logicalPoint.get(pid), b = logicalPoint.get(bid);
        if (!a || !p || !b || aid === bid) continue;
        const h1 = angle(a, p), h2 = angle(p, b);
        const base = Math.max(1, dist(a, b));
        const q = pointSegProjection(p, a, b);
        const shift = dist(p, q);
        const almostSameHeading = angleDiff(h1, h2) <= straightAngle;
        const closeToChord = shift <= Math.min(maxMove, base * CFG.straightPerpRatio);
        if (!(almostSameHeading || closeToChord) || shift > maxMove) continue;
        if (!proposals.has(pid)) proposals.set(pid, []);
        proposals.get(pid).push(q);
      }
    }
    let changed = 0;
    for (const [id, qs] of proposals) {
      const old = logicalPoint.get(id);
      if (!old || !qs.length) continue;
      const q = {x: median(qs.map(v => v.x)), z: median(qs.map(v => v.z))};
      if (dist(old, q) <= maxMove) { logicalPoint.set(id, q); changed++; }
    }
    if (!changed) break;
  }

  if (STRICT_45) {
    const proposals = new Map();
    const seenRun = new Set();
    for (const {key, seq} of routeSeqs) {
      let start = 0;
      while (start < seq.length - 1) {
        let end = start + 1;
        let prev = angle(logicalPoint.get(seq[start]), logicalPoint.get(seq[end]));
        while (end < seq.length - 1) {
          const p = logicalPoint.get(seq[end]), n = logicalPoint.get(seq[end + 1]);
          if (!p || !n) break;
          const h = angle(p, n);
          if (angleDiff(prev, h) > straightAngle) break;
          prev = h; end++;
        }
        if (end - start >= 2) {
          const run = seq.slice(start, end + 1);
          const signature = key + '|' + run.join('>');
          if (!seenRun.has(signature)) {
            seenRun.add(signature);
            const pts = run.map(id => logicalPoint.get(id));
            if (pts.every(Boolean)) {
              const first = pts[0], last = pts.at(-1);
              const rawHeading = angle(first, last);
              const snapped = Math.round(rawHeading / (Math.PI / 4)) * (Math.PI / 4);
              if (angleDiff(rawHeading, snapped) <= snapError) {
                const ux = Math.cos(snapped), uz = Math.sin(snapped);
                const center = {x: median(pts.map(p => p.x)), z: median(pts.map(p => p.z))};
                const projected = pts.map(p => pointLineProjection(p, center, ux, uz));
                const worst = Math.max(...projected.map((p, i) => dist(p, pts[i])));
                if (worst <= maxMove) {
                  run.forEach((id, i) => {
                    if (!proposals.has(id)) proposals.set(id, []);
                    proposals.get(id).push(projected[i]);
                  });
                }
              }
            }
          }
        }
        start = Math.max(start + 1, end);
      }
    }
    for (const [id, qs] of proposals) {
      const old = logicalPoint.get(id);
      if (!old || !qs.length) continue;
      const q = {x: median(qs.map(v => v.x)), z: median(qs.map(v => v.z))};
      if (dist(old, q) <= maxMove) logicalPoint.set(id, q);
    }
  }

  const nameToLogical = new Map();
  for (const [id, name] of logicalName) nameToLogical.set(norm(name), id);
  for (const rule of FORCED_CORRIDORS) {
    const fromId = nameToLogical.get(rule.from);
    let toId = null;
    for (const n of rule.to) if (nameToLogical.has(n)) { toId = nameToLogical.get(n); break; }
    if (!fromId || !toId) continue;
    for (const {seq} of routeSeqs) {
      const i1 = seq.indexOf(fromId), i2 = seq.indexOf(toId);
      if (i1 < 0 || i2 < 0 || i1 === i2) continue;
      const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
      const a = logicalPoint.get(seq[lo]), b = logicalPoint.get(seq[hi]);
      if (!a || !b) continue;
      for (let i = lo + 1; i < hi; i++) {
        const id = seq[i], p = logicalPoint.get(id);
        if (!p) continue;
        const q = pointSegProjection(p, a, b);
        if (dist(p, q) <= Math.max(maxMove, typicalEdge * 0.45)) logicalPoint.set(id, q);
      }
    }
  }

  let changedOccurrences = 0;
  for (const route of routes) {
    for (const st of routeStations(route)) {
      const rawId = String(st?.id ?? st?.hexId ?? st?.stationId ?? '');
      const logical = logicalForRaw.get(rawId);
      const p = logical && logicalPoint.get(logical);
      if (!p) continue;
      const oldX = Number(st?.x ?? st?.position?.x), oldZ = Number(st?.z ?? st?.position?.z);
      if (Number.isFinite(oldX) && Number.isFinite(oldZ) && (Math.abs(oldX - p.x) > .01 || Math.abs(oldZ - p.z) > .01)) changedOccurrences++;
      if ('x' in st || !st.position) st.x = Math.round(p.x * 100) / 100;
      if ('z' in st || !st.position) st.z = Math.round(p.z * 100) / 100;
      if (st.position && typeof st.position === 'object') {
        st.position.x = Math.round(p.x * 100) / 100;
        st.position.z = Math.round(p.z * 100) / 100;
      }
    }
  }

  console.info(`[Folityn v8] Native MTR data cleaned: ${logicalPoint.size} visual stations, ${changedOccurrences} route-station coordinates adjusted. Native renderer remains active.`);
  return output;
}

function cleanText(text) {
  try { return JSON.stringify(cleanNetworkEnvelope(JSON.parse(text))); }
  catch { return text; }
}

const nativeFetch = window.fetch.bind(window);
window.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : input?.url || '';
  const response = await nativeFetch(input, init);
  if (!ENABLED || !TARGET.test(url)) return response;
  try {
    const json = await response.clone().json();
    const cleaned = cleanNetworkEnvelope(json);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(cleaned), {status: response.status, statusText: response.statusText, headers});
  } catch (e) {
    console.warn('[Folityn v8] fetch cleaning failed; native response used', e);
    return response;
  }
};

try {
  const proto = XMLHttpRequest.prototype;
  const nativeOpen = proto.open;
  const textDescriptor = Object.getOwnPropertyDescriptor(proto, 'responseText');
  const responseDescriptor = Object.getOwnPropertyDescriptor(proto, 'response');
  const cache = new WeakMap();

  proto.open = function(method, url, ...rest) {
    this.__folitynTarget = ENABLED && TARGET.test(String(url || ''));
    return nativeOpen.call(this, method, url, ...rest);
  };

  const cleanedTextFor = xhr => {
    if (!xhr.__folitynTarget || xhr.readyState !== 4 || !textDescriptor?.get) return null;
    if (cache.has(xhr)) return cache.get(xhr);
    try {
      const raw = textDescriptor.get.call(xhr);
      const cleaned = cleanText(raw);
      cache.set(xhr, cleaned);
      return cleaned;
    } catch { return null; }
  };

  if (textDescriptor?.configurable && textDescriptor.get) {
    Object.defineProperty(proto, 'responseText', {
      configurable: true,
      enumerable: textDescriptor.enumerable,
      get() { const cleaned = cleanedTextFor(this); return cleaned ?? textDescriptor.get.call(this); },
    });
  }

  if (responseDescriptor?.configurable && responseDescriptor.get) {
    Object.defineProperty(proto, 'response', {
      configurable: true,
      enumerable: responseDescriptor.enumerable,
      get() {
        if (this.__folitynTarget && this.readyState === 4) {
          try {
            if (this.responseType === 'json') {
              const raw = responseDescriptor.get.call(this);
              if (raw && typeof raw === 'object') return cleanNetworkEnvelope(raw);
            }
            if (!this.responseType || this.responseType === 'text') {
              const cleaned = cleanedTextFor(this);
              if (cleaned != null) return cleaned;
            }
          } catch {}
        }
        return responseDescriptor.get.call(this);
      },
    });
  }
} catch (e) {
  console.warn('[Folityn v8] XHR interception unavailable; fetch interception remains active.', e);
}

function addPanel() {
  document.querySelectorAll('#folityn-original-mtr-tools, [id^="folityn-v"]').forEach(el => el.remove());
  if (document.getElementById('folityn-native-v8-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'folityn-native-v8-panel';
  panel.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:100000;background:rgba(12,18,30,.94);color:#fff;padding:10px 12px;border-radius:10px;font:12px/1.35 Arial,sans-serif;box-shadow:0 6px 24px #0008;min-width:220px';
  panel.innerHTML = `
    <div style="font-weight:750;font-size:13px">Folityn native geometry v8</div>
    <div style="opacity:.7;font-size:11px;margin:2px 0 8px">MTR renderer + cleaned input geometry</div>
    <label style="display:flex;gap:7px;align-items:center;margin:5px 0"><input id="fol-clean" type="checkbox" ${ENABLED ? 'checked' : ''}> Geometry cleanup</label>
    <label style="display:flex;gap:7px;align-items:center;margin:5px 0"><input id="fol-45" type="checkbox" ${STRICT_45 ? 'checked' : ''}> Strict 0° / 45° / 90° corridors</label>
    <div style="opacity:.62;font-size:10px;margin-top:7px">Changes require reload. Native MTR clicks, pan/zoom, filters and dark mode stay untouched.</div>`;
  document.body.appendChild(panel);
  panel.querySelector('#fol-clean').addEventListener('change', e => {
    localStorage.setItem(KEY + 'enabled', e.target.checked ? '1' : '0');
    location.reload();
  });
  panel.querySelector('#fol-45').addEventListener('change', e => {
    localStorage.setItem(KEY + 'strict45', e.target.checked ? '1' : '0');
    location.reload();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addPanel, {once: true});
else addPanel();

})();
