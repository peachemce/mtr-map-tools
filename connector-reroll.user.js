// ==UserScript==
// @name         MTR Map Tools - Tram / Bus Filters + Shared Schematic Corridors
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.3.0
// @description  Native MTR map with tram/bus filters, schematic simplification, and corridor inheritance between nearby routes.
// @match        http://localhost:8888/*
// @match        http://127.0.0.1:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==
(() => {
'use strict';

const TARGET=/\/mtr\/api\/map\/stations-and-routes(?:\?|$)/;
const KEY='folityn-light-rail-split-';
const tramsOn=()=>localStorage.getItem(KEY+'trams')!=='0';
const busesOn=()=>localStorage.getItem(KEY+'buses')!=='0';
const simplifyOn=()=>localStorage.getItem(KEY+'simplify')!=='0';
const norm=s=>String(s??'').trim().toLowerCase().replace(/[\s-]+/g,'_');
const routeType=r=>norm(r?.type);
const isLightRail=r=>{const t=routeType(r);return t==='train_light_rail'||t==='light_rail'||t.includes('light_rail')};
const routeNumber=r=>{const m=String(r?.name??r?.routeName??r?.route_name??'').trim().match(/\d+/);return m?Number(m[0]):null};
const classOf=r=>{if(!isLightRail(r))return null;const n=routeNumber(r);if(Number.isFinite(n)&&n>=1&&n<=20)return'tram';if(Number.isFinite(n)&&n>=100)return'bus';return'other'};
const routeStops=r=>Array.isArray(r?.stations)?r.stations:Array.isArray(r?.routeStations)?r.routeStations:Array.isArray(r?.platforms)?r.platforms:[];
const stopId=s=>String(s?.id??s?.hexId??s?.stationId??'');
const point=s=>{const x=Number(s?.x??s?.position?.x),z=Number(s?.z??s?.position?.z);return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null};
const setPoint=(s,q)=>{'x'in s||!s.position?(s.x=q.x,s.z=q.z):(s.position={...s.position,x:q.x,z:q.z})};
const median=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
const dist=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z);
const rad=d=>d*Math.PI/180;
const angleDiff=(a,b)=>{let d=Math.abs(a-b)%Math.PI;if(d>Math.PI/2)d=Math.PI-d;return d};
const nearestOctilinear=a=>Math.round(a/(Math.PI/4))*(Math.PI/4);

function buildGraph(routes){
  const graph=new Map(),coords=new Map(),occ=new Map();
  const node=id=>{if(id&&!graph.has(id))graph.set(id,new Set())};
  for(const r of routes){
    const s=routeStops(r).filter(x=>stopId(x)&&point(x));
    for(const st of s){const id=stopId(st),q=point(st);node(id);if(!occ.has(id))occ.set(id,[]);occ.get(id).push(q)}
    for(let i=1;i<s.length;i++){
      const a=stopId(s[i-1]),b=stopId(s[i]);if(!a||!b||a===b)continue;
      node(a);node(b);graph.get(a).add(b);graph.get(b).add(a);
    }
  }
  for(const[id,ps]of occ)coords.set(id,{x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))});
  return{graph,coords};
}
function addProposal(map,id,q){if(!map.has(id))map.set(id,[]);map.get(id).push(q)}
function finalize(proposals){const out=new Map();for(const[id,ps]of proposals)out.set(id,{x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))});return out}
function withOverrides(coords,...maps){const out=new Map(coords);for(const m of maps)for(const[id,q]of m||[])out.set(id,q);return out}

function tramChainProposal(ids,graph,coords,proposals){
  if(ids.length<3)return;
  let A=coords.get(ids[0]),B=coords.get(ids.at(-1));if(!A||!B)return;
  const dAB=dist(A,B);if(dAB<40)return;
  let snap=nearestOctilinear(Math.atan2(B.z-A.z,B.x-A.x));
  if(angleDiff(Math.atan2(B.z-A.z,B.x-A.x),snap)>rad(18))return;
  let ux=Math.cos(snap),uz=Math.sin(snap),proj=(B.x-A.x)*ux+(B.z-A.z)*uz;if(proj<0)proj=-proj;if(proj<40)return;
  const vx=B.x-A.x,vz=B.z-A.z,vv=vx*vx+vz*vz;let maxPerp=0;
  for(const id of ids.slice(1,-1)){
    const q=coords.get(id);if(!q)continue;const t=vv?((q.x-A.x)*vx+(q.z-A.z)*vz)/vv:0;
    maxPerp=Math.max(maxPerp,dist(q,{x:A.x+vx*t,z:A.z+vz*t}));
  }
  if(maxPerp>Math.max(120,dAB*.24))return;
  let ps=ids.map(id=>coords.get(id)),total=0,cum=[0];
  for(let i=1;i<ps.length;i++){total+=dist(ps[i-1],ps[i]);cum.push(total)}if(!total)return;
  const deg0=graph.get(ids[0])?.size??0,deg1=graph.get(ids.at(-1))?.size??0;
  if(deg0<=2&&deg1>2){
    ids=[...ids].reverse();A=coords.get(ids[0]);B=coords.get(ids.at(-1));snap=nearestOctilinear(Math.atan2(B.z-A.z,B.x-A.x));ux=Math.cos(snap);uz=Math.sin(snap);proj=(B.x-A.x)*ux+(B.z-A.z)*uz;
    ps=ids.map(id=>coords.get(id));total=0;cum=[0];for(let i=1;i<ps.length;i++){total+=dist(ps[i-1],ps[i]);cum.push(total)}
  }
  for(let i=1;i<ids.length;i++){
    const id=ids[i],deg=graph.get(id)?.size??0;if(deg>2)continue;if(i===ids.length-1&&(graph.get(id)?.size??0)>2)continue;
    const t=cum[i]/total;addProposal(proposals,id,{x:A.x+ux*proj*t,z:A.z+uz*proj*t});
  }
}
function simplifyTrams(routes){
  const{graph,coords}=buildGraph(routes),proposals=new Map();
  for(const r of routes){
    const seq=routeStops(r).map(stopId).filter(Boolean);if(seq.length<3)continue;let start=0;
    for(let i=1;i<seq.length;i++){
      const degree=graph.get(seq[i])?.size??0,isAnchor=i===seq.length-1||degree!==2;if(!isAnchor)continue;
      tramChainProposal(seq.slice(start,i+1),graph,coords,proposals);start=i;
    }
  }
  return{positions:finalize(proposals),ids:new Set([...coords.keys()]),nodes:graph.size,coords};
}

function runFits(ids,coords,maxAngle=24,maxPerpFactor=.30){
  if(ids.length<3)return null;const A=coords.get(ids[0]),B=coords.get(ids.at(-1));if(!A||!B)return null;
  const dAB=dist(A,B);if(dAB<55)return null;const raw=Math.atan2(B.z-A.z,B.x-A.x),snap=nearestOctilinear(raw);if(angleDiff(raw,snap)>rad(maxAngle))return null;
  const vx=B.x-A.x,vz=B.z-A.z,vv=vx*vx+vz*vz;let maxPerp=0;
  for(const id of ids.slice(1,-1)){
    const q=coords.get(id);if(!q)continue;const t=vv?((q.x-A.x)*vx+(q.z-A.z)*vz)/vv:0;
    maxPerp=Math.max(maxPerp,dist(q,{x:A.x+vx*t,z:A.z+vz*t}));
  }
  if(maxPerp>Math.max(150,dAB*maxPerpFactor))return null;
  const ux=Math.cos(snap),uz=Math.sin(snap),proj=(B.x-A.x)*ux+(B.z-A.z)*uz;if(Math.abs(proj)<45)return null;
  return{A,ux,uz,proj};
}
function simplifyBuses(routes){
  const{graph,coords}=buildGraph(routes),proposals=new Map();
  for(const r of routes){
    const seq=routeStops(r).map(stopId).filter(Boolean);if(seq.length<3)continue;
    let i=0;
    while(i<seq.length-2){
      let best=-1,bestFit=null;
      for(let j=i+2;j<seq.length;j++){
        const fit=runFits(seq.slice(i,j+1),coords);if(fit){best=j;bestFit=fit}else if(best>=i+2&&j-best>2)break;
      }
      if(best<0){i++;continue}
      const ids=seq.slice(i,best+1),ps=ids.map(id=>coords.get(id));let total=0,cum=[0];
      for(let k=1;k<ps.length;k++){total+=dist(ps[k-1],ps[k]);cum.push(total)}
      if(total>0){for(let k=1;k<ids.length-1;k++){const t=cum[k]/total;addProposal(proposals,ids[k],{x:bestFit.A.x+bestFit.ux*bestFit.proj*t,z:bestFit.A.z+bestFit.uz*bestFit.proj*t})}}
      i=best;
    }
  }
  return{positions:finalize(proposals),ids:new Set([...coords.keys()]),nodes:graph.size,coords};
}

function buildTramSpines(routes,coords){
  const raw=[];
  for(const r of routes){
    const ids=routeStops(r).map(stopId).filter(id=>coords.has(id));
    for(let i=1;i<ids.length;i++){
      const A=coords.get(ids[i-1]),B=coords.get(ids[i]);if(!A||!B)continue;
      const L=dist(A,B);if(L<70)continue;
      const angle=Math.atan2(B.z-A.z,B.x-A.x),snap=nearestOctilinear(angle);
      if(angleDiff(angle,snap)>rad(8))continue;
      const ux=Math.cos(snap),uz=Math.sin(snap),nx=-uz,nz=ux;
      raw.push({A,B,ux,uz,nx,nz,angle:snap,length:L});
    }
  }
  const out=[];
  for(const s of raw){
    const mx=(s.A.x+s.B.x)/2,mz=(s.A.z+s.B.z)/2;let same=false;
    for(const t of out){
      if(angleDiff(s.angle,t.angle)>rad(2))continue;
      const d=Math.abs((mx-t.A.x)*t.nx+(mz-t.A.z)*t.nz);
      if(d<45){same=true;break}
    }
    if(!same)out.push(s);
  }
  return out;
}
function signedDistanceToSpine(q,s){return(q.x-s.A.x)*s.nx+(q.z-s.A.z)*s.nz}
function alongSpine(q,s){return(q.x-s.A.x)*s.ux+(q.z-s.A.z)*s.uz}
function closestCompatibleSpine(a,b,spines){
  const ang=Math.atan2(b.z-a.z,b.x-a.x),mid={x:(a.x+b.x)/2,z:(a.z+b.z)/2};
  let best=null,bestScore=Infinity;
  for(const s of spines){
    if(angleDiff(ang,s.angle)>rad(20))continue;
    const da=Math.abs(signedDistanceToSpine(a,s)),db=Math.abs(signedDistanceToSpine(b,s)),dm=Math.abs(signedDistanceToSpine(mid,s));
    if(Math.max(da,db)>300||dm>250)continue;
    const ta=alongSpine(a,s),tb=alongSpine(b,s),pad=Math.max(260,s.length*.55);
    if(Math.max(ta,tb)<-pad||Math.min(ta,tb)>s.length+pad)continue;
    const score=dm+Math.max(da,db)*.35+angleDiff(ang,s.angle)*120;
    if(score<bestScore){best=s;bestScore=score}
  }
  return best;
}
function inheritBusCorridors(routes,baseCoords,spines,tramIds){
  const proposals=new Map();
  for(const r of routes){
    const ids=routeStops(r).map(stopId).filter(id=>baseCoords.has(id));if(ids.length<2)continue;
    const edgeGuide=[];
    for(let i=1;i<ids.length;i++)edgeGuide[i-1]=closestCompatibleSpine(baseCoords.get(ids[i-1]),baseCoords.get(ids[i]),spines);
    let i=0;
    while(i<edgeGuide.length){
      const guide=edgeGuide[i];if(!guide){i++;continue}
      let j=i;
      while(j+1<edgeGuide.length&&edgeGuide[j+1]){
        const n=edgeGuide[j+1];
        if(angleDiff(n.angle,guide.angle)>rad(2))break;
        const md=Math.abs(signedDistanceToSpine(n.A,guide));if(md>70)break;
        j++;
      }
      const runIds=ids.slice(i,j+2),pts=runIds.map(id=>baseCoords.get(id));
      const sharesTram=runIds.some(id=>tramIds.has(id));
      let offset=sharesTram?0:median(pts.map(q=>signedDistanceToSpine(q,guide)));
      if(Math.abs(offset)<85)offset=0;offset=Math.max(-220,Math.min(220,offset));
      for(let k=0;k<runIds.length;k++){
        const id=runIds[k];if(tramIds.has(id))continue;
        const q=pts[k],t=alongSpine(q,guide);
        addProposal(proposals,id,{x:guide.A.x+guide.ux*t+guide.nx*offset,z:guide.A.z+guide.uz*t+guide.nz*offset});
      }
      i=j+1;
    }
  }
  return finalize(proposals);
}

function simplifyLightRail(data){
  const all=(data.routes||[]).filter(isLightRail),trams=all.filter(r=>classOf(r)==='tram'),buses=all.filter(r=>classOf(r)==='bus');
  const T=simplifyTrams(trams),B=simplifyBuses(buses);
  const tramCoords=withOverrides(T.coords,T.positions),busCoords=withOverrides(B.coords,B.positions);
  for(const id of T.ids)if(T.positions.has(id)&&busCoords.has(id))busCoords.set(id,T.positions.get(id));
  const spines=buildTramSpines(trams,tramCoords),inherited=inheritBusCorridors(buses,busCoords,spines,T.ids);
  const finalPos=new Map(T.positions);
  for(const[id,q]of B.positions)if(!T.ids.has(id))finalPos.set(id,q);
  for(const[id,q]of inherited)if(!T.ids.has(id))finalPos.set(id,q);
  for(const r of all)for(const st of routeStops(r)){const q=finalPos.get(stopId(st));if(q)setPoint(st,q)}
  window.__folitynSchematicDebug={tramRoutes:trams.length,busRoutes:buses.length,tramNodes:T.nodes,busNodes:B.nodes,tramMoved:T.positions.size,busMoved:[...B.positions.keys()].filter(id=>!T.ids.has(id)).length,tramSpines:spines.length,busInherited:inherited.size};
}

function filterEnvelope(env){
  if(!env||typeof env!=='object')return env;
  const src=env.data&&typeof env.data==='object'?env.data:env;if(!Array.isArray(src.routes))return env;
  const out=typeof structuredClone==='function'?structuredClone(env):JSON.parse(JSON.stringify(env)),data=out.data&&typeof out.data==='object'?out.data:out,before=data.routes.length;
  data.routes=data.routes.filter(r=>{const c=classOf(r);if(c==='tram')return tramsOn();if(c==='bus')return busesOn();return true});
  if(simplifyOn())simplifyLightRail(data);
  window.__folitynLightRailFilterDebug={before,after:data.routes.length,trams:tramsOn(),buses:busesOn(),simplify:simplifyOn()};return out;
}
const transformText=text=>{try{return JSON.stringify(filterEnvelope(JSON.parse(text)))}catch(e){console.warn('[Folityn light rail tools] transform failed',e);return text}};
const nativeFetch=window.fetch.bind(window);
window.fetch=async function(input,init){const url=typeof input==='string'?input:input?.url||'',response=await nativeFetch(input,init);if(!TARGET.test(url))return response;try{return new Response(transformText(await response.clone().text()),{status:response.status,statusText:response.statusText,headers:response.headers})}catch(e){console.warn('[Folityn light rail tools] fetch hook failed',e);return response}};
try{
  const proto=XMLHttpRequest.prototype,nativeOpen=proto.open,textGetter=Object.getOwnPropertyDescriptor(proto,'responseText')?.get,responseGetter=Object.getOwnPropertyDescriptor(proto,'response')?.get,cache=new WeakMap();
  proto.open=function(method,url,...rest){this.__folitynLRFilter=TARGET.test(String(url));cache.delete(this);return nativeOpen.call(this,method,url,...rest)};
  if(textGetter)Object.defineProperty(proto,'responseText',{configurable:true,get(){const raw=textGetter.call(this);if(!this.__folitynLRFilter||this.readyState!==4||typeof raw!=='string')return raw;let item=cache.get(this);if(!item){item={text:transformText(raw)};cache.set(this,item)}return item.text}});
  if(responseGetter)Object.defineProperty(proto,'response',{configurable:true,get(){const raw=responseGetter.call(this);if(!this.__folitynLRFilter||this.readyState!==4)return raw;let item=cache.get(this)||{};if(this.responseType==='json'&&raw&&typeof raw==='object'){if(!item.json){item.json=filterEnvelope(raw);cache.set(this,item)}return item.json}if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){if(!item.text){item.text=transformText(raw);cache.set(this,item)}return item.text}return raw}});
}catch(e){console.warn('[Folityn light rail tools] XHR hook failed',e)}

function setFilter(which,on){localStorage.setItem(KEY+which,on?'1':'0');location.reload()}
function makeToggle(label,kind,icon){const on=kind==='trams'?tramsOn():kind==='buses'?busesOn():simplifyOn(),b=document.createElement('button');b.type='button';b.className='folityn-lr-toggle'+(on?' is-on':' is-off');b.dataset.kind=kind;b.innerHTML=`<span class="folityn-lr-icon">${icon}</span><span>${label}</span><span class="folityn-lr-state">${on?'ON':'OFF'}</span>`;b.addEventListener('click',()=>setFilter(kind,!on));return b}
function buildControls(){const box=document.createElement('div');box.id='folityn-lr-filters';const title=document.createElement('div');title.className='folityn-lr-title';title.textContent='Light Rail';box.append(title,makeToggle('Trams 1–20','trams','🚋'),makeToggle('Buses 100+','buses','🚌'),makeToggle('Simplify corridors','simplify','↗'));return box}
function findLightRailAnchor(){const all=[...document.querySelectorAll('app-map *, app-root *, body *')],exact=all.find(el=>el.children.length<=2&&el.textContent?.trim()==='Light Rail');if(!exact)return null;let row=exact;for(let i=0;i<5&&row.parentElement;i++){const p=row.parentElement,txt=p.textContent?.trim()||'';if(txt.includes('Light Rail')&&txt.length<120)row=p;else break}return row}
function mountControls(){
  if(!document.body)return setTimeout(mountControls,50);if(document.getElementById('folityn-lr-filters'))return;
  const style=document.createElement('style');style.id='folityn-lr-filter-style';style.textContent=`#folityn-lr-filters{box-sizing:border-box;font:13px/1.2 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#334155;background:#fff;border:1px solid #dbe3ee;border-radius:9px;padding:8px;display:grid;gap:6px;min-width:190px;box-shadow:0 4px 16px #00000014}.folityn-lr-title{font-weight:700;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;padding:0 2px 2px}.folityn-lr-toggle{appearance:none;border:1px solid #dbe3ee;background:#f8fafc;color:#334155;border-radius:7px;padding:7px 8px;display:grid;grid-template-columns:22px 1fr auto;align-items:center;gap:6px;text-align:left;cursor:pointer;font:inherit}.folityn-lr-toggle:hover{background:#eef4fa}.folityn-lr-toggle.is-off{opacity:.58}.folityn-lr-toggle.is-on{border-color:#b9c9dc;background:#f3f7fb}.folityn-lr-icon{font-size:15px}.folityn-lr-state{font-size:10px;font-weight:800;letter-spacing:.04em;color:#64748b}@media(prefers-color-scheme:dark){#folityn-lr-filters{background:#101827;color:#e5edf7;border-color:#334155;box-shadow:0 4px 18px #0008}.folityn-lr-title{color:#94a3b8}.folityn-lr-toggle{background:#162033;color:#e5edf7;border-color:#334155}.folityn-lr-toggle:hover{background:#1d2a40}.folityn-lr-toggle.is-on{background:#1a263a;border-color:#52657e}.folityn-lr-state{color:#94a3b8}}#folityn-lr-filters.folityn-lr-floating{position:fixed;right:18px;top:245px;z-index:2147483646}`;document.head.appendChild(style);
  const box=buildControls(),anchor=findLightRailAnchor();if(anchor&&anchor.parentElement){box.style.margin='6px 0 8px 28px';anchor.insertAdjacentElement('afterend',box)}else{box.classList.add('folityn-lr-floating');document.body.appendChild(box)}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountControls,{once:true});else mountControls();
new MutationObserver(()=>{if(!document.getElementById('folityn-lr-filters'))mountControls()}).observe(document.documentElement,{childList:true,subtree:true});
})();
