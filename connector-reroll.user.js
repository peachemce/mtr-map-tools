// ==UserScript==
// @name         Folityn MTR Map Tools
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.6.1
// @description  Exact v11.3 schematic base plus an isolated Rogowska 45-degree corridor. Grochowa is never used to route it.
// @match        http://localhost:8888/*
// @match        http://127.0.0.1:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @require      https://raw.githubusercontent.com/peachemce/mtr-map-tools/e898fefccbed81c38c1fa0ef1e07b67aa6469760/connector-reroll.user.js
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==
(() => {
'use strict';

const TARGET=/\/mtr\/api\/map\/stations-and-routes(?:\?|$)/;
const n=s=>String(s??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
const routeStops=r=>Array.isArray(r?.stations)?r.stations:Array.isArray(r?.routeStations)?r.routeStations:Array.isArray(r?.platforms)?r.platforms:[];
const stopId=s=>String(s?.id??s?.hexId??s?.stationId??'');
const point=s=>{const x=Number(s?.x??s?.position?.x),z=Number(s?.z??s?.position?.z);return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null};
const setPoint=(s,q)=>{'x'in s||!s.position?(s.x=q.x,s.z=q.z):(s.position={...s.position,x:q.x,z:q.z})};
const median=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
const distance=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

function dataRoot(env){return env?.data&&typeof env.data==='object'?env.data:env}
function namesById(data){
  const out=new Map();
  for(const s of data?.stations||[])out.set(String(s.id??s.hexId??s.stationId??''),String(s.name??''));
  return out;
}
function findNamedId(nameMap,candidates){
  const wanted=new Set(candidates.map(n));
  for(const[id,name]of nameMap)if(wanted.has(n(name)))return id;
  return null;
}
function coordsById(routes){
  const occ=new Map();
  for(const r of routes||[])for(const st of routeStops(r)){
    const id=stopId(st),q=point(st);if(!id||!q)continue;
    if(!occ.has(id))occ.set(id,[]);occ.get(id).push(q);
  }
  const out=new Map();
  for(const[id,ps]of occ)out.set(id,{x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))});
  return out;
}
function setEveryOccurrence(routes,id,q){
  for(const r of routes||[])for(const st of routeStops(r))if(stopId(st)===id)setPoint(st,q);
}

/*
  IMPORTANT: this is deliberately NOT route-topology based.

  We do NOT search for a service path from Rogowska to Szwedzka/Norweska.
  We do NOT use Grochowa as an intermediate node or guide.

  The physical schematic rule is:
      RCM -> Rogowska/Dabka already establishes the Rogowska street axis.
      Extend that same axis at exactly 45 degrees.
      Put Rogowska on that extension.
      Put Szwedzka/Norweska farther along that same extension.
      Lock Szwedzka/Norweska directly below Szwedzka Stadion (same X).

  This keeps the Rogowska corridor independent from the Kotlandzka/Grochowa
  corridor even when a service happens to call at stations on both streets.
*/
function patchRogowskaGeometry(env){
  if(!env||typeof env!=='object')return env;
  const data=dataRoot(env);if(!data||!Array.isArray(data.routes))return env;

  const names=namesById(data),coords=coordsById(data.routes);
  const rcmId=findNamedId(names,['Rogowska Centrum Miejskie']);
  const dabkaId=findNamedId(names,['Rogowska/Dąbka','Rogowska/Dabka']);
  const rogId=findNamedId(names,['Rogowska']);
  const norId=findNamedId(names,['Szwedzka/Norweska','Szwedzka Norweska']);
  const stadiumId=findNamedId(names,['Szwedzka Stadion']);

  const ids={rcmId,dabkaId,rogId,norId,stadiumId};
  if(Object.values(ids).some(v=>!v)){
    window.__folitynRogowskaConstraintDebug={ok:false,reason:'required named station missing',...ids};
    return env;
  }

  const rcm=coords.get(rcmId),dabka=coords.get(dabkaId),rawRog=coords.get(rogId),rawNor=coords.get(norId),stadium=coords.get(stadiumId);
  if(!rcm||!dabka||!rawRog||!rawNor||!stadium){
    window.__folitynRogowskaConstraintDebug={ok:false,reason:'required station coordinates missing',rcm:!!rcm,dabka:!!dabka,rog:!!rawRog,nor:!!rawNor,stadium:!!stadium};
    return env;
  }

  // Direction is inherited ONLY from the already-good RCM -> Rogowska/Dabka leg.
  // Snap that direction to an exact 45-degree diagonal.
  let sx=Math.sign(dabka.x-rcm.x),sz=Math.sign(dabka.z-rcm.z);
  if(!sx)sx=Math.sign(rawNor.x-dabka.x)||1;
  if(!sz)sz=Math.sign(rawNor.z-dabka.z)||1;
  const inv=Math.SQRT1_2,ux=sx*inv,uz=sz*inv;

  // Szwedzka/Norweska must be vertically aligned with Szwedzka Stadion.
  // Solve the point on the 45-degree Rogowska axis at stadium.x.
  let tNor=(stadium.x-dabka.x)/ux;
  if(!Number.isFinite(tNor)||tNor<=0){
    // Defensive fallback: preserve the correct direction and approximate distance.
    tNor=Math.max(distance(dabka,rawNor),distance(dabka,rawRog)+80);
  }
  const norTarget={x:dabka.x+ux*tNor,z:dabka.z+uz*tNor};
  // Make X exact, avoiding floating-point residue.
  norTarget.x=stadium.x;

  // Preserve Rogowska's approximate relative spacing between Dabka and Norweska,
  // but force it onto the SAME physical diagonal instead of toward Grochowa.
  const d1=Math.max(1,distance(dabka,rawRog));
  const d2=Math.max(1,distance(rawRog,rawNor));
  const ratio=clamp(d1/(d1+d2),0.18,0.82);
  const tRog=tNor*ratio;
  const rogTarget={x:dabka.x+ux*tRog,z:dabka.z+uz*tRog};

  setEveryOccurrence(data.routes,rogId,rogTarget);
  setEveryOccurrence(data.routes,norId,norTarget);

  window.__folitynRogowskaConstraintDebug={
    ok:true,
    sourceAxis:'Rogowska Centrum Miejskie -> Rogowska/Dabka',
    grochowaUsed:false,
    rcm,dabka,
    rogowskaBefore:rawRog,rogowskaAfter:rogTarget,
    szwedzkaNorweskaBefore:rawNor,szwedzkaNorweskaAfter:norTarget,
    szwedzkaStadion:stadium,
    verticalError:Math.abs(norTarget.x-stadium.x),
    axis45ErrorRog:Math.abs(Math.abs(rogTarget.x-dabka.x)-Math.abs(rogTarget.z-dabka.z)),
    axis45ErrorNor:Math.abs(Math.abs(norTarget.x-dabka.x)-Math.abs(norTarget.z-dabka.z))
  };
  return env;
}

function transformText(text){
  try{const obj=JSON.parse(text);patchRogowskaGeometry(obj);return JSON.stringify(obj)}
  catch(e){console.warn('[Folityn Rogowska geometry] text patch failed',e);return text}
}

// v11.3 is already installed by @require. Wrap its transformed fetch output,
// then apply ONLY the isolated Rogowska geometry correction.
const priorFetch=window.fetch.bind(window);
window.fetch=async function(input,init){
  const url=typeof input==='string'?input:input?.url||'',response=await priorFetch(input,init);
  if(!TARGET.test(url))return response;
  try{return new Response(transformText(await response.clone().text()),{status:response.status,statusText:response.statusText,headers:response.headers})}
  catch(e){console.warn('[Folityn Rogowska geometry] fetch patch failed',e);return response}
};

// v11.3 marks target XHR requests with __folitynLRFilter. Patch only their
// already-transformed output; do not replace its request handling.
try{
  const proto=XMLHttpRequest.prototype;
  const textDesc=Object.getOwnPropertyDescriptor(proto,'responseText');
  const respDesc=Object.getOwnPropertyDescriptor(proto,'response');
  const textGetter=textDesc?.get,respGetter=respDesc?.get,cache=new WeakMap();

  if(textGetter)Object.defineProperty(proto,'responseText',{configurable:true,get(){
    const raw=textGetter.call(this);
    if(!this.__folitynLRFilter||this.readyState!==4||typeof raw!=='string')return raw;
    let item=cache.get(this);if(!item){item={};cache.set(this,item)}
    if(item.text===undefined)item.text=transformText(raw);
    return item.text;
  }});

  if(respGetter)Object.defineProperty(proto,'response',{configurable:true,get(){
    const raw=respGetter.call(this);
    if(!this.__folitynLRFilter||this.readyState!==4)return raw;
    let item=cache.get(this);if(!item){item={};cache.set(this,item)}
    if(this.responseType==='json'&&raw&&typeof raw==='object'){
      if(item.json===undefined){
        item.json=typeof structuredClone==='function'?structuredClone(raw):JSON.parse(JSON.stringify(raw));
        patchRogowskaGeometry(item.json);
      }
      return item.json;
    }
    if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){
      if(item.text===undefined)item.text=transformText(raw);
      return item.text;
    }
    return raw;
  }});
}catch(e){console.warn('[Folityn Rogowska geometry] XHR output patch failed',e)}
})();
