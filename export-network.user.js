// ==UserScript==
// @name         MTR Map Tools - Export Network Snapshot
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      0.1.0
// @description  Export the current MTR system-map network as a static JSON snapshot for GitHub Pages.
// @match        http://localhost:8888/*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (document.getElementById('mtr-export-network-button')) return;

  const button = document.createElement('button');
  button.id = 'mtr-export-network-button';
  button.textContent = 'Export public map';

  Object.assign(button.style, {
    position: 'fixed',
    right: '18px',
    bottom: '18px',
    zIndex: '999999',
    padding: '10px 14px',
    border: '0',
    borderRadius: '9px',
    background: '#111827',
    color: '#fff',
    fontWeight: '700',
    cursor: 'pointer',
    boxShadow: '0 5px 18px rgba(0,0,0,.25)'
  });

  button.addEventListener('click', async () => {
    const oldText = button.textContent;
    try {
      button.disabled = true;
      button.textContent = 'Exporting…';

      const response = await fetch('/mtr/api/map/stations-and-routes?dimension=0', { cache: 'no-store' });
      if (!response.ok) throw new Error(`MTR API returned ${response.status}`);

      const raw = await response.json();
      const data = raw?.data ?? raw;
      const snapshot = {
        format: 'mtr-map-tools-network',
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        source: 'http://localhost:8888/mtr/api/map/stations-and-routes?dimension=0',
        ...data
      };

      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'network.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      button.textContent = 'Exported ✓';
      setTimeout(() => { button.textContent = oldText; button.disabled = false; }, 1800);
    } catch (error) {
      console.error('[MTR Map Tools] Network export failed:', error);
      button.textContent = 'Export failed';
      setTimeout(() => { button.textContent = oldText; button.disabled = false; }, 2200);
    }
  });

  document.body.appendChild(button);
})();
