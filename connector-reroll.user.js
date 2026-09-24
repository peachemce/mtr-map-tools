// ==UserScript==
// @name         Folityn MTR Map Tools
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.7.1
// @description  v11.3 base + one-sided stop corridors + final hard Rogowska street-axis lock.
// @match        http://localhost:8888/*
// @match        http://127.0.0.1:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @require      https://raw.githubusercontent.com/peachemce/mtr-map-tools/e898fefccbed81c38c1fa0ef1e07b67aa6469760/connector-reroll.user.js
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
const med=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
const dist=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const isLR=r=>{const t=norm(r?.type);return t==='train_light_rail'||t==='light_rail'||t.includes('light_rail')};
const num=r=>{const m=String(r?.name??r?.routeName??r?.route_name??'').match(/\d+/);return m?+m[0]:null};
const cls=r=>{if(!isLR(r))return null;const n=num(r);return n>=1&&n<=20?'tram':n>=100?'bus':null};
const root=e=>e?.data&&typeof e.data==='object'?e.data:e;
function coords(rs){const o=new Map();for(const r of rs||[])for(const s of stops(r)){const id=sid(s),q=pt(s);if(!id||!q)continue;if(!o.has(id))o.set(id,[]);o.get(id).push(q)}const out=new Map();for(const[id,p]of o)out.set(id,{x:med(p.map(q=>q.x)),z:med(p.map(q=>q.z))});return out}
function setAll(rs,id,q){for(const r of rs||[])for(const s of stops(r))if(sid(s)===id)put(s,q)}
function lcs(a,b){const n=a.length,m=b.length,d=Array.from({length:n+1},()=>new Uint16Array(m+1));for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)d[i][j]=a[i]===b[j]?1+d[i+1][j+1]:Math.max(d[i+1][j],d[i][j+1]);const o=[];let i=0,j=0;while(i<n&&j<m){if(a[i]===b[j]){o.push(a[i]);i++;j++}else d[i+1][j]>=d[i][j+1]?i++:j++}return o}
function apos(seq,a){const o=[];let p=0;for(const id of a){while(p<seq.length&&seq[p]!==id)p++;if(p===seq.length)return null;o.push(p++)}return o}
const seq=r=>stops(r).map(sid).filter(Boolean);
function proposal(map,id,q){if(!map.has(id))map.set(id,[]);map.get(id).push(q)}
function project(s,i0,i1,extra,C,A,B,P){const local=s.slice(i0,i1+1),p=local.map(id=>C.get(id));let total=0,c=[0];for(let i=1;i<local.length;i++){total+=p[i-1]&&p[i]?dist(p[i-1],p[i]):1;c.push(total)}if(!total)total=local.length-1;let n=0;for(let i=1;i<local.length-1;i++){const id=local[i];if(!extra.has(id))continue;const t=clamp(c[i]/total,.08,.92);proposal(P,id,{x:A.x+(B.x-A.x)*t,z:A.z+(B.z-A.z)*t});n++}return n}
function pair(ra,rb,C,P){const a=seq(ra),b0=seq(rb);if(a.length<2||b0.length<2)return[0,0];const f=lcs(a,b0),br=[...b0].reverse(),rv=lcs(a,br),b=rv.length>f.length?br:b0,an=rv.length>f.length?rv:f;if(an.length<2)return[0,0];const pa=apos(a,an),pb=apos(b,an);if(!pa||!pb)return[0,0];let seg=0,mov=0;for(let k=0;k<an.length-1;k++){const ea=a.slice(pa[k]+1,pa[k+1]),eb=b.slice(pb[k]+1,pb[k+1]);if(!ea.length&&!eb.length)continue;if(ea.length>3||eb.length>3||ea.length+eb.length>5)continue;const A=C.get(an[k]),B=C.get(an[k+1]);if(!A||!B||dist(A,B)<20)continue;const xa=new Set(ea.filter(x=>!eb.includes(x))),xb=new Set(eb.filter(x=>!ea.includes(x)));if(!xa.size&&!xb.size)continue;mov+=project(a,pa[k],pa[k+1],xa,C,A,B,P)+project(b,pb[k],pb[k+1],xb,C,A,B,P);seg++}return[seg,mov]}
function normalizeOneWay(e){const d=root(e);if(!d||!Array.isArray(d.routes))return e;const lr=d.routes.filter(isLR),C=coords(lr),G=new Map();for(const r of lr){const n=num(r),c=cls(r);if(!Number.isFinite(n)||!c)continue;const k=`${c}:${n}`;if(!G.has(k))G.set(k,[]);G.get(k).push(r)}const P=new Map(),details=[];let pairs=0,segs=0,cands=0;for(const[k,rs]of G){if(rs.length<2)continue;let gs=0,gm=0;for(let i=0;i<rs.length;i++)for(let j=i+1;j<rs.length;j++){const[s,m]=pair(rs[i],rs[j],C,P);if(s)pairs++;gs+=s;gm+=m}if(gs)details.push({line:k,variants:rs.length,segments:gs,candidates:gm});segs+=gs;cands+=gm}let moved=0;for(const[id,ps]of P){setAll(d.routes,id,{x:med(ps.map(q=>q.x)),z:med(ps.map(q=>q.z))});moved++}window.__folitynOneWayCorridorDebug={groups:G.size,pairs,segments:segs,candidates:cands,movedStops:moved,details};return e}

function namesById(d){const out=new Map();for(const s of d?.stations||[])out.set(String(s.id??s.hexId??s.stationId??''),String(s.name??''));return out}
function findNamedId(names,candidates){const wanted=new Set(candidates.map(norm));for(const[id,name]of names)if(wanted.has(norm(name)))return id;return null}

// FINAL INVARIANT: Rogowska is a physical street corridor, not a route-topology guess.
// Grochowa is deliberately never used to determine this geometry.
function patchRogowskaGeometry(e){
  const d=root(e);if(!d||!Array.isArray(d.routes))return e;
  const names=namesById(d),C=coords(d.routes);
  const rcmId=findNamedId(names,['Rogowska Centrum Miejskie']);
  const dabkaId=findNamedId(names,['Rogowska/Dąbka','Rogowska/Dabka']);
  const rogId=findNamedId(names,['Rogowska']);
  const norId=findNamedId(names,['Szwedzka/Norweska','Szwedzka Norweska']);
  const stadiumId=findNamedId(names,['Szwedzka Stadion']);
  const ids={rcmId,dabkaId,rogId,norId,stadiumId};
  if(Object.values(ids).some(v=>!v)){window.__folitynRogowskaConstraintDebug={ok:false,reason:'required named station missing',...ids};return e}
  const rcm=C.get(rcmId),dabka=C.get(dabkaId),rawRog=C.get(rogId),rawNor=C.get(norId),stadium=C.get(stadiumId);
  if(!rcm||!dabka||!rawRog||!rawNor||!stadium){window.__folitynRogowskaConstraintDebug={ok:false,reason:'required station coordinates missing',rcm:!!rcm,dabka:!!dabka,rog:!!rawRog,nor:!!rawNor,stadium:!!stadium};return e}

  // Inherit ONLY the already-established RCM -> Rogowska/Dabka street direction,
  // then snap it to an exact 45-degree continuation.
  let sx=Math.sign(dabka.x-rcm.x),sz=Math.sign(dabka.z-rcm.z);
  if(!sx)sx=Math.sign(rawNor.x-dabka.x)||1;
  if(!sz)sz=Math.sign(rawNor.z-dabka.z)||1;
  const inv=Math.SQRT1_2,ux=sx*inv,uz=sz*inv;

  // Szwedzka/Norweska lies farther along that SAME axis and is vertically aligned
  // with Szwedzka Stadion. No service path and no Grochowa coordinate participates.
  let tNor=(stadium.x-dabka.x)/ux;
  if(!Number.isFinite(tNor)||tNor<=0)tNor=Math.max(dist(dabka,rawNor),dist(dabka,rawRog)+80);
  const norTarget={x:stadium.x,z:dabka.z+uz*tNor};

  const d1=Math.max(1,dist(dabka,rawRog)),d2=Math.max(1,dist(rawRog,rawNor));
  const ratio=clamp(d1/(d1+d2),.18,.82),tRog=tNor*ratio;
  const rogTarget={x:dabka.x+ux*tRog,z:dabka.z+uz*tRog};

  // Run last and replace EVERY occurrence so earlier generic normalization cannot undo it.
  setAll(d.routes,rogId,rogTarget);
  setAll(d.routes,norId,norTarget);
  window.__folitynRogowskaConstraintDebug={ok:true,sourceAxis:'Rogowska Centrum Miejskie -> Rogowska/Dabka',runsAfterOneWay:true,grochowaUsed:false,rcm,dabka,rogowskaBefore:rawRog,rogowskaAfter:rogTarget,szwedzkaNorweskaBefore:rawNor,szwedzkaNorweskaAfter:norTarget,szwedzkaStadion:stadium,axis45ErrorRog:Math.abs(Math.abs(rogTarget.x-dabka.x)-Math.abs(rogTarget.z-dabka.z)),axis45ErrorNor:Math.abs(Math.abs(norTarget.x-dabka.x)-Math.abs(norTarget.z-dabka.z))};
  return e
}

function transform(o){normalizeOneWay(o);patchRogowskaGeometry(o);return o}
function text(t){try{return JSON.stringify(transform(JSON.parse(t)))}catch(e){console.warn('[Folityn map tools]',e);return t}}
const priorFetch=window.fetch.bind(window);window.fetch=async function(i,n){const u=typeof i==='string'?i:i?.url||'',r=await priorFetch(i,n);if(!TARGET.test(u))return r;try{return new Response(text(await r.clone().text()),{status:r.status,statusText:r.statusText,headers:r.headers})}catch(e){console.warn('[Folityn map tools fetch]',e);return r}};
try{const p=XMLHttpRequest.prototype,tg=Object.getOwnPropertyDescriptor(p,'responseText')?.get,rg=Object.getOwnPropertyDescriptor(p,'response')?.get,cache=new WeakMap();if(tg)Object.defineProperty(p,'responseText',{configurable:true,get(){const raw=tg.call(this);if(!this.__folitynLRFilter||this.readyState!==4||typeof raw!=='string')return raw;let x=cache.get(this)||{};if(x.text===undefined)x.text=text(raw);cache.set(this,x);return x.text}});if(rg)Object.defineProperty(p,'response',{configurable:true,get(){const raw=rg.call(this);if(!this.__folitynLRFilter||this.readyState!==4)return raw;let x=cache.get(this)||{};if(this.responseType==='json'&&raw&&typeof raw==='object'){if(x.json===undefined){x.json=typeof structuredClone==='function'?structuredClone(raw):JSON.parse(JSON.stringify(raw));transform(x.json)}cache.set(this,x);return x.json}if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){if(x.text===undefined)x.text=text(raw);cache.set(this,x);return x.text}return raw}})}catch(e){console.warn('[Folityn map tools XHR]',e)}
})();
