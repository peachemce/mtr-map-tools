// ==UserScript==
// @name         MTR Map Tools - Original MTR Baseline
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      7.0.0
// @description  Keep the original MTR map untouched and add only lightweight enhancement controls.
// @match        http://localhost:8888/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==

(() => {
'use strict';

const ID='folityn-original-mtr-tools';

function removeOldCustomRenderer(){
  for(const el of [...document.querySelectorAll('[id^="folityn-v"], #folityn-v61-overlay, #folityn-v611-overlay')]){
    if(el && el.id!==ID) el.remove();
  }
}

function makePanel(){
  if(document.getElementById(ID)) return;
  const box=document.createElement('div');
  box.id=ID;
  box.style.cssText='position:fixed;left:14px;bottom:14px;z-index:100000;background:rgba(12,18,30,.94);color:#fff;padding:10px 12px;border-radius:10px;font:12px/1.35 Arial,sans-serif;box-shadow:0 6px 24px #0008;min-width:190px;';
  box.innerHTML=`
    <div style="font-weight:700;font-size:13px">Folityn MTR tools v7.0</div>
    <div style="opacity:.7;font-size:11px;margin-top:2px">Original MTR geometry preserved</div>
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid #ffffff22;opacity:.85">
      Custom schematic renderer disabled.<br>
      Pan, zoom, station clicks and routes are MTR native again.
    </div>`;
  document.body.appendChild(box);
}

function init(){
  removeOldCustomRenderer();
  makePanel();
  console.log('[Folityn v7] Original MTR map restored; no custom geometry renderer active.');
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true});
else init();
})();
