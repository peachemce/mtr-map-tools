// ==UserScript==
// @name         Folityn MTR Map Tools
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.6.0
// @description  Exact v11.3 schematic base plus isolated Rogowska -> Szwedzka/Norweska geometry constraints.
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
const isLightRail=r=>{const t=n(r?.type);return t==='train_light_rail'||t==='light_rail'||t.includes('light_rail')};
function dataRoot(env){return env?.data&&typeof env.data==='object'?env.data:env}
function namesById(data){const out=new Map();for(const s of data?.stations||[])out.set(String(s.id??s.hexId??s.stationId??''),String(s.name??''));return out}
function findNamedId(nameMap,candidates){const wanted=new Set(candidates.map(n));for(const[id,name]of nameMap)if(wanted.has(n(name)))return id;return null}
function coordsById(routes){const occ=new Map();for(const r of routes||[])for(const st of routeStops(r)){const id=stopId(st),q=point(st);if(!id||!q)continue;if(!occ.has(id))occ.set(id,[]);occ.get(id).push(q)}const out=new Map();for(const[id,ps]of occ)out.set(id,{x:median(ps.map(p=>p.x)),z:median(ps.map(p=>p.z))});return out}
function setEveryOccurrence(routes,id,q){for(const r of routes||[])for(const st of routeStops(r))if(stopId(st)===id)setPoint(st,q)}
function shortestRoutePath(routes,startId,endId){let best=null;for(const r of routes||[]){if(!isLightRail(r))continue;const ids=routeStops(r).map(stopId),starts=[],ends=[];for(let i=0;i<ids.length;i++){if(ids[i]===startId)starts.push(i);if(ids[i]===endId)ends.push(i)}for(const a of starts)for(const b of ends){if(a===b)continue;let seq=a<b?ids.slice(a,b+1):ids.slice(b,a+1).reverse();if(!best||seq.length<best.length)best=seq}}return best}
function chooseVerticalIntersection(rog,rawTarget,stadium){const dx=stadium.x-rog.x,d=Math.abs(dx);if(d<1)return{x:stadium.x,z:rawTarget.z};const candidates=[rog.z+d,rog.z-d],desiredSide=Math.sign(rawTarget.z-stadium.z);let best=candidates[0],score=Infinity;for(const z of candidates){const side=Math.sign(z-stadium.z);let s=Math.abs(z-rawTarget.z);if(desiredSide&&side!==desiredSide)s+=1e6;if(s<score){score=s;best=z}}return{x:stadium.x,z:best}}
function distributeStraight(path,coords,start,end){const out=new Map();if(!path?.length)return out;const pts=path.map(id=>coords.get(id));let total=0;const cum=[0];for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i];total+=a&&b?distance(a,b):1;cum.push(total)}if(total<=0)total=Math.max(1,path.length-1);for(let i=0;i<path.length;i++){const t=path.length===1?0:cum[i]/total;out.set(path[i],{x:start.x+(end.x-start.x)*t,z:start.z+(end.z-start.z)*t})}return out}
function patchEastGeometry(env){
  if(!env||typeof env!=='object')return env;const data=dataRoot(env);if(!data||!Array.isArray(data.routes))return env;
  const nameMap=namesById(data),coords=coordsById(data.routes);
  const rogId=findNamedId(nameMap,['Rogowska']),norId=findNamedId(nameMap,['Szwedzka/Norweska','Szwedzka Norweska']),stadId=findNamedId(nameMap,['Szwedzka Stadion']);
  if(!rogId||!norId||!stadId){window.__folitynEastConstraintDebug={ok:false,rogId,norId,stadId,reason:'station name missing'};return env}
  const rog=coords.get(rogId),rawNor=coords.get(norId),stad=coords.get(stadId);
  if(!rog||!rawNor||!stad){window.__folitynEastConstraintDebug={ok:false,rog:!!rog,rawNor:!!rawNor,stad:!!stad,reason:'station coordinates missing'};return env}
  const path=shortestRoutePath(data.routes,rogId,norId);
  if(!path||path.length<2){window.__folitynEastConstraintDebug={ok:false,reason:'no single light-rail route contains Rogowska and Szwedzka/Norweska'};return env}
  const norTarget=chooseVerticalIntersection(rog,rawNor,stad),straight=distributeStraight(path,coords,rog,norTarget);
  for(const[id,q]of straight)setEveryOccurrence(data.routes,id,q);setEveryOccurrence(data.routes,norId,norTarget);
  window.__folitynEastConstraintDebug={ok:true,path,pathLength:path.length,rogowska:rog,szwedzkaNorweskaBefore:rawNor,szwedzkaNorweskaAfter:norTarget,szwedzkaStadion:stad,verticalError:Math.abs(norTarget.x-stad.x),diagonalError:Math.abs(Math.abs(norTarget.x-rog.x)-Math.abs(norTarget.z-rog.z))};
  return env;
}
function transformText(text){try{const obj=JSON.parse(text);patchEastGeometry(obj);return JSON.stringify(obj)}catch(e){console.warn('[Folityn east geometry] text patch failed',e);return text}}
const priorFetch=window.fetch.bind(window);
window.fetch=async function(input,init){const url=typeof input==='string'?input:input?.url||'',response=await priorFetch(input,init);if(!TARGET.test(url))return response;try{return new Response(transformText(await response.clone().text()),{status:response.status,statusText:response.statusText,headers:response.headers})}catch(e){console.warn('[Folityn east geometry] fetch patch failed',e);return response}};
try{
  const proto=XMLHttpRequest.prototype,textDesc=Object.getOwnPropertyDescriptor(proto,'responseText'),respDesc=Object.getOwnPropertyDescriptor(proto,'response'),textGetter=textDesc?.get,respGetter=respDesc?.get,cache=new WeakMap();
  if(textGetter)Object.defineProperty(proto,'responseText',{configurable:true,get(){const raw=textGetter.call(this);if(!this.__folitynLRFilter||this.readyState!==4||typeof raw!=='string')return raw;let item=cache.get(this);if(!item){item={};cache.set(this,item)}if(item.text===undefined)item.text=transformText(raw);return item.text}});
  if(respGetter)Object.defineProperty(proto,'response',{configurable:true,get(){const raw=respGetter.call(this);if(!this.__folitynLRFilter||this.readyState!==4)return raw;let item=cache.get(this);if(!item){item={};cache.set(this,item)}if(this.responseType==='json'&&raw&&typeof raw==='object'){if(item.json===undefined){item.json=typeof structuredClone==='function'?structuredClone(raw):JSON.parse(JSON.stringify(raw));patchEastGeometry(item.json)}return item.json}if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){if(item.text===undefined)item.text=transformText(raw);return item.text}return raw}});
}catch(e){console.warn('[Folityn east geometry] XHR output patch failed',e)}
})();
