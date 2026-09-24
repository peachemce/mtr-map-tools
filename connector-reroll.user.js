// ==UserScript==
// @name         Folityn MTR Map Tools
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.4.3
// @description  Native MTR map with tram/bus filters, conservative simplification, and hard-coded Folityn schematic corridors.
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

const norm=s=>String(s??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[\s_/.-]+/g,'_');
const routeType=r=>norm(r?.type);
const isLightRail=r=>{const t=routeType(r);return t==='train_light_rail'||t==='light_rail'||t.includes('light_rail')};
const isRail=r=>{const t=routeType(r);return !isLightRail(r)&&(t==='train_normal'||t==='train_high_speed'||t==='rail'||t.includes('train_normal')||t.includes('high_speed'))};
const routeNumber=r=>{const m=String(r?.name??r?.routeName??r?.route_name??'').trim().match(/\d+/);return m?Number(m[0]):null};
const classOf=r=>{if(!isLightRail(r))return null;const n=routeNumber(r);if(Number.isFinite(n)&&n>=1&&n<=20)return'tram';if(Number.isFinite(n)&&n>=100)return'bus';return'other'};
const routeStops=r=>Array.isArray(r?.stations)?r.stations:Array.isArray(r?.routeStations)?r.routeStations:Array.isArray(r?.platforms)?r.platforms:[];
const stopId=s=>String(s?.id??s?.hexId??s?.stationId??'');
const point=s=>{const x=Number(s?.x??s?.position?.x),z=Number(s?.z??s?.position?.z);return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null};
const setPoint=(s,q)=>{'x'in s||!s.position?(s.x=q.x,s.z=q.z):(s.position={...s.position,x:q.x,z:q.z})};
const median=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
const dist=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z);
const rad=d=>d*Math.PI/180;
const angleDiff=(a,b)=>{let d=Math.abs(a-b)%(Math.PI*2);if(d>Math.PI)d=Math.PI*2-d;return Math.min(d,Math.abs(Math.PI-d))};
const nearestOctilinear=a=>Math.round(a/(Math.PI/4))*(Math.PI/4);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function stationNameMap(data){
  const map=new Map();
  for(const s of data.stations||[])map.set(String(s.id??s.hexId??s.stationId??''),String(s.name??''));
  return map;
}
function coordsForRoutes(routes){
  const occ=new Map();
  for(const r of routes)for(const st of routeStops(r)){
    const id=stopId(st),q=point(st);if(!id||!q)continue;if(!occ.has(id))occ.set(id,[]);occ.get(id).push(q);
  }
  const out=new Map();
  for(const[id,ps]of occ)out.set(id,{x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))});
  return out;
}
function applyPositions(routes,positions){
  for(const r of routes)for(const st of routeStops(r)){const q=positions.get(stopId(st));if(q)setPoint(st,q)}
}
function buildGraph(routes){
  const graph=new Map(),coords=coordsForRoutes(routes);
  const node=id=>{if(id&&!graph.has(id))graph.set(id,new Set())};
  for(const r of routes){const s=routeStops(r).filter(x=>stopId(x)&&point(x));for(const st of s)node(stopId(st));for(let i=1;i<s.length;i++){const a=stopId(s[i-1]),b=stopId(s[i]);if(!a||!b||a===b)continue;node(a);node(b);graph.get(a).add(b);graph.get(b).add(a)}}
  return{graph,coords};
}
function addProposal(map,id,q){if(!map.has(id))map.set(id,[]);map.get(id).push(q)}
function finalize(proposals){const out=new Map();for(const[id,ps]of proposals)out.set(id,{x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))});return out}

// Conservative generic simplification. Hard registry below always wins afterwards.
function chainProposal(ids,graph,coords,proposals,maxAngle,maxPerpFactor){
  if(ids.length<3)return;
  let A=coords.get(ids[0]),B=coords.get(ids.at(-1));if(!A||!B)return;
  const dAB=dist(A,B);if(dAB<50)return;
  const raw=Math.atan2(B.z-A.z,B.x-A.x),snap=nearestOctilinear(raw);if(angleDiff(raw,snap)>rad(maxAngle))return;
  const vx=B.x-A.x,vz=B.z-A.z,vv=vx*vx+vz*vz;let maxPerp=0;
  for(const id of ids.slice(1,-1)){const q=coords.get(id);if(!q)continue;const t=vv?((q.x-A.x)*vx+(q.z-A.z)*vz)/vv:0;maxPerp=Math.max(maxPerp,dist(q,{x:A.x+vx*t,z:A.z+vz*t}))}
  if(maxPerp>Math.max(130,dAB*maxPerpFactor))return;
  const ux=Math.cos(snap),uz=Math.sin(snap),proj=(B.x-A.x)*ux+(B.z-A.z)*uz;if(Math.abs(proj)<45)return;
  const ps=ids.map(id=>coords.get(id));let total=0,cum=[0];for(let i=1;i<ps.length;i++){total+=dist(ps[i-1],ps[i]);cum.push(total)}if(!total)return;
  for(let i=1;i<ids.length-1;i++){const id=ids[i],deg=graph.get(id)?.size??0;if(deg>2)continue;const t=cum[i]/total;addProposal(proposals,id,{x:A.x+ux*proj*t,z:A.z+uz*proj*t})}
}
function simplifyClass(routes,kind){
  const{graph,coords}=buildGraph(routes),proposals=new Map();
  if(kind==='tram'){
    for(const r of routes){const seq=routeStops(r).map(stopId).filter(Boolean);if(seq.length<3)continue;let start=0;for(let i=1;i<seq.length;i++){const degree=graph.get(seq[i])?.size??0,isAnchor=i===seq.length-1||degree!==2;if(!isAnchor)continue;chainProposal(seq.slice(start,i+1),graph,coords,proposals,18,.24);start=i}}
  }else{
    for(const r of routes){const seq=routeStops(r).map(stopId).filter(Boolean);if(seq.length<3)continue;let i=0;while(i<seq.length-2){let best=-1;for(let j=i+2;j<seq.length;j++){const tmp=new Map();chainProposal(seq.slice(i,j+1),graph,coords,tmp,23,.30);if(tmp.size){best=j}else if(best>=i+2&&j-best>2)break}if(best<0){i++;continue}chainProposal(seq.slice(i,best+1),graph,coords,proposals,23,.30);i=best}}
  }
  return finalize(proposals);
}

function idNamesForRoute(r,nameMap){return routeStops(r).map(st=>({id:stopId(st),name:norm(nameMap.get(stopId(st))||''),st})).filter(x=>x.id)}
function aliasSet(names){return new Set(names.map(norm))}
function findPathOnRoute(r,nameMap,startNames,endNames){
  const seq=idNamesForRoute(r,nameMap),A=aliasSet(startNames),B=aliasSet(endNames);let best=null;
  for(let i=0;i<seq.length;i++)if(A.has(seq[i].name))for(let j=0;j<seq.length;j++)if(B.has(seq[j].name)&&i!==j){const lo=Math.min(i,j),hi=Math.max(i,j),cand=seq.slice(lo,hi+1);if(!best||cand.length>best.length)best=cand}
  return best;
}
function compressedSteps(ids,coords){
  const raw=[];for(let i=1;i<ids.length;i++){const a=coords.get(ids[i-1]),b=coords.get(ids[i]);raw.push(a&&b?dist(a,b):0)}
  const nz=raw.filter(x=>x>0);const med=nz.length?median(nz):140;return raw.map(d=>clamp(d||med,med*.68,med*1.45));
}
function diagonalAngle(raw,forcedUp=false){
  if(forcedUp){const east=Math.cos(raw)>=0;return east?-Math.PI/4:3*Math.PI/4}
  const choices=[Math.PI/4,-Math.PI/4,3*Math.PI/4,-3*Math.PI/4];let best=choices[0],bd=Infinity;for(const a of choices){const d=angleDiff(raw,a);if(d<bd){bd=d;best=a}}return best;
}
function layoutPath(ids,coords,start,angle){
  const steps=compressedSteps(ids,coords),ux=Math.cos(angle),uz=Math.sin(angle),out=new Map([[ids[0],start]]);let x=start.x,z=start.z;for(let i=1;i<ids.length;i++){x+=ux*steps[i-1];z+=uz*steps[i-1];out.set(ids[i],{x,z})}return out;
}
function mergeMap(target,source){for(const[id,q]of source)target.set(id,q)}
function currentCoord(id,base,hard){return hard.get(id)||base.get(id)}

function applyCorridorRule(routes,nameMap,base,hard,rule){
  let applied=0;
  for(const r of routes){
    if(rule.class==='light'&&!isLightRail(r))continue;if(rule.class==='rail'&&!isRail(r))continue;
    const path=findPathOnRoute(r,nameMap,rule.from,rule.to);if(!path||path.length<2)continue;
    const ids=path.map(x=>x.id),A=currentCoord(ids[0],base,hard),B=currentCoord(ids.at(-1],base,hard);if(!A||!B)continue;
    const raw=Math.atan2(B.z-A.z,B.x-A.x);let angle;
    if(rule.angle==='horizontal')angle=Math.cos(raw)>=0?0:Math.PI;
    else if(rule.angle==='diag-up')angle=diagonalAngle(raw,true);
    else if(rule.angle==='diag')angle=diagonalAngle(raw,false);
    else angle=nearestOctilinear(raw);
    mergeMap(hard,layoutPath(ids,base,A,angle));applied++;
  }
  return applied;
}

function mergeVisualHub(data,nameMap,base,hard,names){
  const wanted=aliasSet(names),ids=[];for(const[id,name]of nameMap)if(wanted.has(norm(name)))ids.push(id);if(ids.length<2)return 0;
  const ps=ids.map(id=>currentCoord(id,base,hard)).filter(Boolean);if(!ps.length)return 0;const q={x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))};for(const id of ids)hard.set(id,q);return ids.length;
}

function applyFolitynRegistry(data){
  const routes=data.routes||[],nameMap=stationNameMap(data),base=coordsForRoutes(routes),hard=new Map();
  const stats={rogowska:0,jamUp:0,jamEast:0,wzgorzyn:0,drzewiec:0,kfEast:0,wityHub:0};

  // 1) Main east-west surface spine: Rogowska. It stays horizontal and authoritative.
  stats.rogowska=applyCorridorRule(routes,nameMap,base,hard,{class:'light',from:['Rogowska Centrum Miejskie'],to:['Szwedzka/Norweska','Szwedzka Stadion','Grochowa'],angle:'horizontal'});

  // 2) Kotlandzka/Jamnikowsko: leave RCM at 45° up, then become horizontal at Rondo Moryta.
  stats.jamUp=applyCorridorRule(routes,nameMap,base,hard,{class:'light',from:['Rogowska Centrum Miejskie'],to:['Rondo Moryta-Niejawskiego'],angle:'diag-up'});
  stats.jamEast=applyCorridorRule(routes,nameMap,base,hard,{class:'light',from:['Rondo Moryta-Niejawskiego'],to:['Folityn Jamnikowsko'],angle:'horizontal'});

  // 3) Wzgórzyn surface corridor: one clean diagonal through the corridor instead of stair-stepping.
  stats.wzgorzyn=applyCorridorRule(routes,nameMap,base,hard,{class:'light',from:['Wzgórzyn PKM'],to:['Końcowa','Astrolitowska'],angle:'diag'});

  // 4) Drzewiec corridor is genuinely straight in-world until Os. Lipowe.
  stats.drzewiec=applyCorridorRule(routes,nameMap,base,hard,{class:'light',from:['Drzewiec PKM'],to:['Lipków/Os.Lipowe'],angle:'diag'});

  // 5) KF East railway: a separate straight rail axis through Wzgórzyn PKM -> Jamnikowsko PKM.
  //    The Jamnikowsko tram loop deliberately ends before this rail station and is NOT merged with it.
  stats.kfEast=applyCorridorRule(routes,nameMap,base,hard,{class:'rail',from:['Wzgórzyn PKM'],to:['Jamnikowsko PKM'],angle:'diag'});

  // Wity bus/rail stops are physically the same place, so collapse only this known true hub.
  stats.wityHub=mergeVisualHub(data,nameMap,base,hard,['Folityn Wity','Wity PKM']);

  applyPositions(routes,hard);
  window.__folitynCorridorRegistryDebug={...stats,moved:hard.size};
}

function simplifyNetwork(data){
  const routes=data.routes||[],trams=routes.filter(r=>classOf(r)==='tram'),buses=routes.filter(r=>classOf(r)==='bus');
  const tramPos=simplifyClass(trams,'tram');applyPositions(trams,tramPos);
  const busPos=simplifyClass(buses,'bus');applyPositions(buses,busPos);
  applyFolitynRegistry(data);
  window.__folitynSchematicDebug={tramRoutes:trams.length,busRoutes:buses.length,tramMoved:tramPos.size,busMoved:busPos.size,registry:window.__folitynCorridorRegistryDebug};
}

function filterEnvelope(env){
  if(!env||typeof env!=='object')return env;const src=env.data&&typeof env.data==='object'?env.data:env;if(!Array.isArray(src.routes))return env;
  const out=typeof structuredClone==='function'?structuredClone(env):JSON.parse(JSON.stringify(env)),data=out.data&&typeof out.data==='object'?out.data:out,before=data.routes.length;
  data.routes=data.routes.filter(r=>{const c=classOf(r);if(c==='tram')return tramsOn();if(c==='bus')return busesOn();return true});
  if(simplifyOn())simplifyNetwork(data);
  window.__folitynLightRailFilterDebug={before,after:data.routes.length,trams:tramsOn(),buses:busesOn(),simplify:simplifyOn()};return out;
}
const transformText=text=>{try{return JSON.stringify(filterEnvelope(JSON.parse(text)))}catch(e){console.warn('[Folityn map tools] transform failed',e);return text}};
const nativeFetch=window.fetch.bind(window);
window.fetch=async function(input,init){const url=typeof input==='string'?input:input?.url||'',response=await nativeFetch(input,init);if(!TARGET.test(url))return response;try{return new Response(transformText(await response.clone().text()),{status:response.status,statusText:response.statusText,headers:response.headers})}catch(e){console.warn('[Folityn map tools] fetch hook failed',e);return response}};
try{
  const proto=XMLHttpRequest.prototype,nativeOpen=proto.open,textGetter=Object.getOwnPropertyDescriptor(proto,'responseText')?.get,responseGetter=Object.getOwnPropertyDescriptor(proto,'response')?.get,cache=new WeakMap();
  proto.open=function(method,url,...rest){this.__folitynMapTools=TARGET.test(String(url));cache.delete(this);return nativeOpen.call(this,method,url,...rest)};
  if(textGetter)Object.defineProperty(proto,'responseText',{configurable:true,get(){const raw=textGetter.call(this);if(!this.__folitynMapTools||this.readyState!==4||typeof raw!=='string')return raw;let item=cache.get(this);if(!item){item={text:transformText(raw)};cache.set(this,item)}return item.text}});
  if(responseGetter)Object.defineProperty(proto,'response',{configurable:true,get(){const raw=responseGetter.call(this);if(!this.__folitynMapTools||this.readyState!==4)return raw;let item=cache.get(this)||{};if(this.responseType==='json'&&raw&&typeof raw==='object'){if(!item.json){item.json=filterEnvelope(raw);cache.set(this,item)}return item.json}if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){if(!item.text){item.text=transformText(raw);cache.set(this,item)}return item.text}return raw}});
}catch(e){console.warn('[Folityn map tools] XHR hook failed',e)}

function setFilter(which,on){localStorage.setItem(KEY+which,on?'1':'0');location.reload()}
function makeToggle(label,kind,icon){const on=kind==='trams'?tramsOn():kind==='buses'?busesOn():simplifyOn(),b=document.createElement('button');b.type='button';b.className='folityn-lr-toggle'+(on?' is-on':' is-off');b.dataset.kind=kind;b.innerHTML=`<span class="folityn-lr-icon">${icon}</span><span>${label}</span><span class="folityn-lr-state">${on?'ON':'OFF'}</span>`;b.addEventListener('click',()=>setFilter(kind,!on));return b}
function buildControls(){const box=document.createElement('div');box.id='folityn-lr-filters';const title=document.createElement('div');title.className='folityn-lr-title';title.textContent='Light Rail';box.append(title,makeToggle('Trams 1–20','trams','🚋'),makeToggle('Buses 100+','buses','🚌'),makeToggle('Schematic corridors','simplify','↗'));return box}
function findLightRailAnchor(){const all=[...document.querySelectorAll('app-map *, app-root *, body *')],exact=all.find(el=>el.children.length<=2&&el.textContent?.trim()==='Light Rail');if(!exact)return null;let row=exact;for(let i=0;i<5&&row.parentElement;i++){const p=row.parentElement,txt=p.textContent?.trim()||'';if(txt.includes('Light Rail')&&txt.length<120)row=p;else break}return row}
function mountControls(){
  if(!document.body)return setTimeout(mountControls,50);if(document.getElementById('folityn-lr-filters'))return;
  const style=document.createElement('style');style.id='folityn-lr-filter-style';style.textContent=`#folityn-lr-filters{box-sizing:border-box;font:13px/1.2 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#334155;background:#fff;border:1px solid #dbe3ee;border-radius:9px;padding:8px;display:grid;gap:6px;min-width:190px;box-shadow:0 4px 16px #00000014}.folityn-lr-title{font-weight:700;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;padding:0 2px 2px}.folityn-lr-toggle{appearance:none;border:1px solid #dbe3ee;background:#f8fafc;color:#334155;border-radius:7px;padding:7px 8px;display:grid;grid-template-columns:22px 1fr auto;align-items:center;gap:6px;text-align:left;cursor:pointer;font:inherit}.folityn-lr-toggle:hover{background:#eef4fa}.folityn-lr-toggle.is-off{opacity:.58}.folityn-lr-toggle.is-on{border-color:#b9c9dc;background:#f3f7fb}.folityn-lr-icon{font-size:15px}.folityn-lr-state{font-size:10px;font-weight:800;letter-spacing:.04em;color:#64748b}@media(prefers-color-scheme:dark){#folityn-lr-filters{background:#101827;color:#e5edf7;border-color:#334155;box-shadow:0 4px 18px #0008}.folityn-lr-title{color:#94a3b8}.folityn-lr-toggle{background:#162033;color:#e5edf7;border-color:#334155}.folityn-lr-toggle:hover{background:#1d2a40}.folityn-lr-toggle.is-on{background:#1a263a;border-color:#52657e}.folityn-lr-state{color:#94a3b8}}#folityn-lr-filters.folityn-lr-floating{position:fixed;right:18px;top:245px;z-index:2147483646}`;document.head.appendChild(style);
  const box=buildControls(),anchor=findLightRailAnchor();if(anchor&&anchor.parentElement){box.style.margin='6px 0 8px 28px';anchor.insertAdjacentElement('afterend',box)}else{box.classList.add('folityn-lr-floating');document.body.appendChild(box)}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountControls,{once:true});else mountControls();
new MutationObserver(()=>{if(!document.getElementById('folityn-lr-filters'))mountControls()}).observe(document.documentElement,{childList:true,subtree:true});
})();
