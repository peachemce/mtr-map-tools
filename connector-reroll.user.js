// ==UserScript==
// @name         MTR Map Tools - Folityn Shared Train Corridors v10.1
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      10.1.0
// @description  Centralny Rail/High Speed rendered from one shared physical corridor graph, mounted inside the MTR map.
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
const CENTRAL='folityn centralny';
const KEY='folityn-v101-';
const ON=localStorage.getItem(KEY+'on')!=='0';
const norm=s=>String(s??'').trim().replace(/\s+/g,' ').toLowerCase();
const routeType=r=>norm(r?.type).replace(/[\s-]+/g,'_');
const isTrain=r=>{const t=routeType(r);return t==='train_normal'||t==='train_high_speed'||t==='normal'||t==='high_speed'||t.includes('train_normal')||t.includes('train_high_speed')};
const rs=r=>Array.isArray(r?.stations)?r.stations:Array.isArray(r?.routeStations)?r.routeStations:Array.isArray(r?.platforms)?r.platforms:[];
const sid=s=>String(s?.id??s?.hexId??s?.stationId??'');
const p=s=>{const x=Number(s?.x??s?.position?.x),z=Number(s?.z??s?.position?.z);return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null};
const med=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
const d=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z);
const hex=n=>'#'+(Number(n)>>>0).toString(16).padStart(6,'0').slice(-6);
const base=n=>norm(n).replace(/\s+[12]$/,'').replace(/([a-z])([12])$/,'$1');
const sk=r=>`${routeType(r)}|${Number(r?.color)||0}|${base(r?.name||'')}`;
let MODEL=null,NATIVE=new Map(),LAST_DEBUG='waiting for route data';
const groupName=n=>{n=norm(n);if(n===CENTRAL)return CENTRAL;if(n==='folityn jamnikowsko'||n==='jamnikowsko pkm')return'folityn jamnikowsko';if(n==='folityn wity'||n==='wity pkm')return'wity';return'name:'+n};
function alt(a,c,adj,pts){
 const A=pts.get(a),C=pts.get(c);if(!A||!C)return null;
 const direct=Math.max(1,d(A,C));let best=null;const seen=new Set([a]);
 const walk=(n,path,len)=>{if(path.length>6)return;if(n===c){if(path.length<=2)return;const vx=C.x-A.x,vz=C.z-A.z,vv=vx*vx+vz*vz;let perp=0;for(const k of path.slice(1,-1)){const q=pts.get(k);if(!q)continue;const t=vv?((q.x-A.x)*vx+(q.z-A.z)*vz)/vv:0;perp=Math.max(perp,d(q,{x:A.x+vx*t,z:A.z+vz*t}))}if(len<=direct*1.25&&perp<=Math.max(110,direct*.15)&&(!best||len<best.len))best={path:[...path],len};return}
 for(const x of adj.get(n)||[]){if((n===a&&x===c)||seen.has(x))continue;const P=pts.get(n),Q=pts.get(x);if(!P||!Q)continue;const nl=len+d(P,Q);if(nl>direct*1.30)continue;seen.add(x);path.push(x);walk(x,path,nl);path.pop();seen.delete(x)}};
 walk(a,[a],0);return best?.path||null;
}
function build(src){
 const top=new Map((src.stations||[]).map(s=>[sid(s),s]));
 const sname=s=>norm(top.get(sid(s))?.name??s?.name);
 const trains=(src.routes||[]).filter(isTrain);
 const sel=trains.filter(r=>rs(r).some(s=>sname(s)===CENTRAL));
 LAST_DEBUG=`train routes ${trains.length}; Centralny ${sel.length}`;
 if(!sel.length)return null;
 const occ=new Map();
 for(const r of sel)for(const s of rs(r)){const k=sid(s),q=p(s);if(!k||!q)continue;if(!occ.has(k))occ.set(k,[]);occ.get(k).push(q)}
 const raw2log=new Map(),members=new Map(),names=new Map();
 for(const k of occ.keys()){const disp=String(top.get(k)?.name??k),g=groupName(disp);raw2log.set(k,g);if(!members.has(g))members.set(g,[]);members.get(g).push(k);names.set(g,g.startsWith('name:')?disp:g===CENTRAL?'Folityn Centralny':g==='wity'?'Wity':'Folityn Jamnikowsko')}
 const pts=new Map();
 for(const [g,ids] of members){const q=ids.flatMap(k=>occ.get(k)||[]);pts.set(g,{x:med(q.map(v=>v.x)),z:med(q.map(v=>v.z))})}
 const C=pts.get(CENTRAL);if(!C){LAST_DEBUG+='; Centralny has no coordinates';return null}
 const vars=sel.map(r=>{const q=[];for(const s of rs(r)){const g=raw2log.get(sid(s));if(g&&q.at(-1)!==g)q.push(g)}return{r,key:sk(r),seq:q}}).filter(v=>v.seq.length>1);
 const adj=new Map([...pts.keys()].map(k=>[k,new Set()]));
 for(const v of vars)for(let i=1;i<v.seq.length;i++){const a=v.seq[i-1],b=v.seq[i];adj.get(a)?.add(b);adj.get(b)?.add(a)}
 for(const v of vars){const out=[v.seq[0]];for(let i=1;i<v.seq.length;i++){const a=v.seq[i-1],c=v.seq[i],q=alt(a,c,adj,pts);out.push(...(q&&q.length>2?q.slice(1):[c]))}v.seq=out.filter((x,i,a)=>!i||x!==a[i-1])}
 const sv=new Map();
 for(const v of vars){if(!sv.has(v.key))sv.set(v.key,{name:base(v.r?.name||''),color:+v.r?.color||0,type:routeType(v.r)});}
 const order=[...sv.keys()].sort((a,b)=>sv.get(a).color-sv.get(b).color||sv.get(a).name.localeCompare(sv.get(b).name));
 const lane=new Map(order.map((k,i)=>[k,i-(order.length-1)/2]));
 const ek=(a,b)=>a<b?`${a}__${b}`:`${b}__${a}`;
 const rawEdges=new Map();
 const add=(map,a,b,k)=>{const e=ek(a,b);if(!map.has(e))map.set(e,{a:a<b?a:b,b:a<b?b:a,s:new Set()});map.get(e).s.add(k)};
 for(const v of vars)for(let i=1;i<v.seq.length;i++)add(rawEdges,v.seq[i-1],v.seq[i],v.key);
 const lens=[];for(const e of rawEdges.values())if(pts.get(e.a)&&pts.get(e.b))lens.push(d(pts.get(e.a),pts.get(e.b)));
 const typical=Math.max(240,med(lens.filter(x=>x>30))||600),half=Math.max(160,Math.min(420,typical*.38));
 pts.set('__N',{x:C.x,z:C.z+half});pts.set('__S',{x:C.x,z:C.z-half});
 const side=n=>{const q=pts.get(n);if(!q)return'N';const dz=q.z-C.z;if(Math.abs(dz)>typical*.08)return dz>0?'N':'S';return q.x>=C.x?'N':'S'};
 const edges=new Map();
 for(const e of rawEdges.values())if(e.a!==CENTRAL&&e.b!==CENTRAL)for(const k of e.s)add(edges,e.a,e.b,k);
 const use=new Map([...sv.keys()].map(k=>[k,{N:false,S:false,through:false}]));
 for(const v of vars){const i=v.seq.indexOf(CENTRAL);if(i<0)continue;const a=i?v.seq[i-1]:null,b=i<v.seq.length-1?v.seq[i+1]:null;if(a){const s=side(a);use.get(v.key)[s]=true;add(edges,a,'__'+s,v.key)}if(b){const s=side(b);use.get(v.key)[s]=true;add(edges,'__'+s,b,v.key)}if(a&&b)use.get(v.key).through=true}
 for(const [k,u] of use){if(u.through||(u.N&&u.S)){add(edges,'__N',CENTRAL,k);add(edges,CENTRAL,'__S',k)}else if(u.N)add(edges,'__N',CENTRAL,k);else if(u.S)add(edges,CENTRAL,'__S',k)}
 LAST_DEBUG+=`; services ${sv.size}; edges ${edges.size}`;
 return{ids:new Set(sel.map(r=>String(r?.id??''))),pts,names,sv,lane,edges,central:CENTRAL};
}
function nativePts(data){
 const top=new Map((data.stations||[]).map(s=>[sid(s),s])),o=new Map();
 for(const r of data.routes||[])for(const s of rs(r)){const q=p(s),k=sid(s);if(!q||!k)continue;if(!o.has(k))o.set(k,[]);o.get(k).push(q)}
 const by=new Map();for(const [k,ps] of o){const n=norm(top.get(k)?.name);if(!n)continue;if(!by.has(n))by.set(n,[]);by.get(n).push({x:med(ps.map(q=>q.x)),z:med(ps.map(q=>q.z))})}
 const out=new Map();for(const [n,ps] of by)out.set(n,{x:med(ps.map(q=>q.x)),z:med(ps.map(q=>q.z))});return out;
}
function transform(env){
 if(!ON||!env||typeof env!=='object')return env;
 const src=env.data&&typeof env.data==='object'?env.data:env;if(!Array.isArray(src.routes)||!Array.isArray(src.stations))return env;
 MODEL=build(src);
 const out=typeof structuredClone==='function'?structuredClone(env):JSON.parse(JSON.stringify(env)),data=out.data&&typeof out.data==='object'?out.data:out;
 if(MODEL)data.routes=(data.routes||[]).filter(r=>!MODEL.ids.has(String(r?.id??'')));
 NATIVE=nativePts(data);return out;
}
const tx=t=>{try{return JSON.stringify(transform(JSON.parse(t)))}catch(e){LAST_DEBUG='transform error: '+e.message;console.error('[Folityn v10.1]',e);return t}};
const nf=window.fetch.bind(window);
window.fetch=async function(i,o){const u=typeof i==='string'?i:i?.url||'',r=await nf(i,o);if(!TARGET.test(u))return r;try{return new Response(tx(await r.clone().text()),{status:r.status,statusText:r.statusText,headers:r.headers})}catch(e){console.error('[Folityn v10.1 fetch]',e);return r}};
try{
 const xp=XMLHttpRequest.prototype,op=xp.open,tg=Object.getOwnPropertyDescriptor(xp,'responseText')?.get,rg=Object.getOwnPropertyDescriptor(xp,'response')?.get,c=new WeakMap();
 xp.open=function(m,u,...x){this.__f101=TARGET.test(String(u));c.delete(this);return op.call(this,m,u,...x)};
 if(tg)Object.defineProperty(xp,'responseText',{configurable:true,get(){const r=tg.call(this);if(!this.__f101||this.readyState!==4||typeof r!=='string')return r;let x=c.get(this);if(!x){x={t:tx(r)};c.set(this,x)}return x.t}});
 if(rg)Object.defineProperty(xp,'response',{configurable:true,get(){const r=rg.call(this);if(!this.__f101||this.readyState!==4)return r;let x=c.get(this)||{};if(this.responseType==='json'&&r&&typeof r==='object'){if(!x.j){x.j=transform(r);c.set(this,x)}return x.j}if((this.responseType===''||this.responseType==='text')&&typeof r==='string'){if(!x.t){x.t=tx(r);c.set(this,x)}return x.t}return r}});
}catch(e){console.error('[Folityn v10.1 XHR]',e)}
function screenPoint(el){const r=el.getBoundingClientRect();return r.width||r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null}
function view(){
 const a=[];for(const el of document.querySelectorAll('app-map .label[aria-label]')){const q=screenPoint(el),w=NATIVE.get(norm(el.getAttribute('aria-label')));if(q&&w)a.push({q,w})}
 if(a.length<2){LAST_DEBUG=(LAST_DEBUG.split('; screen anchors')[0])+`; screen anchors ${a.length}`;return null}
 const scales=[];for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++){const dx=a[j].w.x-a[i].w.x,dz=a[j].w.z-a[i].w.z;if(Math.abs(dx)>120)scales.push((a[j].q.x-a[i].q.x)/dx);if(Math.abs(dz)>120)scales.push((a[j].q.y-a[i].q.y)/(-dz))}
 const s=scales.filter(x=>Number.isFinite(x)&&Math.abs(x)>.0001);if(!s.length){LAST_DEBUG+='; no usable scale';return null}
 const k=med(s);LAST_DEBUG=(LAST_DEBUG.split('; screen anchors')[0])+`; screen anchors ${a.length}`;
 return{k,tx:med(a.map(x=>x.q.x-k*x.w.x)),ty:med(a.map(x=>x.q.y+k*x.w.z))};
}
function geom(a,b){const dx=b.x-a.x,dz=b.z-a.z,x=Math.abs(dx),z=Math.abs(dz),eps=Math.max(30,Math.min(x,z)*.16);if(x<eps||z<eps||Math.abs(x-z)<Math.max(35,Math.max(x,z)*.12))return[a,b];return x>z?[a,{x:a.x+Math.sign(dx)*(x-z),z:a.z},b]:[a,{x:a.x,z:a.z+Math.sign(dz)*(z-x)},b]}
function off(P,o){if(Math.abs(o)<.01)return P;const seg=[];for(let i=0;i<P.length-1;i++){const a=P[i],b=P[i+1],dx=b.x-a.x,dz=b.z-a.z,l=Math.hypot(dx,dz)||1;seg.push({x:-dz/l,z:dx/l})}return P.map((p,i)=>{let n=i?i===P.length-1?seg.at(-1):{x:seg[i-1].x+seg[i].x,z:seg[i-1].z+seg[i].z}:seg[0],l=Math.hypot(n.x,n.z)||1;return{x:p.x+n.x/l*o,z:p.z+n.z/l*o}})}
function dpath(P){let q=`M ${P[0].x} ${P[0].y}`;if(P.length===2)return q+` L ${P[1].x} ${P[1].y}`;for(let i=1;i<P.length-1;i++){const p=P[i],n=P[i+1];q+=` Q ${p.x} ${p.y} ${(p.x+n.x)/2} ${(p.y+n.y)/2}`}return q+` L ${P.at(-1).x} ${P.at(-1).y}`}
function install(){
 if(!document.body)return setTimeout(install,50);
 const host=document.querySelector('app-map');if(!host)return setTimeout(install,100);
 const ns='http://www.w3.org/2000/svg';
 const svg=document.createElementNS(ns,'svg');svg.id='f101';svg.setAttribute('width','100%');svg.setAttribute('height','100%');svg.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483646;pointer-events:none;overflow:visible';host.appendChild(svg);
 const st=document.createElement('style');st.textContent='#f101 path{fill:none;stroke-linecap:round;stroke-linejoin:round}.f101s{fill:#0b1220;stroke:#eef4ff;stroke-width:2}.f101h{fill:#0b1220;stroke:#eef4ff;stroke-width:3}.f101t{font:600 12px Arial;fill:#eef4ff;paint-order:stroke;stroke:#0b1220;stroke-width:3px}#f101p{position:fixed;left:14px;bottom:14px;z-index:2147483647;background:#0b1220f5;color:#fff;padding:8px 10px;border:1px solid #ffffff33;border-radius:9px;font:12px Arial;pointer-events:none;max-width:330px}';document.head.appendChild(st);
 const box=document.createElement('div');box.id='f101p';box.innerHTML='<b>Shared train corridors v10.1</b><br><span id="f101d" style="opacity:.7">script loaded</span>';host.appendChild(box);
 let sig='';
 function draw(){requestAnimationFrame(draw);const dbg=box.querySelector('#f101d');if(dbg)dbg.textContent=LAST_DEBUG;if(!MODEL)return;const V=view();if(!V)return;const z=[V.k.toFixed(5),V.tx.toFixed(1),V.ty.toFixed(1),MODEL.edges.size].join('|');if(z===sig)return;sig=z;svg.replaceChildren();const S=q=>({x:V.tx+V.k*q.x,y:V.ty-V.k*q.z});
 for(const e of MODEL.edges.values()){const A=MODEL.pts.get(e.a),B=MODEL.pts.get(e.b);if(!A||!B)continue;const casing=document.createElementNS(ns,'path');casing.setAttribute('d',dpath(geom(A,B).map(S)));casing.setAttribute('stroke','#080b10');casing.setAttribute('stroke-width',String(8+Math.max(0,e.s.size-1)*4.5));svg.appendChild(casing);for(const k of [...e.s].sort((a,b)=>(MODEL.lane.get(a)||0)-(MODEL.lane.get(b)||0))){const svc=MODEL.sv.get(k),o=(MODEL.lane.get(k)||0)*4.5/Math.max(.25,Math.abs(V.k)),P=off(geom(A,B),o).map(S),path=document.createElementNS(ns,'path');path.setAttribute('d',dpath(P));path.setAttribute('stroke',hex(svc.color));path.setAttribute('stroke-width',svc.type.includes('high_speed')?'3.8':'3.2');svg.appendChild(path)}}
 const nodes=new Set();for(const e of MODEL.edges.values()){nodes.add(e.a);nodes.add(e.b)}
 for(const n of nodes){if(n.startsWith('__'))continue;const q=MODEL.pts.get(n);if(!q)continue;const s=S(q),c=document.createElementNS(ns,n===MODEL.central?'rect':'circle');if(n===MODEL.central){c.setAttribute('x',s.x-18);c.setAttribute('y',s.y-12);c.setAttribute('width',36);c.setAttribute('height',24);c.setAttribute('rx',10);c.setAttribute('class','f101h')}else{c.setAttribute('cx',s.x);c.setAttribute('cy',s.y);c.setAttribute('r',5);c.setAttribute('class','f101s')}svg.appendChild(c);const name=MODEL.names.get(n);if(name){const t=document.createElementNS(ns,'text');t.setAttribute('x',s.x+8);t.setAttribute('y',s.y-7);t.setAttribute('class','f101t');t.textContent=name;svg.appendChild(t)}}
 }
 draw();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
