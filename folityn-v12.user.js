// ==UserScript==
// @name         Folityn Schematic v12
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      12.0.0
// @description  Standalone Folityn schematic engine: one physical path per service, octilinear simplification, protected city corridors, and tram/bus/rail filters.
// @match        http://localhost:8888/*
// @match        http://127.0.0.1:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/folityn-v12.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/folityn-v12.user.js
// ==/UserScript==
(() => {
'use strict';

/*
  Folityn v12 design rules
  ------------------------
  1. Geometry belongs to physical corridors, NOT to direction variants.
  2. Same service in opposite directions is collapsed to ONE canonical map path.
  3. A one-way-only stop is kept only when it is close to that canonical path;
     otherwise its directional detour is ignored on the schematic.
  4. Generic geometry uses only 0/45/90 degree axes and deletes tiny stair-steps.
  5. Important Folityn corridors are imposed LAST, so new routes cannot reshape them.
  6. Native MTR rendering is kept: normal pan/zoom/click behavior remains available.
*/

const TARGET = /\/mtr\/api\/map\/stations-and-routes(?:\?|$)/;
const KEY = 'folityn-v12-';
const SETTINGS = {
  trams: () => localStorage.getItem(KEY + 'trams') !== '0',
  buses: () => localStorage.getItem(KEY + 'buses') !== '0',
  rail: () => localStorage.getItem(KEY + 'rail') !== '0',
  highSpeed: () => localStorage.getItem(KEY + 'highSpeed') !== '0',
  schematic: () => localStorage.getItem(KEY + 'schematic') !== '0',
};

const norm = s => String(s ?? '').trim().toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const clone = x => typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x));
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const dist = (a,b) => Math.hypot(b.x-a.x,b.z-a.z);
const lerp = (a,b,t) => ({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});
const median = a => { if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y),m=b.length>>1; return b.length%2?b[m]:(b[m-1]+b[m])/2; };
const angleDiff = (a,b) => { let d=Math.abs(a-b)%(Math.PI*2); if(d>Math.PI)d=2*Math.PI-d; if(d>Math.PI/2)d=Math.PI-d; return Math.abs(d); };
const oct = a => Math.round(a/(Math.PI/4))*(Math.PI/4);
const unitAngle = a => ({x:Math.cos(a),z:Math.sin(a)});
const pointLineDistance = (p,a,b) => {
  const vx=b.x-a.x,vz=b.z-a.z,L2=vx*vx+vz*vz;
  if(!L2) return dist(p,a);
  const t=clamp(((p.x-a.x)*vx+(p.z-a.z)*vz)/L2,0,1);
  return dist(p,{x:a.x+vx*t,z:a.z+vz*t});
};

function root(env){ return env?.data && typeof env.data==='object' ? env.data : env; }
function routeStops(r){ return Array.isArray(r?.stations)?r.stations:Array.isArray(r?.routeStations)?r.routeStations:Array.isArray(r?.platforms)?r.platforms:[]; }
function setRouteStops(r,arr){ if(Array.isArray(r?.stations))r.stations=arr; else if(Array.isArray(r?.routeStations))r.routeStations=arr; else if(Array.isArray(r?.platforms))r.platforms=arr; }
function stopId(s){ return String(s?.id ?? s?.hexId ?? s?.stationId ?? ''); }
function point(s){ const x=Number(s?.x??s?.position?.x),z=Number(s?.z??s?.position?.z); return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null; }
function setPoint(s,q){ if('x' in s || !s.position){s.x=q.x;s.z=q.z;}else{s.position={...s.position,x:q.x,z:q.z};} }
function routeName(r){ return String(r?.name ?? r?.routeName ?? r?.route_name ?? '').trim(); }
function routeType(r){ return norm(r?.type); }
function routeNumber(r){ const m=routeName(r).match(/\d+/); return m?Number(m[0]):null; }
function routeColor(r){ return String(r?.color ?? r?.routeColor ?? ''); }
function isLightRail(r){ const t=routeType(r); return t==='train_light_rail'||t==='light_rail'||t.includes('light_rail'); }
function isHighSpeed(r){ const t=routeType(r),n=norm(routeName(r)); return t.includes('high_speed')||t==='train_high_speed'||/^ic(?:_|$)/.test(n); }
function isNormalRail(r){ const t=routeType(r); return !isLightRail(r)&&!isHighSpeed(r)&&(t==='train_normal'||t==='rail'||t.includes('train_normal')); }
function classOf(r){
  if(isLightRail(r)){
    const n=routeNumber(r);
    if(Number.isFinite(n)&&n>=1&&n<=20)return'tram';
    if(Number.isFinite(n)&&n>=100)return'bus';
    return'light_other';
  }
  if(isHighSpeed(r))return'high_speed';
  if(isNormalRail(r))return'rail';
  return'other';
}
function serviceKey(r){
  const c=classOf(r),num=routeNumber(r),name=norm(routeName(r));
  const id = Number.isFinite(num) && (c==='tram'||c==='bus') ? String(num) : name;
  return `${c}|${id}|${routeColor(r)}`;
}

function stationNames(data){
  const m=new Map();
  for(const s of data.stations||[])m.set(String(s.id??s.hexId??s.stationId??''),String(s.name??''));
  return m;
}
function occurrences(data){
  const o=new Map();
  for(const r of data.routes||[])for(const s of routeStops(r)){
    const id=stopId(s),q=point(s);if(!id||!q)continue;
    if(!o.has(id))o.set(id,[]);o.get(id).push(q);
  }
  return o;
}
function coords(data){
  const o=occurrences(data),out=new Map();
  for(const[id,ps]of o)out.set(id,{x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))});
  return out;
}
function setAll(data,id,q){ if(!id||!q)return; for(const r of data.routes||[])for(const s of routeStops(r))if(stopId(s)===id)setPoint(s,q); }
function findId(names,cands){ const wanted=new Set(cands.map(norm)); for(const[id,n]of names)if(wanted.has(norm(n)))return id; return null; }

/* ---------- 1. collapse direction variants into one physical path ---------- */
function rawPathScore(route){
  const ps=routeStops(route).map(point).filter(Boolean); if(ps.length<2)return 1e9;
  let length=0,turns=0;
  for(let i=1;i<ps.length;i++)length+=dist(ps[i-1],ps[i]);
  const direct=Math.max(1,dist(ps[0],ps.at(-1)));
  for(let i=2;i<ps.length;i++){
    const a=Math.atan2(ps[i-1].z-ps[i-2].z,ps[i-1].x-ps[i-2].x),b=Math.atan2(ps[i].z-ps[i-1].z,ps[i].x-ps[i-1].x);
    const d=angleDiff(a,b); if(d>Math.PI/12)turns += d/(Math.PI/4);
  }
  return length/direct + turns*.08 + ps.length*.001;
}
function overlap(a,b){
  const A=new Set(routeStops(a).map(stopId).filter(Boolean)),B=new Set(routeStops(b).map(stopId).filter(Boolean));
  let inter=0;for(const x of A)if(B.has(x))inter++;
  return inter/Math.max(1,Math.min(A.size,B.size));
}
function orientedIds(route,baseIds){
  let ids=routeStops(route).map(stopId).filter(Boolean);const idx=new Map(baseIds.map((id,i)=>[id,i]));
  const common=ids.filter(id=>idx.has(id));
  if(common.length>=2 && idx.get(common[0])>idx.get(common.at(-1)))ids=[...ids].reverse();
  return ids;
}
function closestOnPolyline(q,ids,C){
  let total=0,segments=[];
  for(let i=1;i<ids.length;i++){
    const a=C.get(ids[i-1]),b=C.get(ids[i]);if(!a||!b)continue;
    const L=dist(a,b);segments.push({a,b,L,start:total,index:i-1});total+=L;
  }
  let best=null;
  for(const s of segments){
    const vx=s.b.x-s.a.x,vz=s.b.z-s.a.z,L2=vx*vx+vz*vz;
    const t=L2?clamp(((q.x-s.a.x)*vx+(q.z-s.a.z)*vz)/L2,0,1):0;
    const p={x:s.a.x+vx*t,z:s.a.z+vz*t},d=dist(q,p),along=s.start+s.L*t;
    if(!best||d<best.d)best={d,along,p,total,segment:s.index};
  }
  return best;
}
function canonicalizeDirections(data){
  const routes=data.routes||[],C=coords(data),groups=new Map();
  routes.forEach((r,i)=>{const c=classOf(r);if(c==='other')return;const k=serviceKey(r);if(!groups.has(k))groups.set(k,[]);groups.get(k).push({r,i});});
  const remove=new Set();let collapsed=0,attached=0,rejected=0;
  for(const entries of groups.values()){
    if(entries.length<2)continue;
    const remaining=new Set(entries.map((_,i)=>i));
    while(remaining.size){
      const first=remaining.values().next().value;remaining.delete(first);const cluster=[entries[first]];
      let changed=true;
      while(changed){changed=false;for(const j of [...remaining])if(cluster.some(e=>overlap(e.r,entries[j].r)>=.58)){cluster.push(entries[j]);remaining.delete(j);changed=true;}}
      if(cluster.length<2)continue;
      cluster.sort((a,b)=>rawPathScore(a.r)-rawPathScore(b.r));
      const winner=cluster[0],baseStops=routeStops(winner.r),baseIds=baseStops.map(stopId).filter(Boolean);
      if(baseIds.length<2)continue;
      const samples=new Map();for(const e of cluster)for(const s of routeStops(e.r)){const id=stopId(s);if(id&&!samples.has(id))samples.set(id,s);}
      const merged=[...baseIds],extras=[];
      for(const e of cluster.slice(1)){
        for(const id of orientedIds(e.r,baseIds))if(!merged.includes(id)){
          const q=C.get(id),near=q?closestOnPolyline(q,baseIds,C):null;
          const segLens=[];for(let i=1;i<baseIds.length;i++){const a=C.get(baseIds[i-1]),b=C.get(baseIds[i]);if(a&&b)segLens.push(dist(a,b));}
          const threshold=Math.max(110,Math.min(260,median(segLens)*1.15||150));
          if(near&&near.d<=threshold)extras.push({id,along:near.along});else rejected++;
        }
      }
      const baseAlong=new Map();let run=0;baseAlong.set(baseIds[0],0);for(let i=1;i<baseIds.length;i++){const a=C.get(baseIds[i-1]),b=C.get(baseIds[i]);run+=a&&b?dist(a,b):1;baseAlong.set(baseIds[i],run);}
      const ordered=[...baseIds.map(id=>({id,along:baseAlong.get(id)})),...extras].sort((a,b)=>a.along-b.along);
      const seen=new Set(),canonical=ordered.filter(x=>!seen.has(x.id)&&(seen.add(x.id),true)).map(x=>x.id);
      const arr=canonical.map(id=>clone(samples.get(id)||baseStops.find(s=>stopId(s)===id))).filter(Boolean);
      setRouteStops(winner.r,arr);attached+=extras.length;
      for(const e of cluster.slice(1))remove.add(e.i);
      collapsed+=cluster.length-1;
    }
  }
  data.routes=routes.filter((_,i)=>!remove.has(i));
  return{collapsed,attached,rejected};
}

/* ---------- 2. generic conservative octilinear simplifier ---------- */
function runFit(ids,C,maxAngle,maxPerp){
  if(ids.length<3)return null;const A=C.get(ids[0]),B=C.get(ids.at(-1));if(!A||!B)return null;
  const raw=Math.atan2(B.z-A.z,B.x-A.x),snap=oct(raw);if(angleDiff(raw,snap)>maxAngle)return null;
  const L=dist(A,B);if(L<45)return null;
  let perp=0;for(const id of ids.slice(1,-1)){const q=C.get(id);if(q)perp=Math.max(perp,pointLineDistance(q,A,B));}
  if(perp>Math.max(85,L*maxPerp))return null;
  const u=unitAngle(snap),proj=(B.x-A.x)*u.x+(B.z-A.z)*u.z;if(Math.abs(proj)<40)return null;
  return{A,u,proj};
}
function simplifyOctilinear(data){
  const C=coords(data),proposals=new Map();
  const add=(id,q)=>{if(!proposals.has(id))proposals.set(id,[]);proposals.get(id).push(q);};
  for(const r of data.routes||[]){
    const c=classOf(r);if(!['tram','bus','light_other','rail','high_speed'].includes(c))continue;
    const ids=routeStops(r).map(stopId).filter(id=>C.has(id));if(ids.length<3)continue;
    const maxA=(c==='tram'?18:c==='bus'?23:16)*Math.PI/180,maxP=c==='bus'?.30:.23;
    let i=0;
    while(i<ids.length-2){
      let best=-1,fit=null;
      for(let j=i+2;j<ids.length;j++){
        const f=runFit(ids.slice(i,j+1),C,maxA,maxP);if(f){best=j;fit=f;}else if(best>=0&&j-best>2)break;
      }
      if(best<0){i++;continue;}
      const chunk=ids.slice(i,best+1),ps=chunk.map(id=>C.get(id));let total=0,cum=[0];
      for(let k=1;k<ps.length;k++){total+=dist(ps[k-1],ps[k]);cum.push(total);}if(total){
        for(let k=1;k<chunk.length-1;k++){const t=cum[k]/total;add(chunk[k],{x:fit.A.x+fit.u.x*fit.proj*t,z:fit.A.z+fit.u.z*fit.proj*t});}
      }
      i=best;
    }
  }
  let moved=0;for(const[id,ps]of proposals){setAll(data,id,{x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))});moved++;}
  return moved;
}

/* ---------- 3. protected corridors: imposed LAST ---------- */
function placeAxis(data,names,orderedNames,angleMode='auto',spacingMode='raw',dbgKey='axis'){
  const ids=orderedNames.map(x=>findId(names,Array.isArray(x)?x:[x])).filter(Boolean);if(ids.length<2)return{key:dbgKey,ok:false};
  const C=coords(data),A=C.get(ids[0]);if(!A)return{key:dbgKey,ok:false};
  const rawTarget=C.get(ids.at(-1));if(!rawTarget)return{key:dbgKey,ok:false};
  let ang;
  if(typeof angleMode==='number')ang=angleMode;
  else if(angleMode==='horizontal')ang=Math.abs(rawTarget.x-A.x)>=Math.abs(rawTarget.z-A.z)?(rawTarget.x>=A.x?0:Math.PI):(rawTarget.z>=A.z?Math.PI/2:-Math.PI/2);
  else ang=oct(Math.atan2(rawTarget.z-A.z,rawTarget.x-A.x));
  if(angleMode==='diag'){
    const choices=[Math.PI/4,-Math.PI/4,3*Math.PI/4,-3*Math.PI/4],raw=Math.atan2(rawTarget.z-A.z,rawTarget.x-A.x);
    ang=choices.reduce((b,a)=>angleDiff(a,raw)<angleDiff(b,raw)?a:b,choices[0]);
  }
  const u=unitAngle(ang);let p={...A};setAll(data,ids[0],p);
  for(let i=1;i<ids.length;i++){
    const q0=C.get(ids[i-1]),q1=C.get(ids[i]);let step=q0&&q1?dist(q0,q1):110;
    if(spacingMode==='clean')step=clamp(step,85,145);else step=clamp(step,65,210);
    p={x:p.x+u.x*step,z:p.z+u.z*step};setAll(data,ids[i],p);
  }
  return{key:dbgKey,ok:true,ids};
}
function flattenRoutesBetween(data,aId,bId,A,B,nearOnly=false){
  if(!aId||!bId||!A||!B)return 0;let moved=0;
  for(const r of data.routes||[]){
    const ss=routeStops(r),ids=ss.map(stopId),ia=ids.indexOf(aId),ib=ids.indexOf(bId);if(ia<0||ib<0||ia===ib)continue;
    const lo=Math.min(ia,ib),hi=Math.max(ia,ib),seg=ss.slice(lo,hi+1),forward=ia<ib;
    const candidates=[];for(let i=0;i<seg.length;i++){const id=stopId(seg[i]),q=point(seg[i]);if(!id||!q)continue;if(nearOnly&&pointLineDistance(q,A,B)>220)continue;candidates.push({id,q,index:i});}
    let total=0,cum=[0];for(let i=1;i<candidates.length;i++){total+=dist(candidates[i-1].q,candidates[i].q);cum.push(total);}if(!total)total=Math.max(1,candidates.length-1);
    for(let i=1;i<candidates.length-1;i++){let t=cum[i]/total;if(!forward)t=1-t;setAll(data,candidates[i].id,lerp(A,B,t));moved++;}
  }
  return moved;
}
function lockWzgorzyn(data,names){
  const ordered=[['Wzgórzyn PKM','Wzgorzyn PKM'],['Rakoniewicka'],['Astrolitowska'],['Końcowa','Koncowa']];
  const result=placeAxis(data,names,ordered,'diag','clean','wzgorzyn');
  if(result.ok){const C=coords(data),a=result.ids[0],b=result.ids.at(-1);flattenRoutesBetween(data,a,b,C.get(a),C.get(b),false);}
  return result;
}
function lockMuzea(data,names){
  const a=findId(names,['Rondo Larcho']),b=findId(names,['Muzea']);if(!a||!b)return{ok:false};
  const C0=coords(data),A=C0.get(a),B0=C0.get(b);if(!A||!B0)return{ok:false};
  const choices=[Math.PI/4,-Math.PI/4,3*Math.PI/4,-3*Math.PI/4],raw=Math.atan2(B0.z-A.z,B0.x-A.x),ang=choices.reduce((best,x)=>angleDiff(x,raw)<angleDiff(best,raw)?x:best,choices[0]),u=unitAngle(ang),L=clamp(dist(A,B0),300,900),B={x:A.x+u.x*L,z:A.z+u.z*L};
  setAll(data,b,B);const moved=flattenRoutesBetween(data,a,b,A,B,false);return{ok:true,moved};
}
function lockDrzewiec(data,names){
  const a=findId(names,['Rynek Wielowicki']),b=findId(names,['Drzewiec PKM']);if(!a||!b)return{ok:false};
  const C=coords(data),A=C.get(a),rawB=C.get(b);if(!A||!rawB)return{ok:false};
  const raw=Math.atan2(rawB.z-A.z,rawB.x-A.x),choices=[Math.PI/4,-Math.PI/4,3*Math.PI/4,-3*Math.PI/4],ang=choices.reduce((best,x)=>angleDiff(x,raw)<angleDiff(best,raw)?x:best,choices[0]),u=unitAngle(ang),L=clamp(dist(A,rawB),350,1000),B={x:A.x+u.x*L,z:A.z+u.z*L};
  setAll(data,b,B);const moved=flattenRoutesBetween(data,a,b,A,B,false);return{ok:true,moved};
}
function lockRogowska(data,names){
  const ordered=[['Rogowska Centrum Miejskie'],['Witkowskiego'],['Rogowska/Dąbka','Rogowska/Dabka'],['Rogowska'],['Szwedzka/Norweska','Szwedzka Norweska']];
  const r=placeAxis(data,names,ordered,'diag','clean','rogowska');
  if(!r.ok)return r;
  const nor=r.ids.at(-1),stad=findId(names,['Szwedzka Stadion']);if(stad){const C=coords(data),N=C.get(nor),S=C.get(stad);if(N&&S){const q=Math.abs(N.x-S.x)<Math.abs(N.z-S.z)?{x:S.x,z:N.z}:{x:N.x,z:S.z};setAll(data,nor,q);}}
  return r;
}
function lockRynek(data,names){
  const a=findId(names,['Aleje Osamasona']),st=findId(names,['Stare Miasto']),mu=findId(names,['Muzeum Narodowa']),kr=findId(names,['Królewska','Krolewska']),ka=findId(names,['Katedra']);
  const C=coords(data),A=C.get(a),K=C.get(ka);if(!a||!st||!mu||!kr||!ka||!A||!K)return{ok:false};
  const vx=K.x-A.x,vz=K.z-A.z,L=Math.max(180,Math.hypot(vx,vz)),u={x:vx/L,z:vz/L},p={x:-u.z,z:u.x};
  const rawMu=C.get(mu),cross=rawMu?Math.sign(vx*(rawMu.z-A.z)-vz*(rawMu.x-A.x))||1:1,h=clamp(L*.28,90,190),n={x:p.x*cross,z:p.z*cross};
  setAll(data,st,{x:A.x+u.x*L*.53,z:A.z+u.z*L*.53});
  setAll(data,mu,{x:A.x+u.x*L*.30+n.x*h,z:A.z+u.z*L*.30+n.z*h});
  setAll(data,kr,{x:A.x+u.x*L*.70+n.x*h,z:A.z+u.z*L*.70+n.z*h});
  return{ok:true};
}
function mergeStationAliases(data,names){
  let merged=0;
  const buckets=new Map();for(const[id,n]of names){const k=norm(n);if(!k)continue;if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(id);}
  const C=coords(data);for(const ids of buckets.values())if(ids.length>1){const ps=ids.map(id=>C.get(id)).filter(Boolean);if(!ps.length)continue;const q={x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))};ids.forEach(id=>setAll(data,id,q));merged+=ids.length-1;}
  const wity=[findId(names,['Folityn Wity']),findId(names,['Wity PKM'])].filter(Boolean);if(wity.length===2){const C2=coords(data),ps=wity.map(id=>C2.get(id)).filter(Boolean);if(ps.length===2){const q={x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))};wity.forEach(id=>setAll(data,id,q));merged++;}}
  return merged;
}
function applyProtected(data){
  const names=stationNames(data),dbg={};
  dbg.wzgorzyn=lockWzgorzyn(data,names);
  dbg.muzea=lockMuzea(data,names);
  dbg.drzewiec=lockDrzewiec(data,names);
  dbg.rogowska=lockRogowska(data,names);
  dbg.rynek=lockRynek(data,names);
  dbg.mergedStations=mergeStationAliases(data,names);
  window.__folitynV12Corridors=dbg;
}

/* ---------- filters + pipeline ---------- */
function filterRoutes(data){
  data.routes=(data.routes||[]).filter(r=>{
    const c=classOf(r);
    if(c==='tram')return SETTINGS.trams();
    if(c==='bus')return SETTINGS.buses();
    if(c==='rail')return SETTINGS.rail();
    if(c==='high_speed')return SETTINGS.highSpeed();
    return true;
  });
}
function transformEnvelope(env){
  if(!env||typeof env!=='object')return env;const data=root(env);if(!data||!Array.isArray(data.routes))return env;
  filterRoutes(data);
  const debug={beforeCanonical:data.routes.length};
  if(SETTINGS.schematic()){
    debug.directionCollapse=canonicalizeDirections(data);
    debug.afterCanonical=data.routes.length;
    debug.genericMoved=simplifyOctilinear(data);
    applyProtected(data);
  }
  data.routes.sort((a,b)=>serviceKey(a).localeCompare(serviceKey(b))||routeName(a).localeCompare(routeName(b)));
  window.__folitynV12Debug=debug;
  return env;
}
function transformText(text){try{return JSON.stringify(transformEnvelope(JSON.parse(text)));}catch(e){console.warn('[Folityn v12] transform failed',e);return text;}}

/* ---------- network hooks ---------- */
const nativeFetch=window.fetch.bind(window);
window.fetch=async function(input,init){
  const url=typeof input==='string'?input:input?.url||'',res=await nativeFetch(input,init);if(!TARGET.test(url))return res;
  try{return new Response(transformText(await res.clone().text()),{status:res.status,statusText:res.statusText,headers:res.headers});}catch(e){console.warn('[Folityn v12] fetch hook',e);return res;}
};
try{
  const p=XMLHttpRequest.prototype,open=p.open,tg=Object.getOwnPropertyDescriptor(p,'responseText')?.get,rg=Object.getOwnPropertyDescriptor(p,'response')?.get,cache=new WeakMap();
  p.open=function(method,url,...rest){this.__folitynV12=TARGET.test(String(url));cache.delete(this);return open.call(this,method,url,...rest);};
  if(tg)Object.defineProperty(p,'responseText',{configurable:true,get(){const raw=tg.call(this);if(!this.__folitynV12||this.readyState!==4||typeof raw!=='string')return raw;let x=cache.get(this)||{};if(x.text===undefined)x.text=transformText(raw);cache.set(this,x);return x.text;}});
  if(rg)Object.defineProperty(p,'response',{configurable:true,get(){const raw=rg.call(this);if(!this.__folitynV12||this.readyState!==4)return raw;let x=cache.get(this)||{};if(this.responseType==='json'&&raw&&typeof raw==='object'){if(x.json===undefined){x.json=clone(raw);transformEnvelope(x.json);}cache.set(this,x);return x.json;}if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){if(x.text===undefined)x.text=transformText(raw);cache.set(this,x);return x.text;}return raw;}});
}catch(e){console.warn('[Folityn v12] XHR hook',e);}

/* ---------- compact controls ---------- */
function setSetting(k,on){localStorage.setItem(KEY+k,on?'1':'0');location.reload();}
function toggle(label,k,icon){
  const on=SETTINGS[k](),b=document.createElement('button');b.type='button';b.className='folv12-toggle '+(on?'on':'off');b.innerHTML=`<span>${icon}</span><span>${label}</span><b>${on?'ON':'OFF'}</b>`;b.onclick=()=>setSetting(k,!on);return b;
}
function findAnchor(){
  const all=[...document.querySelectorAll('app-map *, app-root *, body *')];return all.find(el=>el.children.length<=2&&el.textContent?.trim()==='Light Rail')||null;
}
function mount(){
  if(!document.body)return setTimeout(mount,50);if(document.getElementById('folityn-v12-controls'))return;
  const style=document.createElement('style');style.textContent=`#folityn-v12-controls{font:12px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;background:#101827;color:#e7eef8;border:1px solid #344258;border-radius:9px;padding:8px;display:grid;gap:5px;min-width:185px;box-shadow:0 6px 20px #0008;z-index:2147483646}.folv12-title{font-weight:800;letter-spacing:.05em;color:#9fb0c7;padding:1px 3px 3px}.folv12-toggle{display:grid;grid-template-columns:22px 1fr auto;gap:6px;align-items:center;border:1px solid #344258;border-radius:7px;background:#162033;color:#e7eef8;padding:7px 8px;cursor:pointer;text-align:left}.folv12-toggle.off{opacity:.52}.folv12-toggle.on{background:#1b2a41}.folv12-toggle b{font-size:9px;color:#9fb0c7}.folv12-note{font-size:9px;color:#8ea0b9;padding:2px 4px}#folityn-v12-controls.float{position:fixed;right:18px;top:240px}`;document.head.appendChild(style);
  const box=document.createElement('div');box.id='folityn-v12-controls';box.innerHTML='<div class="folv12-title">FOLITYN V12</div>';
  box.append(toggle('Trams 1–20','trams','🚋'),toggle('Buses 100+','buses','🚌'),toggle('Normal rail','rail','🚆'),toggle('High speed / IC','highSpeed','🚄'),toggle('Schematic','schematic','↗'));
  const note=document.createElement('div');note.className='folv12-note';note.textContent='One physical path per service';box.appendChild(note);
  const anchor=findAnchor();if(anchor?.parentElement){box.style.margin='7px 0 8px 28px';anchor.insertAdjacentElement('afterend',box);}else{box.classList.add('float');document.body.appendChild(box);}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
new MutationObserver(()=>{if(!document.getElementById('folityn-v12-controls'))mount();}).observe(document.documentElement,{childList:true,subtree:true});

window.__folitynV12Active=true;
})();
