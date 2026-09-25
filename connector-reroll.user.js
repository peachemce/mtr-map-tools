// ==UserScript==
// @name         Folityn MTR Map Tools
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.8.5
// @description  Stable Folityn schematic + shared Larcho-Chomicki physical corridor with skipped-stop geometry waypoints.
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
const dist=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});
function nameMap(d){const m=new Map();for(const s of d.stations||[])m.set(String(s.id??s.hexId??s.stationId??''),String(s.name??''));return m}
function coordinates(d){const o=new Map();for(const r of d.routes||[])for(const s of stops(r)){const id=sid(s),q=pt(s);if(!id||!q)continue;if(!o.has(id))o.set(id,[]);o.get(id).push(q)}const out=new Map();for(const[id,ps]of o){const xs=ps.map(p=>p.x).sort((a,b)=>a-b),zs=ps.map(p=>p.z).sort((a,b)=>a-b),i=xs.length>>1;out.set(id,{x:xs.length%2?xs[i]:(xs[i-1]+xs[i])/2,z:zs.length%2?zs[i]:(zs[i-1]+zs[i])/2})}return out}
function find(names,cands){const wanted=new Set(cands.map(norm));for(const[id,n]of names)if(wanted.has(norm(n)))return id;return null}
function setAll(d,id,q){if(!id||!q)return;for(const r of d.routes||[])for(const s of stops(r))if(sid(s)===id)put(s,q)}
function isLR(r){const t=norm(r?.type);return t==='train_light_rail'||t==='light_rail'||t.includes('light_rail')}
function cloneStop(x){try{return typeof structuredClone==='function'?structuredClone(x):JSON.parse(JSON.stringify(x))}catch{return {...x}}}
function templateForId(d,id){for(const r of d.routes||[])for(const s of stops(r))if(sid(s)===id)return s;return null}
function flatten(d,aId,bId,A,B){if(!aId||!bId||!A||!B)return 0;let moved=0;for(const r of d.routes||[]){const ss=stops(r),ids=ss.map(sid),ia=ids.indexOf(aId),ib=ids.indexOf(bId);if(ia<0||ib<0||ia===ib)continue;const lo=Math.min(ia,ib),hi=Math.max(ia,ib),path=ss.slice(lo,hi+1),forward=ia<ib,ps=path.map(pt);let total=0,cum=[0];for(let i=1;i<path.length;i++){total+=ps[i-1]&&ps[i]?dist(ps[i-1],ps[i]):1;cum.push(total)}if(!total)total=Math.max(1,path.length-1);for(let i=1;i<path.length-1;i++){const t0=cum[i]/total,t=forward?t0:1-t0,id=sid(path[i]);if(!id)continue;setAll(d,id,lerp(A,B,clamp(t,.04,.96)));moved++}}return moved}
function lineIntersection(A,u,B,v){const det=u.x*v.z-u.z*v.x;if(Math.abs(det)<1e-7)return null;const dx=B.x-A.x,dz=B.z-A.z,t=(dx*v.z-dz*v.x)/det;return{x:A.x+u.x*t,z:A.z+u.z*t}}
function bestOctilinearCorner(A,B,target){const ang=[0,Math.PI/4,Math.PI/2,3*Math.PI/4],dirs=ang.map(a=>({x:Math.cos(a),z:Math.sin(a)}));let best=null,score=Infinity;for(let i=0;i<dirs.length;i++)for(let j=0;j<dirs.length;j++){const diff=Math.abs(i-j)%4;if(diff!==2)continue;const C=lineIntersection(A,dirs[i],B,dirs[j]);if(!C)continue;const span=dist(A,B),margin=span*.6;if(C.x<Math.min(A.x,B.x)-margin||C.x>Math.max(A.x,B.x)+margin||C.z<Math.min(A.z,B.z)-margin||C.z>Math.max(A.z,B.z)+margin)continue;const s=dist(C,target)+.10*(dist(A,C)+dist(C,B));if(s<score){score=s;best=C}}if(best)return best;const c1={x:A.x,z:B.z},c2={x:B.x,z:A.z};return dist(c1,target)<=dist(c2,target)?c1:c2}
function injectSkippedCorner(d,larchoId,chomickiId,mostId){const tmpl=templateForId(d,mostId);if(!tmpl)return 0;let inserted=0;for(const r of d.routes||[]){if(!isLR(r))continue;const ss=stops(r),ids=ss.map(sid),ia=ids.indexOf(larchoId),ib=ids.indexOf(chomickiId);if(ia<0||ib<0||ia===ib)continue;const lo=Math.min(ia,ib),hi=Math.max(ia,ib);if(ids.slice(lo,hi+1).includes(mostId))continue;const ins=cloneStop(tmpl);if('dwellTime'in ins)ins.dwellTime=0;const at=ia<ib?ia+1:ib+1;ss.splice(at,0,ins);inserted++}return inserted}
function lockLarchoChomicki(d,names,C,dbg){const l=find(names,['Rondo Larcho']),m=find(names,['Most Śródmiejski','Most Srodmiejski']),s=find(names,['Sucharskiego']),r=find(names,['Rynek Chomicki','Rynek Chłopnicki','Rynek Chlopnicki']);const L=C.get(l),M=C.get(m),S=C.get(s),R=C.get(r);if(!l||!m||!s||!r||!L||!M||!R){dbg.larchoChomicki='missing anchors';return}const corner=bestOctilinearCorner(L,R,M);setAll(d,m,corner);const vx=R.x-corner.x,vz=R.z-corner.z,vv=vx*vx+vz*vz;let t=.58;if(S&&vv){t=((S.x-corner.x)*vx+(S.z-corner.z)*vz)/vv;t=clamp(t,.20,.82)}setAll(d,s,lerp(corner,R,t));const inserted=injectSkippedCorner(d,l,r,m);const a=flatten(d,l,m,L,corner),b=flatten(d,m,r,corner,R);dbg.larchoChomicki={ok:true,shape:'shared octilinear L',insertedGeometryWaypoints:inserted,movedFirstLeg:a,movedSecondLeg:b}}
function lockDrzewiec(d,names,C,dbg){const a=find(names,['Rynek Wielowicki']),b=find(names,['Drzewiec PKM']),A=C.get(a),B=C.get(b);if(!a||!b||!A||!B){dbg.drzewiec='missing anchors';return}dbg.drzewiec={ok:true,moved:flatten(d,a,b,A,B)}}
function cleanup(o){const d=root(o);if(!d||!Array.isArray(d.routes))return o;const names=nameMap(d),dbg={};let C=coordinates(d);lockLarchoChomicki(d,names,C,dbg);C=coordinates(d);lockDrzewiec(d,names,C,dbg);window.__folitynPhysicalCorridors=dbg;return o}
function transformText(t){try{return JSON.stringify(cleanup(JSON.parse(t)))}catch(e){console.warn('[Folityn physical corridors]',e);return t}}
const previousFetch=window.fetch.bind(window);window.fetch=async function(input,init){const url=typeof input==='string'?input:input?.url||'',r=await previousFetch(input,init);if(!TARGET.test(url))return r;try{return new Response(transformText(await r.clone().text()),{status:r.status,statusText:r.statusText,headers:r.headers})}catch(e){console.warn('[Folityn physical corridors fetch]',e);return r}};
try{const p=XMLHttpRequest.prototype,tg=Object.getOwnPropertyDescriptor(p,'responseText')?.get,rg=Object.getOwnPropertyDescriptor(p,'response')?.get,cache=new WeakMap();if(tg)Object.defineProperty(p,'responseText',{configurable:true,get(){const raw=tg.call(this);if(!this.__folitynLRFilter||this.readyState!==4||typeof raw!=='string')return raw;let x=cache.get(this)||{};if(x.text===undefined)x.text=transformText(raw);cache.set(this,x);return x.text}});if(rg)Object.defineProperty(p,'response',{configurable:true,get(){const raw=rg.call(this);if(!this.__folitynLRFilter||this.readyState!==4)return raw;let x=cache.get(this)||{};if(this.responseType==='json'&&raw&&typeof raw==='object'){if(x.json===undefined){x.json=typeof structuredClone==='function'?structuredClone(raw):JSON.parse(JSON.stringify(raw));cleanup(x.json)}cache.set(this,x);return x.json}if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){if(x.text===undefined)x.text=transformText(raw);cache.set(this,x);return x.text}return raw}})}catch(e){console.warn('[Folityn physical corridors XHR]',e)}
})();
