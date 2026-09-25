// ==UserScript==
// @name         Folityn MTR Map Tools
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.8.3
// @description  11.3 base + one-way fixes + protected corridors with coherent Koncowa continuations.
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
const unit=(a,b)=>{const d=dist(a,b)||1;return{x:(b.x-a.x)/d,z:(b.z-a.z)/d}};
const perp=(u,sgn=1)=>({x:-u.z*sgn,z:u.x*sgn});
const rotate=(q,c,a)=>{const x=q.x-c.x,z=q.z-c.z,ca=Math.cos(a),sa=Math.sin(a);return{x:c.x+x*ca-z*sa,z:c.z+x*sa+z*ca}};
function namesById(d){const m=new Map();for(const s of d?.stations||[])m.set(String(s.id??s.hexId??s.stationId??''),String(s.name??''));return m}
function coords(d){const o=new Map();for(const r of d.routes||[])for(const s of stops(r)){const id=sid(s),q=pt(s);if(!id||!q)continue;if(!o.has(id))o.set(id,[]);o.get(id).push(q)}const out=new Map();for(const[id,ps]of o){const xs=ps.map(p=>p.x).sort((a,b)=>a-b),zs=ps.map(p=>p.z).sort((a,b)=>a-b),m=xs.length>>1;out.set(id,{x:xs.length%2?xs[m]:(xs[m-1]+xs[m])/2,z:zs.length%2?zs[m]:(zs[m-1]+zs[m])/2})}return out}
function find(names,cands){const w=new Set(cands.map(norm));for(const[id,n]of names)if(w.has(norm(n)))return id;return null}
function item(names,C,cands){const id=find(names,cands);return id?{id,q:C.get(id)}:null}
function setAll(d,id,q){if(!id||!q)return;for(const r of d.routes||[])for(const s of stops(r))if(sid(s)===id)put(s,q)}
function isLR(r){const t=norm(r?.type);return t==='train_light_rail'||t==='light_rail'||t.includes('light_rail')}

function flattenBetween(d,aId,bId,A,B){
  if(!aId||!bId||!A||!B)return 0;let moved=0;
  for(const r of d.routes||[]){
    const ss=stops(r),ids=ss.map(sid);let ia=ids.indexOf(aId),ib=ids.indexOf(bId);if(ia<0||ib<0||ia===ib)continue;
    const lo=Math.min(ia,ib),hi=Math.max(ia,ib),path=ss.slice(lo,hi+1),forward=ia<ib;
    const ps=path.map(pt);let total=0,cum=[0];for(let i=1;i<path.length;i++){total+=ps[i-1]&&ps[i]?dist(ps[i-1],ps[i]):1;cum.push(total)}if(!total)total=Math.max(1,path.length-1);
    for(let i=1;i<path.length-1;i++){const t0=cum[i]/total,t=forward?t0:1-t0,id=sid(path[i]);if(!id)continue;setAll(d,id,lerp(A,B,clamp(t,.04,.96)));moved++}
  }
  return moved;
}
function routeSegments(d,aId,bId){
  const out=[],seen=new Set();
  for(const r of d.routes||[]){if(!isLR(r))continue;const ids=stops(r).map(sid).filter(Boolean),ia=ids.indexOf(aId),ib=ids.indexOf(bId);if(ia<0||ib<0||ia===ib)continue;const seg=ia<ib?ids.slice(ia,ib+1):ids.slice(ib,ia+1).reverse(),key=seg.join('>');if(!seen.has(key)){seen.add(key);out.push(seg)}}
  return out;
}
function polyPoint(points,t){
  const lens=[];let total=0;for(let i=1;i<points.length;i++){const L=dist(points[i-1],points[i]);lens.push(L);total+=L}if(!total)return points[0];let x=clamp(t,0,1)*total;
  for(let i=0;i<lens.length;i++){if(x<=lens[i]||i===lens.length-1)return lerp(points[i],points[i+1],lens[i]?x/lens[i]:0);x-=lens[i]}
  return points.at(-1);
}
function placeIdsOnPolyline(d,ids,points,skip=new Set()){
  if(ids.length<2)return;for(let i=1;i<ids.length-1;i++){const id=ids[i];if(skip.has(id))continue;setAll(d,id,polyPoint(points,i/(ids.length-1)))}
}

function lockEast(d,names,C,dbg){
  const rog=item(names,C,['Rogowska']),nor=item(names,C,['Szwedzka/Norweska','Szwedzka Norweska']),stad=item(names,C,['Szwedzka Stadion']);
  if(!rog?.q||!nor?.id){dbg.east='missing anchors';return}
  let sx=Math.sign((stad?.q?.x??nor.q.x)-rog.q.x)||1,sz=Math.sign(nor.q.z-rog.q.z)||1;let dx=stad?.q?Math.abs(stad.q.x-rog.q.x):Math.abs(nor.q.x-rog.q.x);dx=Math.max(220,dx);
  const end={x:rog.q.x+sx*dx,z:rog.q.z+sz*dx};if(stad?.q)end.x=stad.q.x;setAll(d,nor.id,end);const moved=flattenBetween(d,rog.id,nor.id,rog.q,end);dbg.east={ok:true,movedIntermediates:moved};
}

function lockWzgorzynAndKoncowa(d,names,C,dbg){
  const a=item(names,C,['Wzgórzyn PKM','Wzgorzyn PKM']),r=item(names,C,['Rakoniewicka']),s=item(names,C,['Astrolitowska']),k=item(names,C,['Końcowa','Koncowa']),kob=item(names,C,['Kobylskiego']);
  if(!a?.q||!r?.q||!s?.id||!k?.id){dbg.wzgorzyn='missing anchors';return}
  const oldA={...a.q},oldR={...r.q},oldK={...k.q};let sx=Math.sign(r.q.x-a.q.x)||1,sz=Math.sign(r.q.z-a.q.z)||1;const u={x:sx*Math.SQRT1_2,z:sz*Math.SQRT1_2};
  const step1=clamp(dist(a.q,r.q),70,145),step2=clamp(s.q?dist(r.q,s.q):115,85,170),step3=clamp(s.q?dist(s.q,k.q):115,85,170);
  const R=add(a.q,u,step1),S=add(R,u,step2),K=add(S,u,step3);setAll(d,r.id,R);setAll(d,s.id,S);setAll(d,k.id,K);flattenBetween(d,a.id,k.id,a.q,K);

  // Rotate local route continuations around the OLD Koncowa so everything attached to the corridor
  // follows the same schematic rotation instead of snapping back to old MTR geography.
  const oldAng=Math.atan2(oldR.z-oldA.z,oldR.x-oldA.x),newAng=Math.atan2(u.z,u.x),delta=newAng-oldAng;
  const corridorIds=new Set([a.id,r.id,s.id,k.id]);for(const seg of routeSegments(d,a.id,k.id))for(const id of seg)corridorIds.add(id);
  const touched=new Set();
  for(const route of d.routes||[]){if(!isLR(route))continue;const ids=stops(route).map(sid).filter(Boolean),ik=ids.indexOf(k.id);if(ik<0)continue;
    const before=ids.slice(0,ik),after=ids.slice(ik+1),beforeCorr=before.some(id=>corridorIds.has(id)),afterCorr=after.some(id=>corridorIds.has(id));
    const moveSide=list=>{for(const id of list.slice(0,6)){if(corridorIds.has(id)||touched.has(id))continue;const q=C.get(id);if(!q)continue;const rq=rotate(q,oldK,delta),target={x:K.x+(rq.x-oldK.x),z:K.z+(rq.z-oldK.z)};setAll(d,id,target);touched.add(id)}};
    if(beforeCorr&&!afterCorr)moveSide(after);
    else if(afterCorr&&!beforeCorr)moveSide([...before].reverse());
    else if(!beforeCorr&&!afterCorr){moveSide(after);moveSide([...before].reverse())}
  }

  // Blue directional pair: the short/upper variant continues the SAME 45-degree axis.
  // The longer/lower variant is intentionally a clean down-across-back-up loop.
  let blue={variants:0};
  if(kob?.id){
    const variants=routeSegments(d,k.id,kob.id).sort((x,y)=>x.length-y.length);blue.variants=variants.length;
    if(variants.length){
      const upper=variants[0],fresh=coords(d);let p=K;const upperSet=new Set(upper);for(let i=1;i<upper.length;i++){const q0=fresh.get(upper[i]),q1=fresh.get(upper[i-1]);const step=clamp(q0&&q1?dist(q0,q1):105,75,125);p=add(p,u,step);setAll(d,upper[i],p)}
      const KOB=p;blue.upperStops=upper.length;
      const lower=variants.at(-1),different=lower&&lower.join('>')!==upper.join('>');
      if(different&&lower.length>2){
        const fresh2=coords(d),internal=lower.slice(1,-1),cent=internal.map(id=>fresh2.get(id)).filter(Boolean);let sign=1;if(cent.length){const avg={x:cent.reduce((s,q)=>s+q.x,0)/cent.length,z:cent.reduce((s,q)=>s+q.z,0)/cent.length},cross=u.x*(avg.z-K.z)-u.z*(avg.x-K.x);sign=Math.sign(cross)||1}
        const n=perp(u,sign),L=dist(K,KOB),depth=clamp(170+lower.length*13,210,430),B=add(add(K,u,L*.24),n,depth),C2=add(add(K,u,L*.76),n,depth);placeIdsOnPolyline(d,lower,[K,B,C2,KOB],upperSet);blue.lowerStops=lower.length;blue.lowerDepth=depth;
      }
    }
  }
  dbg.wzgorzyn={ok:true,axis:'Wzgorzyn-Rakoniewicka fixed 45',rotatedContinuationStops:touched.size,blue};
}

function lockDrzewiec(d,names,C,dbg){
  const a=item(names,C,['WOS','WOS Boisko']),b=item(names,C,['Drzewiec PKM']);if(!a?.q||!b?.q){dbg.drzewiec='missing WOS/Drzewiec anchors';return}
  const moved=flattenBetween(d,a.id,b.id,a.q,b.q);dbg.drzewiec={ok:true,shape:'single direct corridor',movedIntermediates:moved};
}

function lockRynek(d,names,C,dbg){
  const a=item(names,C,['Aleje Osamasona']),st=item(names,C,['Stare Miasto']),mu=item(names,C,['Muzeum Narodowa']),kr=item(names,C,['Królewska','Krolewska']),ka=item(names,C,['Katedra']);
  if(!a?.q||!ka?.q||!st?.id||!mu?.id||!kr?.id){dbg.rynek='missing anchors';return}
  const u=unit(a.q,ka.q),L=Math.max(180,dist(a.q,ka.q)),raw=mu.q||a.q,cross=(ka.q.x-a.q.x)*(raw.z-a.q.z)-(ka.q.z-a.q.z)*(raw.x-a.q.x),p=perp(u,cross>=0?1:-1),h=clamp(L*.28,85,210);
  setAll(d,st.id,add(a.q,u,L*.53));setAll(d,mu.id,add(add(a.q,u,L*.31),p,h));setAll(d,kr.id,add(add(a.q,u,L*.70),p,h));dbg.rynek={ok:true,shape:'protected diamond',height:h};
}
function lockBlask(d,names,C,dbg){
  const dab=item(names,C,['Rogowska/Dąbka','Rogowska/Dabka']),gro=item(names,C,['Grochowa']),bla=item(names,C,['Blask']);if(!dab?.q||!gro?.q||!bla?.id){dbg.blask='missing anchors';return}
  const u=unit(dab.q,gro.q),rawLen=Math.max(55,dist(gro.q,bla.q));setAll(d,bla.id,add(gro.q,u,rawLen));dbg.blask={ok:true};
}
function protect(o){
  const d=root(o);if(!d||!Array.isArray(d.routes))return o;const names=namesById(d),dbg={};let C=coords(d);lockEast(d,names,C,dbg);C=coords(d);lockWzgorzynAndKoncowa(d,names,C,dbg);C=coords(d);lockDrzewiec(d,names,C,dbg);C=coords(d);lockRynek(d,names,C,dbg);C=coords(d);lockBlask(d,names,C,dbg);window.__folitynProtectedZonesDebug=dbg;return o
}
function text(t){try{return JSON.stringify(protect(JSON.parse(t)))}catch(e){console.warn('[Folityn protected zones]',e);return t}}
const priorFetch=window.fetch.bind(window);window.fetch=async function(input,init){const url=typeof input==='string'?input:input?.url||'',r=await priorFetch(input,init);if(!TARGET.test(url))return r;try{return new Response(text(await r.clone().text()),{status:r.status,statusText:r.statusText,headers:r.headers})}catch(e){console.warn('[Folityn protected zones fetch]',e);return r}};
try{const p=XMLHttpRequest.prototype,tg=Object.getOwnPropertyDescriptor(p,'responseText')?.get,rg=Object.getOwnPropertyDescriptor(p,'response')?.get,cache=new WeakMap();if(tg)Object.defineProperty(p,'responseText',{configurable:true,get(){const raw=tg.call(this);if(!this.__folitynLRFilter||this.readyState!==4||typeof raw!=='string')return raw;let x=cache.get(this)||{};if(x.text===undefined)x.text=text(raw);cache.set(this,x);return x.text}});if(rg)Object.defineProperty(p,'response',{configurable:true,get(){const raw=rg.call(this);if(!this.__folitynLRFilter||this.readyState!==4)return raw;let x=cache.get(this)||{};if(this.responseType==='json'&&raw&&typeof raw==='object'){if(x.json===undefined){x.json=typeof structuredClone==='function'?structuredClone(raw):JSON.parse(JSON.stringify(raw));protect(x.json)}cache.set(this,x);return x.json}if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){if(x.text===undefined)x.text=text(raw);cache.set(this,x);return x.text}return raw}})}catch(e){console.warn('[Folityn protected zones XHR]',e)}
})();