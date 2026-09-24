// ==UserScript==
// @name         MTR Map Tools - Folityn Schematic Native v9
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      9.0.0
// @description  Native MTR renderer with hard schematic corridors, simplified 0/45/90 geometry and grouped interchange hubs.
// @match        http://localhost:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==
(() => {
'use strict';
const TARGET=/\/mtr\/api\/map\/stations-and-routes(?:\?|$)/,KEY='folityn-v9-',ON=localStorage.getItem(KEY+'on')!=='0';
const norm=s=>String(s??'').trim().replace(/\s+/g,' ').toLocaleLowerCase(),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const med=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
const dist=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z),ang=(a,b)=>Math.atan2(b.z-a.z,b.x-a.x),adiff=(a,b)=>{let d=Math.abs(a-b)%(Math.PI*2);return d>Math.PI?Math.PI*2-d:d};
const ray=(o,a,d)=>({x:o.x+Math.cos(a)*d,z:o.z+Math.sin(a)*d}),snap=a=>Math.round(a/(Math.PI/4))*(Math.PI/4);
const rot=(p,o,t)=>{const c=Math.cos(t),s=Math.sin(t),x=p.x-o.x,z=p.z-o.z;return{x:o.x+x*c-z*s,z:o.z+x*s+z*c}};
const proj=(p,a,b)=>{const x=b.x-a.x,z=b.z-a.z,q=x*x+z*z;if(!q)return{...a};const t=((p.x-a.x)*x+(p.z-a.z)*z)/q;return{x:a.x+t*x,z:a.z+t*z}};
const ALIASES=new Map([
 ['folityn centralny','folityn centralny'],['folityn wity','wity'],['wity pkm','wity'],
 ['folityn jamnikowsko','folityn jamnikowsko'],['jamnikowsko pkm','folityn jamnikowsko']
]);
const N={central:['folityn centralny'],rcm:['rogowska centrum miejskie'],east:['szwedzka stadion','szwedzka','norweska'],drzewiec:['folityn drzewiec'],lipkow:['folityn lipków','folityn lipkow'],jam:['folityn jamnikowsko'],wiadukt:['wiadukt torowy'],larcho:['rondo larcho']};
function stations(r){return Array.isArray(r?.stations)?r.stations:Array.isArray(r?.routeStations)?r.routeStations:Array.isArray(r?.platforms)?r.platforms:[]}
function id(s){return String(s?.id??s?.hexId??s?.stationId??'')}
function point(s){const x=Number(s?.x??s?.position?.x),z=Number(s?.z??s?.position?.z);return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null}
function put(s,p){const x=Math.round(p.x*100)/100,z=Math.round(p.z*100)/100;if('x'in s||!s.position)s.x=x;if('z'in s||!s.position)s.z=z;if(s.position){s.position.x=x;s.position.z=z}}
function kind(r){const t=norm(r?.type).replace(/[\s-]+/g,'_');return t.includes('high_speed')?'high_speed':t.includes('normal')?'rail':t.includes('light_rail')?'light_rail':t}
function clean(env){
 if(!ON||!env||typeof env!=='object')return env;const src=env.data&&typeof env.data==='object'?env.data:env;if(!Array.isArray(src.routes)||!Array.isArray(src.stations))return env;
 const out=typeof structuredClone==='function'?structuredClone(env):JSON.parse(JSON.stringify(env)),data=out.data&&typeof out.data==='object'?out.data:out,routes=data.routes,top=data.stations,topById=new Map(top.map(s=>[id(s),s]));
 const occ=new Map();for(const r of routes)for(const s of stations(r)){const k=id(s),p=point(s);if(!k||!p)continue;if(!occ.has(k))occ.set(k,[]);occ.get(k).push(p)}
 const logicalFor=new Map(),name=new Map(),members=new Map();for(const k of occ.keys()){const n=norm(topById.get(k)?.name??k),g=ALIASES.get(n)||`name:${n}`;logicalFor.set(k,g);if(!members.has(g))members.set(g,[]);members.get(g).push(k);name.set(g,g.startsWith('name:')?String(topById.get(k)?.name??k):g==='wity'?'Wity':g==='folityn centralny'?'Folityn Centralny':'Folityn Jamnikowsko')}
 const original=new Map();for(const[g,ids]of members){const ps=ids.flatMap(k=>occ.get(k)||[]);original.set(g,{x:med(ps.map(p=>p.x)),z:med(ps.map(p=>p.z))})}
 const seqs=[];for(const r of routes){const q=[];for(const s of stations(r)){const g=logicalFor.get(id(s));if(g&&q.at(-1)!==g)q.push(g)}if(q.length>1)seqs.push({r,k:kind(r),q})}
 const adj=new Map([...original.keys()].map(k=>[k,new Set()])),lens=[];for(const s of seqs)for(let i=1;i<s.q.length;i++){const a=s.q[i-1],b=s.q[i];if(a===b)continue;adj.get(a)?.add(b);adj.get(b)?.add(a);if(original.get(a)&&original.get(b))lens.push(dist(original.get(a),original.get(b)))}
 const typical=Math.max(120,med(lens.filter(x=>x>20))||420),step=typical*.92,byName=new Map();for(const[k,v]of name)byName.set(norm(v),k);
 const find=arr=>{for(const x of arr){const k=byName.get(norm(x));if(k)return k}return null},central=find(N.central),rcm=find(N.rcm),east=find(N.east),drz=find(N.drzewiec),lip=find(N.lipkow),jam=find(N.jam),wia=find(N.wiadukt),lar=find(N.larcho);
 const pos=new Map([...original].map(([k,p])=>[k,{...p}]));if(rcm&&east&&pos.has(rcm)&&pos.has(east)){const o=pos.get(rcm),t=-ang(o,pos.get(east));for(const[k,p]of pos)pos.set(k,rot(p,o,t))}
 const locked=new Set(),lock=(k,p)=>{if(k&&p){pos.set(k,{...p});locked.add(k)}};
 if(central&&pos.has(central)){const c=pos.get(central);lock(central,c);if(rcm)lock(rcm,{x:c.x+step*.72,z:c.z-step*2.05});if(wia)lock(wia,{x:c.x+step*.28,z:c.z-step*1.08});if(lar)lock(lar,{x:c.x-step*.78,z:c.z-step*2.05})}
 const edgeStep=(a,b)=>{const A=original.get(a),B=original.get(b),d=A&&B?dist(A,B):typical;return step*clamp(Math.sqrt(Math.max(.1,d/typical)),.72,1.42)};
 function segment(a,b,kinds){let best=null;for(const s of seqs){if(kinds&&!kinds.has(s.k))continue;const i=s.q.indexOf(a),j=s.q.indexOf(b);if(i<0||j<0||i===j)continue;let q=s.q.slice(Math.min(i,j),Math.max(i,j)+1);if(i>j)q=q.reverse();if(!best||q.length<best.length)best=q}return best}
 function bfs(a,b){if(!a||!b)return null;const q=[a],pre=new Map([[a,null]]);while(q.length){const n=q.shift();if(n===b)break;for(const x of adj.get(n)||[])if(!pre.has(x)){pre.set(x,n);q.push(x)}}if(!pre.has(b))return null;const p=[];for(let n=b;n;n=pre.get(n))p.push(n);return p.reverse()}
 const path=(a,b,k)=>segment(a,b,k)||bfs(a,b);
 function place(q,o,h){if(!q||q.length<2||!o)return;let d=0;lock(q[0],o);for(let i=1;i<q.length;i++){d+=edgeStep(q[i-1],q[i]);lock(q[i],ray(o,h,d))}}
 if(rcm&&east&&pos.has(rcm))place(path(rcm,east),pos.get(rcm),0);
 if(central&&drz&&pos.has(central))place(path(central,drz,new Set(['rail','high_speed','light_rail']))||path(central,drz),pos.get(central),Math.PI/2);
 if(drz&&lip&&pos.has(drz))place(path(drz,lip),pos.get(drz),Math.PI/2);
 if(central&&jam&&pos.has(central))place(path(central,jam,new Set(['rail','high_speed']))||path(central,jam),pos.get(central),Math.PI/4);
 const degree=k=>adj.get(k)?.size??0,cands=[];for(const s of seqs){let i=0;while(i<s.q.length-2){let j=i+1,h=ang(pos.get(s.q[i]),pos.get(s.q[j]));while(j<s.q.length-1){const a=pos.get(s.q[j]),b=pos.get(s.q[j+1]);if(!a||!b)break;const nh=ang(a,b);if(adiff(h,nh)>Math.PI/7.2||(degree(s.q[j])>2&&j>i+1))break;h=nh;j++}if(j-i>=2)cands.push(s.q.slice(i,j+1));i=Math.max(i+1,j)}}
 cands.sort((a,b)=>b.length-a.length);const used=new Set();for(const q of cands){const mid=q.slice(1,-1);if(!mid.length||mid.some(k=>locked.has(k)||used.has(k)||degree(k)>2))continue;const A=q[0],B=q.at(-1),a=pos.get(A),b=pos.get(B);if(!a||!b)continue;const af=locked.has(A)||degree(A)>2,bf=locked.has(B)||degree(B)>2;if(af&&bf){for(const k of mid)pos.set(k,proj(pos.get(k),a,b))}else{const O=af?A:bf?B:A,ordered=O===A?q:[...q].reverse(),o=pos.get(O),far=pos.get(ordered.at(-1)),h=snap(ang(o,far));let d=0;for(let x=1;x<ordered.length;x++){d+=edgeStep(ordered[x-1],ordered[x]);const k=ordered[x];if(locked.has(k)||degree(k)>2)break;pos.set(k,ray(o,h,d))}}mid.forEach(k=>used.add(k))}
 if(rcm&&east&&pos.has(rcm))place(path(rcm,east),pos.get(rcm),0);if(central&&drz&&pos.has(central))place(path(central,drz),pos.get(central),Math.PI/2);if(drz&&lip&&pos.has(drz))place(path(drz,lip),pos.get(drz),Math.PI/2);if(central&&jam&&pos.has(central))place(path(central,jam,new Set(['rail','high_speed']))||path(central,jam),pos.get(central),Math.PI/4);
 for(const r of routes)for(const s of stations(r)){const p=pos.get(logicalFor.get(id(s)));if(p)put(s,p)}
 return out;
}
function tx(text){try{return JSON.stringify(clean(JSON.parse(text)))}catch(e){console.warn('[Folityn v9] transform failed',e);return text}}
const nativeFetch=window.fetch.bind(window);window.fetch=async function(input,init){const u=typeof input==='string'?input:input?.url||'',r=await nativeFetch(input,init);if(!TARGET.test(u))return r;try{return new Response(tx(await r.clone().text()),{status:r.status,statusText:r.statusText,headers:r.headers})}catch{return r}};
try{const p=XMLHttpRequest.prototype,open=p.open,tg=Object.getOwnPropertyDescriptor(p,'responseText')?.get,rg=Object.getOwnPropertyDescriptor(p,'response')?.get,cache=new WeakMap();p.open=function(m,u,...x){this.__f9=TARGET.test(String(u));cache.delete(this);return open.call(this,m,u,...x)};if(tg)Object.defineProperty(p,'responseText',{configurable:true,get(){const r=tg.call(this);if(!this.__f9||this.readyState!==4||typeof r!=='string')return r;let c=cache.get(this);if(!c){c={t:tx(r)};cache.set(this,c)}return c.t}});if(rg)Object.defineProperty(p,'response',{configurable:true,get(){const r=rg.call(this);if(!this.__f9||this.readyState!==4)return r;let c=cache.get(this)||{};if(this.responseType==='json'&&r&&typeof r==='object'){if(!c.j){c.j=clean(r);cache.set(this,c)}return c.j}if((this.responseType===''||this.responseType==='text')&&typeof r==='string'){if(!c.t){c.t=tx(r);cache.set(this,c)}return c.t}return r}})}catch(e){console.warn('[Folityn v9] XHR hook failed',e)}
function icon(size){return`<svg viewBox="0 0 64 64" width="${size}" height="${size}"><circle cx="32" cy="32" r="29" fill="#101827" stroke="#e8eef8" stroke-width="4"/><rect x="12" y="20" width="26" height="24" rx="5" fill="none" stroke="#e8eef8" stroke-width="4"/><path d="M17 28h16M18 40l-3 5M31 40l3 5" stroke="#e8eef8" stroke-width="3"/><rect x="42" y="24" width="11" height="20" rx="3" fill="none" stroke="#e8eef8" stroke-width="4"/></svg>`}
function dom(){if(!document.head)return setTimeout(dom,50);const st=document.createElement('style');st.textContent=`.f9hub{position:absolute;left:50%;top:0;transform:translate(-50%,-28%);z-index:30;pointer-events:none;filter:drop-shadow(0 2px 4px #0009)}.f9dup{display:none!important}#f9panel{position:fixed;left:14px;bottom:14px;z-index:100000;background:#0c121ef2;color:#fff;padding:9px 11px;border-radius:10px;font:12px Arial;box-shadow:0 6px 24px #0008}#f9panel button{margin-top:6px;background:#172235;color:#fff;border:1px solid #ffffff33;border-radius:7px;padding:5px 8px}`;document.head.appendChild(st);const panel=document.createElement('div');panel.id='f9panel';panel.innerHTML=`<b>Folityn schematic v9</b><br><span style="opacity:.65">native MTR · hard corridors</span><br><button>${ON?'Original geography':'Schematic layout'}</button>`;document.body.appendChild(panel);panel.querySelector('button').onclick=()=>{localStorage.setItem(KEY+'on',ON?'0':'1');location.reload()};const decorate=()=>{const ls=[...document.querySelectorAll('app-map .label[aria-label]')],doHub=(names,size,label)=>{const a=ls.filter(e=>names.includes(norm(e.getAttribute('aria-label'))));a.forEach((e,i)=>{if(i)e.classList.add('f9dup');else{const t=e.querySelector('.station-name.text');if(t&&label)t.textContent=label;if(!e.querySelector('.f9hub')){const b=document.createElement('div');b.className='f9hub';b.innerHTML=icon(size);e.appendChild(b)}}})};doHub(['folityn centralny'],62,'Folityn Centralny');doHub(['folityn wity','wity pkm'],44,'Wity');const j=ls.filter(e=>['folityn jamnikowsko','jamnikowsko pkm'].includes(norm(e.getAttribute('aria-label'))));j.forEach((e,i)=>{if(i)e.classList.add('f9dup')})};new MutationObserver(decorate).observe(document.body,{childList:true,subtree:true});setInterval(decorate,1000);decorate()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',dom,{once:true});else dom();
})();
