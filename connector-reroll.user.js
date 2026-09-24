// ==UserScript==
// @name         MTR Map Tools - Tram / Bus Filters + Schematic Light Rail
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.1.0
// @description  Tram/bus sub-filters plus conservative corridor simplification for MTR Light Rail.
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
const isLightRail=r=>{
  const t=routeType(r);
  return t==='train_light_rail'||t==='light_rail'||t.includes('light_rail');
};
const routeNumber=r=>{
  const raw=String(r?.name??r?.routeName??r?.route_name??'').trim();
  const m=raw.match(/\d+/);
  return m?Number(m[0]):null;
};
const classOf=r=>{
  if(!isLightRail(r)) return null;
  const n=routeNumber(r);
  if(Number.isFinite(n)&&n>=1&&n<=20) return 'tram';
  if(Number.isFinite(n)&&n>=100) return 'bus';
  return 'other';
};
const routeStops=r=>Array.isArray(r?.stations)?r.stations:Array.isArray(r?.routeStations)?r.routeStations:Array.isArray(r?.platforms)?r.platforms:[];
const stopId=s=>String(s?.id??s?.hexId??s?.stationId??'');
const point=s=>{
  const x=Number(s?.x??s?.position?.x),z=Number(s?.z??s?.position?.z);
  return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null;
};
const setPoint=(s,q)=>{
  if('x' in s || !s.position){s.x=q.x;s.z=q.z}
  else{s.position={...s.position,x:q.x,z:q.z}}
};
const median=a=>{
  if(!a.length)return 0;
  const b=[...a].sort((x,y)=>x-y),m=b.length>>1;
  return b.length%2?b[m]:(b[m-1]+b[m])/2;
};
const dist=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z);
const rad=d=>d*Math.PI/180;
const angleDiff=(a,b)=>{
  let d=Math.abs(a-b)%Math.PI;
  if(d>Math.PI/2)d=Math.PI-d;
  return d;
};
const nearestOctilinear=a=>Math.round(a/(Math.PI/4))*(Math.PI/4);

function buildLightRailGraph(routes){
  const graph=new Map(),coords=new Map(),occ=new Map();
  const addNode=id=>{if(id&&!graph.has(id))graph.set(id,new Set())};
  for(const r of routes){
    const s=routeStops(r).filter(x=>stopId(x)&&point(x));
    for(const st of s){
      const id=stopId(st),q=point(st);addNode(id);
      if(!occ.has(id))occ.set(id,[]);
      occ.get(id).push(q);
    }
    for(let i=1;i<s.length;i++){
      const a=stopId(s[i-1]),b=stopId(s[i]);
      if(!a||!b||a===b)continue;
      addNode(a);addNode(b);
      graph.get(a).add(b);graph.get(b).add(a);
    }
  }
  for(const [id,ps] of occ)coords.set(id,{x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))});
  return {graph,coords};
}

function chainProposal(ids,graph,coords,proposals){
  if(ids.length<3)return;
  let A=coords.get(ids[0]),B=coords.get(ids.at(-1));
  if(!A||!B)return;

  const dAB=dist(A,B);
  if(dAB<40)return;

  const rawAngle=Math.atan2(B.z-A.z,B.x-A.x);
  const snap=nearestOctilinear(rawAngle);
  const diff=angleDiff(rawAngle,snap);
  if(diff>rad(18))return;

  const ux=Math.cos(snap),uz=Math.sin(snap);
  let proj=(B.x-A.x)*ux+(B.z-A.z)*uz;
  if(proj<0)proj=-proj;
  if(proj<40)return;

  let maxPerp=0;
  const vx=B.x-A.x,vz=B.z-A.z,vv=vx*vx+vz*vz;
  for(const id of ids.slice(1,-1)){
    const q=coords.get(id);if(!q)continue;
    const t=vv?((q.x-A.x)*vx+(q.z-A.z)*vz)/vv:0;
    const p={x:A.x+vx*t,z:A.z+vz*t};
    maxPerp=Math.max(maxPerp,dist(q,p));
  }
  if(maxPerp>Math.max(120,dAB*.24))return;

  const ps=ids.map(id=>coords.get(id));
  let total=0;const cum=[0];
  for(let i=1;i<ps.length;i++){total+=dist(ps[i-1],ps[i]);cum.push(total)}
  if(total<=0)return;

  const deg0=graph.get(ids[0])?.size??0,deg1=graph.get(ids.at(-1))?.size??0;
  if(deg0<=2&&deg1>2){
    ids=[...ids].reverse();
    A=coords.get(ids[0]);B=coords.get(ids.at(-1));
    const raw=Math.atan2(B.z-A.z,B.x-A.x),sn=nearestOctilinear(raw);
    const Ux=Math.cos(sn),Uz=Math.sin(sn);
    const P=(B.x-A.x)*Ux+(B.z-A.z)*Uz;
    const pss=ids.map(id=>coords.get(id));
    total=0;cum.length=1;cum[0]=0;
    for(let i=1;i<pss.length;i++){total+=dist(pss[i-1],pss[i]);cum.push(total)}
    const lastDeg=graph.get(ids.at(-1))?.size??0;
    for(let i=1;i<ids.length;i++){
      const id=ids[i],deg=graph.get(id)?.size??0;
      if(deg>2)continue;
      if(i===ids.length-1&&lastDeg>2)continue;
      const t=cum[i]/total;
      const q={x:A.x+Ux*P*t,z:A.z+Uz*P*t};
      if(!proposals.has(id))proposals.set(id,[]);
      proposals.get(id).push(q);
    }
    return;
  }

  const lastDeg=deg1;
  for(let i=1;i<ids.length;i++){
    const id=ids[i],deg=graph.get(id)?.size??0;
    if(deg>2)continue;
    if(i===ids.length-1&&lastDeg>2)continue;
    const t=cum[i]/total;
    const q={x:A.x+ux*proj*t,z:A.z+uz*proj*t};
    if(!proposals.has(id))proposals.set(id,[]);
    proposals.get(id).push(q);
  }
}

function simplifyLightRail(data){
  const routes=(data.routes||[]).filter(isLightRail);
  if(!routes.length)return;
  const {graph,coords}=buildLightRailGraph(routes);
  const proposals=new Map();

  for(const r of routes){
    const seq=routeStops(r).map(stopId).filter(Boolean);
    if(seq.length<3)continue;
    let start=0;
    for(let i=1;i<seq.length;i++){
      const degree=graph.get(seq[i])?.size??0;
      const isAnchor=i===seq.length-1||degree!==2;
      if(!isAnchor)continue;
      chainProposal(seq.slice(start,i+1),graph,coords,proposals);
      start=i;
    }
  }

  const finalPos=new Map();
  for(const [id,ps] of proposals){
    finalPos.set(id,{x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))});
  }

  for(const r of routes){
    for(const st of routeStops(r)){
      const q=finalPos.get(stopId(st));
      if(q)setPoint(st,q);
    }
  }

  window.__folitynSchematicDebug={
    lightRailRoutes:routes.length,
    graphNodes:graph.size,
    simplifiedStations:finalPos.size
  };
}

function filterEnvelope(env){
  if(!env||typeof env!=='object') return env;
  const src=env.data&&typeof env.data==='object'?env.data:env;
  if(!Array.isArray(src.routes)) return env;

  const out=typeof structuredClone==='function'?structuredClone(env):JSON.parse(JSON.stringify(env));
  const data=out.data&&typeof out.data==='object'?out.data:out;
  const before=data.routes.length;

  data.routes=data.routes.filter(r=>{
    const c=classOf(r);
    if(c==='tram') return tramsOn();
    if(c==='bus') return busesOn();
    return true;
  });

  if(simplifyOn())simplifyLightRail(data);

  window.__folitynLightRailFilterDebug={
    before,
    after:data.routes.length,
    trams:tramsOn(),
    buses:busesOn(),
    simplify:simplifyOn()
  };
  return out;
}

const transformText=text=>{
  try{return JSON.stringify(filterEnvelope(JSON.parse(text)))}
  catch(e){console.warn('[Folityn light rail tools] transform failed',e);return text}
};

const nativeFetch=window.fetch.bind(window);
window.fetch=async function(input,init){
  const url=typeof input==='string'?input:input?.url||'';
  const response=await nativeFetch(input,init);
  if(!TARGET.test(url)) return response;
  try{
    const text=await response.clone().text();
    return new Response(transformText(text),{
      status:response.status,
      statusText:response.statusText,
      headers:response.headers
    });
  }catch(e){
    console.warn('[Folityn light rail tools] fetch hook failed',e);
    return response;
  }
};

try{
  const proto=XMLHttpRequest.prototype;
  const nativeOpen=proto.open;
  const textGetter=Object.getOwnPropertyDescriptor(proto,'responseText')?.get;
  const responseGetter=Object.getOwnPropertyDescriptor(proto,'response')?.get;
  const cache=new WeakMap();

  proto.open=function(method,url,...rest){
    this.__folitynLRFilter=TARGET.test(String(url));
    cache.delete(this);
    return nativeOpen.call(this,method,url,...rest);
  };

  if(textGetter){
    Object.defineProperty(proto,'responseText',{
      configurable:true,
      get(){
        const raw=textGetter.call(this);
        if(!this.__folitynLRFilter||this.readyState!==4||typeof raw!=='string') return raw;
        let item=cache.get(this);
        if(!item){item={text:transformText(raw)};cache.set(this,item)}
        return item.text;
      }
    });
  }

  if(responseGetter){
    Object.defineProperty(proto,'response',{
      configurable:true,
      get(){
        const raw=responseGetter.call(this);
        if(!this.__folitynLRFilter||this.readyState!==4) return raw;
        let item=cache.get(this)||{};
        if(this.responseType==='json'&&raw&&typeof raw==='object'){
          if(!item.json){item.json=filterEnvelope(raw);cache.set(this,item)}
          return item.json;
        }
        if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){
          if(!item.text){item.text=transformText(raw);cache.set(this,item)}
          return item.text;
        }
        return raw;
      }
    });
  }
}catch(e){
  console.warn('[Folityn light rail tools] XHR hook failed',e);
}

function setFilter(which,on){
  localStorage.setItem(KEY+which,on?'1':'0');
  location.reload();
}

function makeToggle(label,kind,icon){
  const on=kind==='trams'?tramsOn():kind==='buses'?busesOn():simplifyOn();
  const b=document.createElement('button');
  b.type='button';
  b.className='folityn-lr-toggle'+(on?' is-on':' is-off');
  b.dataset.kind=kind;
  b.innerHTML=`<span class="folityn-lr-icon">${icon}</span><span>${label}</span><span class="folityn-lr-state">${on?'ON':'OFF'}</span>`;
  b.addEventListener('click',()=>setFilter(kind,!on));
  return b;
}

function buildControls(){
  const box=document.createElement('div');
  box.id='folityn-lr-filters';
  const title=document.createElement('div');
  title.className='folityn-lr-title';
  title.textContent='Light Rail';
  box.append(
    title,
    makeToggle('Trams 1–20','trams','🚋'),
    makeToggle('Buses 100+','buses','🚌'),
    makeToggle('Simplify corridors','simplify','↗')
  );
  return box;
}

function findLightRailAnchor(){
  const all=[...document.querySelectorAll('app-map *, app-root *, body *')];
  const exact=all.find(el=>el.children.length<=2&&el.textContent?.trim()==='Light Rail');
  if(!exact) return null;
  let row=exact;
  for(let i=0;i<5&&row.parentElement;i++){
    const p=row.parentElement;
    const txt=p.textContent?.trim()||'';
    if(txt.includes('Light Rail')&&txt.length<120) row=p;
    else break;
  }
  return row;
}

function mountControls(){
  if(!document.body) return setTimeout(mountControls,50);
  if(document.getElementById('folityn-lr-filters')) return;

  const style=document.createElement('style');
  style.id='folityn-lr-filter-style';
  style.textContent=`
#folityn-lr-filters{box-sizing:border-box;font:13px/1.2 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#334155;background:#fff;border:1px solid #dbe3ee;border-radius:9px;padding:8px;display:grid;gap:6px;min-width:190px;box-shadow:0 4px 16px #00000014}
.folityn-lr-title{font-weight:700;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;padding:0 2px 2px}
.folityn-lr-toggle{appearance:none;border:1px solid #dbe3ee;background:#f8fafc;color:#334155;border-radius:7px;padding:7px 8px;display:grid;grid-template-columns:22px 1fr auto;align-items:center;gap:6px;text-align:left;cursor:pointer;font:inherit}
.folityn-lr-toggle:hover{background:#eef4fa}.folityn-lr-toggle.is-off{opacity:.58}.folityn-lr-toggle.is-on{border-color:#b9c9dc;background:#f3f7fb}.folityn-lr-icon{font-size:15px}.folityn-lr-state{font-size:10px;font-weight:800;letter-spacing:.04em;color:#64748b}
@media (prefers-color-scheme:dark){#folityn-lr-filters{background:#101827;color:#e5edf7;border-color:#334155;box-shadow:0 4px 18px #0008}.folityn-lr-title{color:#94a3b8}.folityn-lr-toggle{background:#162033;color:#e5edf7;border-color:#334155}.folityn-lr-toggle:hover{background:#1d2a40}.folityn-lr-toggle.is-on{background:#1a263a;border-color:#52657e}.folityn-lr-state{color:#94a3b8}}
#folityn-lr-filters.folityn-lr-floating{position:fixed;right:18px;top:245px;z-index:2147483646}
`;
  document.head.appendChild(style);

  const box=buildControls();
  const anchor=findLightRailAnchor();
  if(anchor&&anchor.parentElement){
    box.style.margin='6px 0 8px 28px';
    anchor.insertAdjacentElement('afterend',box);
  }else{
    box.classList.add('folityn-lr-floating');
    document.body.appendChild(box);
  }
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountControls,{once:true});
else mountControls();

new MutationObserver(()=>{
  if(!document.getElementById('folityn-lr-filters')) mountControls();
}).observe(document.documentElement,{childList:true,subtree:true});
})();
