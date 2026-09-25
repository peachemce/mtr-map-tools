// ==UserScript==
// @name         Folityn MTR Map Tools
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.8.6
// @description  Rollback to stable 11.8.4 behavior after reverting the broken Larcho-Chomicki corridor patch.
// @match        http://localhost:8888/*
// @match        http://127.0.0.1:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @require      https://raw.githubusercontent.com/peachemce/mtr-map-tools/e898fefccbed81c38c1fa0ef1e07b67aa6469760/connector-reroll.user.js
// @require      https://raw.githubusercontent.com/peachemce/mtr-map-tools/4649156d1411622c09ad40668bfcb1ada5c07906/connector-reroll.user.js
// @require      https://raw.githubusercontent.com/peachemce/mtr-map-tools/23a683f9678584cb801824661fc7a320d6b587e9/connector-reroll.user.js
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==
(()=>{'use strict';
const TARGET=/\/mtr\/api\/map\/stations-and-routes(?:\?|$)/;
const norm=s=>String(s??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
const stops=r=>Array.isArray(r?.stations)?r.stations:Array.isArray(r?.routeStations)?r.routeStations:Array.isArray(r?.platforms)?r.platforms:[];
const sid=s=>String(s?.id??s?.hexId??s?.stationId??'');
const pt=s=>{const x=Number(s?.x??s?.position?.x),z=Number(s?.z??s?.position?.z);return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null};
const put=(s,q)=>{'x'in s||!s.position?(s.x=q.x,s.z=q.z):(s.position={...s.position,x:q.x,z:q.z})};
const root=o=>o?.data&&typeof o.data==='object'?o.data:o;
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});
const dist=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function nameMap(d){const m=new Map();for(const s of d.stations||[])m.set(String(s.id??s.hexId??s.stationId??''),String(s.name??''));return m}
function coordinates(d){const o=new Map();for(const r of d.routes||[])for(const s of stops(r)){const id=sid(s),q=pt(s);if(!id||!q)continue;if(!o.has(id))o.set(id,[]);o.get(id).push(q)}const out=new Map();for(const[id,ps]of o){const xs=ps.map(p=>p.x).sort((a,b)=>a-b),zs=ps.map(p=>p.z).sort((a,b)=>a-b),i=xs.length>>1;out.set(id,{x:xs.length%2?xs[i]:(xs[i-1]+xs[i])/2,z:zs.length%2?zs[i]:(zs[i-1]+zs[i])/2})}return out}
function find(names,cands){const s=new Set(cands.map(norm));for(const[id,n]of names)if(s.has(norm(n)))return id;return null}
function setAll(d,id,q){if(!id||!q)return;for(const r of d.routes||[])for(const s of stops(r))if(sid(s)===id)put(s,q)}
function flatten(d,aId,bId,A,B){if(!aId||!bId||!A||!B)return 0;let moved=0;for(const r of d.routes||[]){const ss=stops(r),ids=ss.map(sid),ia=ids.indexOf(aId),ib=ids.indexOf(bId);if(ia<0||ib<0||ia===ib)continue;const lo=Math.min(ia,ib),hi=Math.max(ia,ib),path=ss.slice(lo,hi+1),forward=ia<ib,ps=path.map(pt);let total=0,cum=[0];for(let i=1;i<path.length;i++){total+=ps[i-1]&&ps[i]?dist(ps[i-1],ps[i]):1;cum.push(total)}if(!total)total=path.length-1;for(let i=1;i<path.length-1;i++){const t0=cum[i]/total,t=forward?t0:1-t0;setAll(d,sid(path[i]),lerp(A,B,clamp(t,.04,.96)));moved++}}return moved}
function lockNamedLine(d,names,C,fromNames,toNames,mids,dbg,key){const a=find(names,fromNames),b=find(names,toNames),A=C.get(a),B=C.get(b);if(!a||!b||!A||!B){dbg[key]='missing anchors';return}const midIds=mids.map(x=>find(names,x)).filter(Boolean);for(let i=0;i<midIds.length;i++)setAll(d,midIds[i],lerp(A,B,(i+1)/(midIds.length+1)));const moved=flatten(d,a,b,A,B);dbg[key]={ok:true,moved,anchors:[names.get(a),names.get(b)],namedMids:midIds.map(id=>names.get(id))}}
function cleanup(o){const d=root(o);if(!d||!Array.isArray(d.routes))return o;const names=nameMap(d),dbg={};let C=coordinates(d);
  // Drzewiec: the staircase in the screenshot is one physical corridor. Keep endpoints, erase every tiny step.
  lockNamedLine(d,names,C,['Rynek Wielowicki'],['Drzewiec PKM'],[['Styczniowa'],['Węzeł 7 Września Hrabska','Wezel 7 Wrzesnia Hrabska'],['Fabryczna']],dbg,'drzewiecStraight');
  C=coordinates(d);
  // South-east branch A: all colours using Most Srodmiejski -> Rodowa share one direct alignment.
  lockNamedLine(d,names,C,['Most Śródmiejski','Most Srodmiejski'],['Rodowa'],[['Rynek Chłopnicki','Rynek Chlopnicki'],['Polna']],dbg,'mostRodowa');
  C=coordinates(d);
  // South-east branch B: same physical street for every service; no green line peeling away and rejoining.
  lockNamedLine(d,names,C,['Most Śródmiejski','Most Srodmiejski'],['Sucharskiego'],[],dbg,'mostSucharskiego');
  window.__folitynFinalCorridorCleanup=dbg;return o
}
function transformText(t){try{return JSON.stringify(cleanup(JSON.parse(t)))}catch(e){console.warn('[Folityn final corridor cleanup]',e);return t}}
const previousFetch=window.fetch.bind(window);window.fetch=async function(input,init){const url=typeof input==='string'?input:input?.url||'',r=await previousFetch(input,init);if(!TARGET.test(url))return r;try{return new Response(transformText(await r.clone().text()),{status:r.status,statusText:r.statusText,headers:r.headers})}catch(e){console.warn('[Folityn final corridor cleanup fetch]',e);return r}};
try{const p=XMLHttpRequest.prototype,tg=Object.getOwnPropertyDescriptor(p,'responseText')?.get,rg=Object.getOwnPropertyDescriptor(p,'response')?.get,cache=new WeakMap();if(tg)Object.defineProperty(p,'responseText',{configurable:true,get(){const raw=tg.call(this);if(!this.__folitynLRFilter||this.readyState!==4||typeof raw!=='string')return raw;let x=cache.get(this)||{};if(x.text===undefined)x.text=transformText(raw);cache.set(this,x);return x.text}});if(rg)Object.defineProperty(p,'response',{configurable:true,get(){const raw=rg.call(this);if(!this.__folitynLRFilter||this.readyState!==4)return raw;let x=cache.get(this)||{};if(this.responseType==='json'&&raw&&typeof raw==='object'){if(x.json===undefined){x.json=typeof structuredClone==='function'?structuredClone(raw):JSON.parse(JSON.stringify(raw));cleanup(x.json)}cache.set(this,x);return x.json}if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){if(x.text===undefined)x.text=transformText(raw);cache.set(this,x);return x.text}return raw}})}catch(e){console.warn('[Folityn final corridor cleanup XHR]',e)}
})();