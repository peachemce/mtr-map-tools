// ==UserScript==
// @name         Folityn MTR Map Tools
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.8.1
// @description  Explicit 11.3 base + 11.7.1 corridor patches + protected schematic zones.
// @match        http://localhost:8888/*
// @match        http://127.0.0.1:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @require      https://raw.githubusercontent.com/peachemce/mtr-map-tools/e898fefccbed81c38c1fa0ef1e07b67aa6469760/connector-reroll.user.js
// @require      https://raw.githubusercontent.com/peachemce/mtr-map-tools/4649156d1411622c09ad40668bfcb1ada5c07906/connector-reroll.user.js
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
const root=e=>e?.data&&typeof e.data==='object'?e.data:e;
const dist=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});
const add=(a,b,s=1)=>({x:a.x+b.x*s,z:a.z+b.z*s});
const sub=(a,b)=>({x:a.x-b.x,z:a.z-b.z});
const dot=(a,b)=>a.x*b.x+a.z*b.z;
const unit=(a,b)=>{const d=dist(a,b)||1;return{x:(b.x-a.x)/d,z:(b.z-a.z)/d}};
const perp=(u,sgn=1)=>({x:-u.z*sgn,z:u.x*sgn});
function namesById(d){const m=new Map();for(const s of d?.stations||[])m.set(String(s.id??s.hexId??s.stationId??''),String(s.name??''));return m}
function coords(d){const o=new Map();for(const r of d.routes||[])for(const s of stops(r)){const id=sid(s),q=pt(s);if(!id||!q)continue;if(!o.has(id))o.set(id,[]);o.get(id).push(q)}const out=new Map();for(const[id,ps]of o){const xs=ps.map(p=>p.x).sort((a,b)=>a-b),zs=ps.map(p=>p.z).sort((a,b)=>a-b),m=xs.length>>1;out.set(id,{x:xs.length%2?xs[m]:(xs[m-1]+xs[m])/2,z:zs.length%2?zs[m]:(zs[m-1]+zs[m])/2})}return out}
function find(names,cands){const w=new Set(cands.map(norm));for(const[id,n]of names)if(w.has(norm(n)))return id;return null}
function item(names,C,cands){const id=find(names,cands);return id?{id,q:C.get(id)}:null}
function setAll(d,id,q){if(!id||!q)return;for(const r of d.routes||[])for(const s of stops(r))if(sid(s)===id)put(s,q)}

// 1) EAST STREET: one physical 45-degree Rogowska corridor.
// Charlińska and Soperka are one-way stops on the SAME street; they may never create loops.
function lockEast(d,names,C,dbg){
  const rcm=item(names,C,['Rogowska Centrum Miejskie']),dab=item(names,C,['Rogowska/Dąbka','Rogowska/Dabka']);
  const rog=item(names,C,['Rogowska']),cha=item(names,C,['Charlińska','Charlinska']),sop=item(names,C,['Soperka']);
  const nor=item(names,C,['Szwedzka/Norweska','Szwedzka Norweska']),stad=item(names,C,['Szwedzka Stadion']);
  if(!rcm?.q||!dab?.q||!rog?.id||!nor?.id){dbg.east='missing anchors';return}
  let sx=Math.sign(dab.q.x-rcm.q.x)||1,sz=Math.sign(dab.q.z-rcm.q.z)||1;const u={x:sx*Math.SQRT1_2,z:sz*Math.SQRT1_2};
  let tEnd=stad?.q?(stad.q.x-dab.q.x)/u.x:NaN;if(!Number.isFinite(tEnd)||tEnd<160)tEnd=Math.max(260,Math.abs(dot(sub(nor.q||rog.q,dab.q),u)));
  const end={x:dab.q.x+u.x*tEnd,z:dab.q.z+u.z*tEnd};if(stad?.q)end.x=stad.q.x;
  for(const[x,t]of [[rog,.34],[cha,.54],[sop,.73],[nor,1]])if(x?.id)setAll(d,x.id,lerp(dab.q,end,t));
  dbg.east={ok:true,shape:'one 45-degree street',grochowaUsed:false};
}

// 2) WZGÓRZYN: never fall back to horizontal/vertical MTR stair-steps mid-corridor.
function lockWzgorzyn(d,names,C,dbg){
  const a=item(names,C,['Wzgórzyn PKM','Wzgorzyn PKM']),r=item(names,C,['Rakoniewicka']),s=item(names,C,['Astrolitowska']),k=item(names,C,['Końcowa','Koncowa']);
  if(!a?.q||!k?.q){dbg.wzgorzyn='missing anchors';return}
  let sx=Math.sign(k.q.x-a.q.x)||1,sz=Math.sign(k.q.z-a.q.z)||1;const u={x:sx*Math.SQRT1_2,z:sz*Math.SQRT1_2};let t=dot(sub(k.q,a.q),u);if(!Number.isFinite(t)||t<140)t=Math.max(180,dist(a.q,k.q));const end=add(a.q,u,t);
  const d1=r?.q?dist(a.q,r.q):1,d2=s?.q&&r?.q?dist(r.q,s.q):1,d3=s?.q?dist(s.q,k.q):1,total=d1+d2+d3;
  if(r?.id)setAll(d,r.id,lerp(a.q,end,clamp(d1/total,.18,.46)));
  if(s?.id)setAll(d,s.id,lerp(a.q,end,clamp((d1+d2)/total,.54,.82)));
  setAll(d,k.id,end);dbg.wzgorzyn={ok:true,shape:'one 45-degree corridor'};
}

// 3) RYNEK: stable two-branch diamond. Route count must not flatten the loop.
function lockRynek(d,names,C,dbg){
  const a=item(names,C,['Aleje Osamasona']),st=item(names,C,['Stare Miasto']),mu=item(names,C,['Muzeum Narodowa']),kr=item(names,C,['Królewska','Krolewska']),ka=item(names,C,['Katedra']);
  if(!a?.q||!ka?.q||!st?.id||!mu?.id||!kr?.id){dbg.rynek='missing anchors';return}
  const u=unit(a.q,ka.q),L=Math.max(180,dist(a.q,ka.q)),raw=mu.q||a.q,cross=(ka.q.x-a.q.x)*(raw.z-a.q.z)-(ka.q.z-a.q.z)*(raw.x-a.q.x),p=perp(u,cross>=0?1:-1),h=clamp(L*.28,85,210);
  setAll(d,st.id,add(a.q,u,L*.53));
  setAll(d,mu.id,add(add(a.q,u,L*.31),p,h));
  setAll(d,kr.id,add(add(a.q,u,L*.70),p,h));
  dbg.rynek={ok:true,shape:'protected diamond',height:h};
}

// 4) Purple Grochowa/Blask area: do not invent a little vertical dog-leg at Blask.
// Keep Blask on the continuation of the approach into Grochowa whenever both exist.
function lockBlask(d,names,C,dbg){
  const dab=item(names,C,['Rogowska/Dąbka','Rogowska/Dabka']),gro=item(names,C,['Grochowa']),bla=item(names,C,['Blask']);
  if(!dab?.q||!gro?.q||!bla?.id){dbg.blask='missing anchors';return}
  const u=unit(dab.q,gro.q),rawLen=Math.max(55,dist(gro.q,bla.q));
  const target=add(gro.q,u,rawLen);setAll(d,bla.id,target);dbg.blask={ok:true,shape:'continue approach, no dog-leg'};
}

function protect(o){const d=root(o);if(!d||!Array.isArray(d.routes))return o;const names=namesById(d),dbg={};let C=coords(d);lockEast(d,names,C,dbg);C=coords(d);lockWzgorzyn(d,names,C,dbg);C=coords(d);lockRynek(d,names,C,dbg);C=coords(d);lockBlask(d,names,C,dbg);window.__folitynProtectedZonesDebug=dbg;return o}
function text(t){try{return JSON.stringify(protect(JSON.parse(t)))}catch(e){console.warn('[Folityn protected zones]',e);return t}}

// Base 11.3 and 11.7.1 have already transformed the API response. We run LAST.
const priorFetch=window.fetch.bind(window);window.fetch=async function(input,init){const url=typeof input==='string'?input:input?.url||'',r=await priorFetch(input,init);if(!TARGET.test(url))return r;try{return new Response(text(await r.clone().text()),{status:r.status,statusText:r.statusText,headers:r.headers})}catch(e){console.warn('[Folityn protected zones fetch]',e);return r}};
try{const p=XMLHttpRequest.prototype,tg=Object.getOwnPropertyDescriptor(p,'responseText')?.get,rg=Object.getOwnPropertyDescriptor(p,'response')?.get,cache=new WeakMap();if(tg)Object.defineProperty(p,'responseText',{configurable:true,get(){const raw=tg.call(this);if(!this.__folitynLRFilter||this.readyState!==4||typeof raw!=='string')return raw;let x=cache.get(this)||{};if(x.text===undefined)x.text=text(raw);cache.set(this,x);return x.text}});if(rg)Object.defineProperty(p,'response',{configurable:true,get(){const raw=rg.call(this);if(!this.__folitynLRFilter||this.readyState!==4)return raw;let x=cache.get(this)||{};if(this.responseType==='json'&&raw&&typeof raw==='object'){if(x.json===undefined){x.json=typeof structuredClone==='function'?structuredClone(raw):JSON.parse(JSON.stringify(raw));protect(x.json)}cache.set(this,x);return x.json}if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){if(x.text===undefined)x.text=text(raw);cache.set(this,x);return x.text}return raw}})}catch(e){console.warn('[Folityn protected zones XHR]',e)}
})();