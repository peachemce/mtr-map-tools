// ==UserScript==
// @name         Folityn Manual Schematic v14
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      14.0.0
// @description  Hand-authored Folityn transit schematic. Fixed core geometry, shared corridors, compact labels, pan/zoom and live MTR data.
// @match        http://localhost:8888/*
// @match        http://127.0.0.1:8888/*
// @run-at       document-end
// @grant        none
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/folityn-manual-v14.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/folityn-manual-v14.user.js
// ==/UserScript==

(() => {
'use strict';

const NS='http://www.w3.org/2000/svg';
const API='/mtr/api/map/stations-and-routes?dimension=0';
const STORE='folityn-v14-';
let network=null, M=null, overlay=null, svg=null, world=null, view={x:0,y:0,s:1};

const norm=s=>String(s??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const median=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
const svgEl=(t,a={})=>{const e=document.createElementNS(NS,t);for(const[k,v]of Object.entries(a))if(v!==undefined&&v!==null)e.setAttribute(k,String(v));return e};
const root=j=>j?.data&&typeof j.data==='object'?j.data:j;
const stops=r=>Array.isArray(r?.stations)?r.stations:Array.isArray(r?.routeStations)?r.routeStations:Array.isArray(r?.platforms)?r.platforms:[];
const sid=s=>String(s?.id??s?.hexId??s?.stationId??'');
const point=s=>{const x=Number(s?.x??s?.position?.x),z=Number(s?.z??s?.position?.z);return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null};
const rname=r=>String(r?.name??r?.routeName??r?.route_name??'').trim();
const rnum=r=>{const m=rname(r).match(/\d+/);return m?Number(m[0]):null};
const rtype=r=>norm(r?.type);
function rcolor(r){const raw=r?.color??r?.routeColor;if(typeof raw==='number'&&Number.isFinite(raw))return'#'+(raw&0xffffff).toString(16).padStart(6,'0');const s=String(raw??'').trim();if(/^#?[0-9a-f]{6}$/i.test(s))return s[0]==='#'?s:'#'+s;if(/^\d+$/.test(s))return'#'+(Number(s)&0xffffff).toString(16).padStart(6,'0');const p=['#20bce8','#ffb82e','#de334e','#35c86f','#8d36d5','#e47c1f','#81bd34','#347bbf','#ef5ca6','#2f947d'];let h=0;for(const c of rname(r))h=(h*33+c.charCodeAt(0))>>>0;return p[h%p.length]}
function cls(r){const t=rtype(r),n=rnum(r),nm=norm(rname(r)),light=t.includes('light_rail')||t==='light_rail';if(light&&Number.isFinite(n)&&n>=1&&n<=20)return'tram';if(light&&Number.isFinite(n)&&n>=100)return'bus';if(t.includes('high_speed')||nm.startsWith('ic_')||nm==='ic')return'high';if(!light&&(t.includes('train_normal')||t==='rail'))return'rail';return light?'light':'other'}
function serviceKey(r){const c=cls(r),n=rnum(r);return(c==='tram'||c==='bus')&&Number.isFinite(n)?`${c}:${n}`:`${c}:${norm(rname(r))}`}

/* ------------------------------------------------------------------
   FIXED SCHEMATIC SKELETON
   These coordinates are NOT derived from Minecraft. They are the map.
   Screen Y grows downward.
------------------------------------------------------------------- */
const FIXED={
  // Core / hubs
  'hub:centralny':[900,430],
  's:wiadukt_torowy':[900,535],
  's:rogowska_centrum_miejskie':[1030,650],
  's:rondo_larcho':[820,730],
  'hub:rynek':[650,650],
  's:teatr_miejski':[720,500],
  's:dworzec_wschodni':[720,350],
  's:wos_boisko':[430,500],
  's:rondo_rameksi':[280,500],

  // Main east corridor / Kotlandzka
  's:maniaka':[1160,650],
  's:grochowa':[1420,650],
  's:szwedzka_stadion':[1660,650],
  's:rondo_nettspenda':[1780,650],
  's:budziszewska':[1900,650],
  's:cmentarzowa':[2020,650],

  // Jamnikowsko: short 45 up from RCM, then horizontal
  's:rondo_moryta_niejawskiego':[1170,510],
  's:jamnikowsko':[1510,510],
  's:folityn_jamnikowsko':[1650,510],
  's:jamnikowsko_pkm':[1710,510],

  // Rogowska: own 45-down corridor, never through Grochowa
  's:witkowskiego':[1140,760],
  's:rogowska_dabka':[1250,870],
  's:rogowska':[1360,980],
  's:charlinska':[1470,1090],
  's:soperka':[1580,1200],
  's:szwedzka_norweska':[1660,1310],

  // Wzgorzyn / Gorczyn-style single diagonal
  's:wzgorzyn_pkm':[1530,390],
  's:rakoniewicka':[1630,290],
  's:astrolitowska':[1730,190],
  's:koncowa':[1830,90],
  's:kraszewska':[1930,-10],
  's:lepianki':[2030,-110],
  's:kobylskiego':[2130,-210],

  // Muzea corridor: one clean diagonal
  's:most_srodmiejski':[930,840],
  's:sucharskiego':[1040,950],
  's:rynek_chomicki':[1150,1060],
  's:polna':[1260,1170],
  's:rodowa':[1370,1280],
  's:muzea':[1480,1390],

  // Drzewiec / Debiec-style spine
  's:folityn_drzewiec':[900,285],
  's:drzewiec_pkm':[900,140],
  's:slonecznikowa':[990,50],
  's:wypycha':[1080,-40],
  's:brzozowo':[1170,-130],
  's:folityn_lipkow':[1260,-220],

  // Wity / southwest
  'hub:wity':[500,1060],
  's:folityn_zachod':[330,1060],
  's:brama_poludniowa':[640,920],
  's:cukrowa':[700,820],
  's:staniechowska':[650,1210],
  's:folityn_airport_west':[820,1210],
  's:rondo_niepodleglosci':[430,1330],
  's:os_wirenka':[520,1330],

  // Some Lipkow anchors to keep north compact
  's:lipkow_obornicka':[1320,-310],
  's:lipkow_a1':[1400,-390],
  's:lipkow_os_lipowe':[1480,-470],
  's:lipkow_ujscie_ch':[1480,-560],
  's:lipkow_zajaczewo':[1480,-650],
  's:lipkow_wschod':[1700,-390],
  's:ostrowka':[1840,-250],

  // Rail-ish outer anchors
  's:szczecinki':[1960,430],
  's:folityn_polany':[1770,430],
  's:folityn_wzgorzyn':[1450,430]
};

const IMPORTANT=new Set([
 'hub:centralny','hub:rynek','hub:wity','s:rogowska_centrum_miejskie','s:rondo_larcho','s:wzgorzyn_pkm','s:drzewiec_pkm','s:folityn_jamnikowsko','s:jamnikowsko_pkm','s:folityn_lipkow','s:staniechowska','s:szwedzka_stadion','s:muzea'
]);

function aliasName(name){const n=norm(name);if(['aleje_osamasona','stare_miasto','muzeum_narodowa','krolewska'].includes(n))return'hub:rynek';if(['folityn_wity','wity_pkm'].includes(n))return'hub:wity';if(n==='folityn_centralny')return'hub:centralny';return's:'+n}
function displayName(key,names){if(key==='hub:rynek')return'RYNEK';if(key==='hub:wity')return'Wity';if(key==='hub:centralny')return'Folityn Centralny';return names[0]||key.slice(2).replaceAll('_',' ')}

function buildModel(data){
  const stationNames=new Map();for(const s of data.stations||[])stationNames.set(String(s.id??s.hexId??s.stationId??''),String(s.name??''));
  const nodes=new Map();
  function ensure(key,name,p){if(!nodes.has(key))nodes.set(key,{key,names:new Set(),raw:[],pos:null,services:new Set(),terminal:false});const n=nodes.get(key);if(name)n.names.add(name);if(p)n.raw.push(p);return n}
  for(const r of data.routes||[])for(const st of stops(r)){const id=sid(st),p=point(st);if(!id||!p)continue;const name=stationNames.get(id)||String(st?.name??id),key=aliasName(name);ensure(key,name,p)}
  for(const n of nodes.values()){if(FIXED[n.key])n.pos={x:FIXED[n.key][0],y:FIXED[n.key][1]};n.rawCenter=n.raw.length?{x:median(n.raw.map(p=>p.x)),z:median(n.raw.map(p=>p.z))}:{x:0,z:0}}

  const variants=[];const serviceInfo=new Map();
  for(const r of data.routes||[]){const c=cls(r);if(c==='other')continue;const path=[];for(const st of stops(r)){const id=sid(st),name=stationNames.get(id)||String(st?.name??id),key=aliasName(name);if(nodes.has(key)&&path.at(-1)!==key)path.push(key)}if(path.length<2)continue;const sk=serviceKey(r);variants.push({service:sk,name:rname(r)||sk,color:rcolor(r),class:c,number:rnum(r),path});if(!serviceInfo.has(sk))serviceInfo.set(sk,{key:sk,name:rname(r)||sk,color:rcolor(r),class:c,number:rnum(r)});for(const k of path)nodes.get(k)?.services.add(sk);nodes.get(path[0]).terminal=true;nodes.get(path.at(-1)).terminal=true}

  // Place unknown stops BETWEEN immutable anchors. This never moves FIXED nodes.
  const proposals=new Map();const add=(k,p)=>{if(FIXED[k])return;if(!proposals.has(k))proposals.set(k,[]);proposals.get(k).push(p)};
  for(const v of variants){const p=v.path,anchors=[];for(let i=0;i<p.length;i++)if(nodes.get(p[i])?.pos)anchors.push(i);
    for(let ai=1;ai<anchors.length;ai++){
      const i=anchors[ai-1],j=anchors[ai],A=nodes.get(p[i]).pos,B=nodes.get(p[j]).pos;if(j-i<=1)continue;const poly=orthPath(A,B),lens=segmentLengths(poly),total=lens.reduce((a,b)=>a+b,0);for(let q=i+1;q<j;q++){const t=(q-i)/(j-i);add(p[q],pointAlong(poly,lens,total*t))}
    }
    if(anchors.length){
      const first=anchors[0],last=anchors.at(-1);extrapolateRun(p,first,-1,nodes,add);extrapolateRun(p,last,1,nodes,add);
    }
  }
  for(const[k,ps]of proposals){const n=nodes.get(k);if(!n?.pos)n.pos={x:median(ps.map(p=>p.x)),y:median(ps.map(p=>p.y))}}

  // Fallback only for genuinely unanchored stops: compact raw geography, never global layout driver.
  const unresolved=[...nodes.values()].filter(n=>!n.pos);if(unresolved.length){const xs=unresolved.map(n=>-n.rawCenter.x),ys=unresolved.map(n=>-n.rawCenter.z),mnx=Math.min(...xs),mxx=Math.max(...xs),mny=Math.min(...ys),mxy=Math.max(...ys);for(const n of unresolved){const x=(-n.rawCenter.x-mnx)/Math.max(1,mxx-mnx),y=(-n.rawCenter.z-mny)/Math.max(1,mxy-mny);n.pos={x:250+x*1700,y:80+y*1250}}}

  // Build physical edges. Direction variants share geometry whenever their station positions are collinear.
  const edges=new Map();for(const v of variants){for(let i=1;i<v.path.length;i++){const a=v.path[i-1],b=v.path[i];if(a===b)continue;const key=a<b?a+'|'+b:b+'|'+a;if(!edges.has(key))edges.set(key,{a:a<b?a:b,b:a<b?b:a,services:new Set()});edges.get(key).services.add(v.service)}}
  const services=[...serviceInfo.values()].sort((a,b)=>a.class.localeCompare(b.class)||(a.number??9999)-(b.number??9999)||a.name.localeCompare(b.name));
  return{nodes,variants,edges,services,stationNames};
}

function extrapolateRun(path,anchorIndex,dir,nodes,add){let i=anchorIndex+dir;if(i<0||i>=path.length)return;const A=nodes.get(path[anchorIndex]);if(!A?.pos)return;const aRaw=A.rawCenter,bRaw=nodes.get(path[i])?.rawCenter;if(!bRaw)return;let ang=Math.atan2(-(bRaw.z-aRaw.z),-(bRaw.x-aRaw.x));ang=Math.round(ang/(Math.PI/4))*(Math.PI/4);const ux=Math.cos(ang),uy=Math.sin(ang);let step=72,cur={...A.pos};while(i>=0&&i<path.length&&!nodes.get(path[i])?.pos){cur={x:cur.x+ux*step,y:cur.y+uy*step};add(path[i],cur);i+=dir}}
function orthPath(A,B){const dx=B.x-A.x,dy=B.y-A.y,ax=Math.abs(dx),ay=Math.abs(dy),sx=Math.sign(dx)||1,sy=Math.sign(dy)||1;if(ax<1||ay<1||Math.abs(ax-ay)<8)return[A,B];if(ax>ay){const d=ay;return[A,{x:A.x+sx*d,y:A.y+sy*d},B]}const d=ax;return[A,{x:A.x+sx*d,y:A.y+sy*d},B]}
function segmentLengths(p){const out=[];for(let i=1;i<p.length;i++)out.push(Math.hypot(p[i].x-p[i-1].x,p[i].y-p[i-1].y));return out}
function pointAlong(poly,lens,d){for(let i=0;i<lens.length;i++){if(d<=lens[i]){const t=lens[i]?d/lens[i]:0;return{x:poly[i].x+(poly[i+1].x-poly[i].x)*t,y:poly[i].y+(poly[i+1].y-poly[i].y)*t};d-=lens[i]}return{...poly.at(-1)}}
function pathD(p){return p.length?'M '+p.map(q=>q.x.toFixed(1)+' '+q.y.toFixed(1)).join(' L '):''}
function offsetPolyline(p,o){if(Math.abs(o)<.01)return p;return p.map((q,i)=>{let dx,dy;if(i===0){dx=p[1].x-p[0].x;dy=p[1].y-p[0].y}else if(i===p.length-1){dx=p[i].x-p[i-1].x;dy=p[i].y-p[i-1].y}else{dx=p[i+1].x-p[i-1].x;dy=p[i+1].y-p[i-1].y}const L=Math.hypot(dx,dy)||1;return{x:q.x-dy/L*o,y:q.y+dx/L*o}})}

function enabledClass(c){const v=localStorage.getItem(STORE+c);return v!=='0'}
function setClass(c,on){localStorage.setItem(STORE+c,on?'1':'0');render()}

function installCss(){if(document.getElementById('fv14style'))return;const s=document.createElement('style');s.id='fv14style';s.textContent=`
#fv14open{position:fixed;right:18px;bottom:18px;z-index:2147483645;background:#111c2e;color:#eef5ff;border:1px solid #40516c;border-radius:10px;padding:10px 13px;font:700 12px system-ui;cursor:pointer;box-shadow:0 5px 18px #0008}
#fv14{position:fixed;inset:0;z-index:2147483646;background:#0b1322;color:#e9f0fb;display:none;font-family:system-ui}#fv14.open{display:grid;grid-template-columns:1fr 270px}.fvmap{position:relative;overflow:hidden}.fvmap svg{width:100%;height:100%;display:block;cursor:grab;touch-action:none}.fvmap.drag svg{cursor:grabbing}.fvtools{position:absolute;left:12px;top:12px;display:flex;gap:6px;z-index:3}.fvbtn{border:1px solid #3a4a65;background:#101b2d;color:#edf4ff;border-radius:8px;padding:8px 10px;font:700 11px system-ui;cursor:pointer}.fvside{border-left:1px solid #25344a;background:#101827;padding:14px;overflow:auto}.fvside h2{font-size:16px;margin:0 0 10px}.fvcheck{display:flex;gap:8px;align-items:center;margin:7px 0;font-size:12px}.fvinfo{margin-top:15px;padding-top:12px;border-top:1px solid #26354b;font-size:12px;line-height:1.45;color:#c8d4e7}.fvstation{cursor:pointer}.fvlabel{font-family:system-ui;fill:#e8eef8;paint-order:stroke;stroke:#0b1322;stroke-width:4px;stroke-linejoin:round;pointer-events:none}.fvminor{font-size:11px;font-weight:600}.fvmajor{font-size:15px;font-weight:800}.fvhub{font-size:19px;font-weight:900;letter-spacing:.02em}.fvroute{cursor:pointer;fill:none;stroke-linecap:round;stroke-linejoin:round}.fvroute:hover{stroke-width:7!important}.fv-oneway{fill:#0b1322;stroke:#e9f1ff;stroke-width:2}.fv-hidden{display:none}`;document.head.appendChild(s)}

function buildUi(){if(document.getElementById('fv14open'))return;installCss();const open=document.createElement('button');open.id='fv14open';open.textContent='🗺 Folityn Manual Map';document.body.appendChild(open);overlay=document.createElement('div');overlay.id='fv14';overlay.innerHTML=`<div class="fvmap"><div class="fvtools"><button class="fvbtn" data-a="fit">Fit</button><button class="fvbtn" data-a="reload">Reload data</button><button class="fvbtn" data-a="close">Close</button></div><svg></svg></div><aside class="fvside"><h2>Folityn schematic</h2><label class="fvcheck"><input type="checkbox" data-c="tram"> Trams 1–20</label><label class="fvcheck"><input type="checkbox" data-c="bus"> Buses 100+</label><label class="fvcheck"><input type="checkbox" data-c="rail"> Normal rail</label><label class="fvcheck"><input type="checkbox" data-c="high"> High speed / IC</label><div class="fvinfo">Manual core geometry. Adding a line cannot move RYNEK, Rogowska, Wzgórzyn, Muzea or Drzewiec.</div></aside>`;document.body.appendChild(overlay);svg=overlay.querySelector('svg');
  for(const i of overlay.querySelectorAll('[data-c]')){i.checked=enabledClass(i.dataset.c);i.addEventListener('change',()=>setClass(i.dataset.c,i.checked))}
  open.onclick=async()=>{overlay.classList.add('open');await load();fit()};overlay.querySelector('[data-a=close]').onclick=()=>overlay.classList.remove('open');overlay.querySelector('[data-a=fit]').onclick=fit;overlay.querySelector('[data-a=reload]').onclick=async()=>{await load(true);fit()};setupPanZoom()}

async function load(force=false){const info=overlay.querySelector('.fvinfo');if(network&&!force){render();return}try{info.textContent='Loading live MTR network…';const r=await fetch(API,{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);network=root(await r.json());M=buildModel(network);info.textContent=`Loaded ${M.nodes.size} stations / ${M.services.length} services. Core geometry is manual.`;render()}catch(e){info.textContent='Could not load MTR data: '+e.message;console.error('[Folityn v14]',e)}}

function render(){if(!M||!svg)return;svg.innerHTML='';world=svgEl('g');svg.appendChild(world);const svc=new Map(M.services.map(s=>[s.key,s]));
  // Background subtle zone only for the custom hub area.
  const core=svgEl('rect',{x:560,y:390,width:560,height:440,rx:38,fill:'#111d31',opacity:.45});world.appendChild(core);
  // Routes edge-by-edge with stable lane ordering.
  const edgeList=[...M.edges.values()];for(const e of edgeList){const A=M.nodes.get(e.a)?.pos,B=M.nodes.get(e.b)?.pos;if(!A||!B)continue;const active=[...e.services].map(k=>svc.get(k)).filter(s=>s&&enabledClass(s.class)).sort((a,b)=>a.key.localeCompare(b.key));if(!active.length)continue;const base=orthPath(A,B),gap=5.4;active.forEach((s,i)=>{const o=(i-(active.length-1)/2)*gap,p=offsetPolyline(base,o),path=svgEl('path',{d:pathD(p),stroke:s.color,'stroke-width':4.2,class:'fvroute'});path.dataset.service=s.key;path.addEventListener('click',ev=>{ev.stopPropagation();showService(s)});world.appendChild(path)})}
  // Nodes / labels.
  for(const n of M.nodes.values()){const active=[...n.services].map(k=>svc.get(k)).filter(s=>s&&enabledClass(s.class));if(!active.length||!n.pos)continue;const count=active.length,hub=n.key.startsWith('hub:'),major=hub||IMPORTANT.has(n.key)||count>=4;const g=svgEl('g',{class:'fvstation'});g.dataset.key=n.key;g.addEventListener('click',ev=>{ev.stopPropagation();showNode(n,active)});if(n.key==='hub:rynek'){g.appendChild(svgEl('circle',{cx:n.pos.x,cy:n.pos.y,r:31,fill:'#0b1322',stroke:'#f3f6fb','stroke-width':5}));g.appendChild(svgEl('path',{d:`M ${n.pos.x-15} ${n.pos.y+2} A 16 16 0 1 1 ${n.pos.x+10} ${n.pos.y-12}`,fill:'none',stroke:'#f3f6fb','stroke-width':3,'stroke-linecap':'round'}));g.appendChild(svgEl('path',{d:`M ${n.pos.x+8} ${n.pos.y-18} L ${n.pos.x+16} ${n.pos.y-11} L ${n.pos.x+7} ${n.pos.y-7}`,fill:'none',stroke:'#f3f6fb','stroke-width':3,'stroke-linecap':'round'}))}
    else if(n.key==='hub:centralny'){g.appendChild(svgEl('circle',{cx:n.pos.x,cy:n.pos.y,r:25,fill:'#0b1322',stroke:'#f3f6fb','stroke-width':5}));g.appendChild(svgEl('rect',{x:n.pos.x-11,y:n.pos.y-7,width:22,height:14,rx:4,fill:'none',stroke:'#f3f6fb','stroke-width':3}));g.appendChild(svgEl('circle',{cx:n.pos.x-6,cy:n.pos.y+9,r:2.5,fill:'#f3f6fb'}));g.appendChild(svgEl('circle',{cx:n.pos.x+6,cy:n.pos.y+9,r:2.5,fill:'#f3f6fb'}))}
    else if(major){const w=clamp(22+count*7,34,64);g.appendChild(svgEl('rect',{x:n.pos.x-w/2,y:n.pos.y-10,width:w,height:20,rx:10,fill:'#0b1322',stroke:'#eef4ff','stroke-width':3}))}
    else g.appendChild(svgEl('circle',{cx:n.pos.x,cy:n.pos.y,r:n.terminal?6:4.5,fill:'#0b1322',stroke:'#eef4ff','stroke-width':2.5}));world.appendChild(g);
    const pri=hub?3:major?2:n.terminal?1:0,label=svgEl('text',{x:n.pos.x+(hub?0:major?12:8),y:n.pos.y+(hub?-38:-9),class:`fvlabel ${hub?'fvhub':major?'fvmajor':'fvminor'}`});label.textContent=n.key==='hub:rynek'?'RYNEK':n.key==='hub:wity'?'Wity':n.key==='hub:centralny'?'Folityn Centralny':[...n.names][0]||n.key;label.dataset.pri=String(pri);world.appendChild(label)
  }
  applyView();updateLabels()}

function showNode(n,active){overlay.querySelector('.fvinfo').innerHTML=`<b>${escapeHtml(n.key==='hub:rynek'?'RYNEK':n.key==='hub:wity'?'Wity':n.key==='hub:centralny'?'Folityn Centralny':[...n.names][0])}</b><br>${n.names.size>1?'Grouped: '+[...n.names].map(escapeHtml).join(', ')+'<br>':''}<br>${active.map(s=>`<span style="color:${s.color}">●</span> ${escapeHtml(s.name)}`).join('<br>')}`}
function showService(s){overlay.querySelector('.fvinfo').innerHTML=`<b>${escapeHtml(s.name)}</b><br><span style="color:${s.color}">●</span> ${s.class}`}
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function setupPanZoom(){const map=overlay.querySelector('.fvmap');let drag=null;svg.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};map.classList.add('drag');svg.setPointerCapture(e.pointerId)});svg.addEventListener('pointermove',e=>{if(!drag)return;view.x=drag.vx+(e.clientX-drag.x);view.y=drag.vy+(e.clientY-drag.y);applyView()});const end=e=>{drag=null;map.classList.remove('drag')};svg.addEventListener('pointerup',end);svg.addEventListener('pointercancel',end);svg.addEventListener('wheel',e=>{e.preventDefault();const r=svg.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,old=view.s,ns=clamp(old*Math.exp(-e.deltaY*.0012),.18,5);view.x=mx-(mx-view.x)*(ns/old);view.y=my-(my-view.y)*(ns/old);view.s=ns;applyView();updateLabels()},{passive:false})}
function applyView(){if(world)world.setAttribute('transform',`translate(${view.x} ${view.y}) scale(${view.s})`)}
function updateLabels(){if(!svg)return;for(const t of svg.querySelectorAll('.fvlabel')){const p=Number(t.dataset.pri||0);t.style.display=(p>=2||view.s>=1.35&&p>=1||view.s>=2.1)?'':'none'}}
function fit(){if(!M||!svg)return;const pts=[...M.nodes.values()].filter(n=>n.pos).map(n=>n.pos);if(!pts.length)return;const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y),minX=Math.min(...xs)-80,maxX=Math.max(...xs)+80,minY=Math.min(...ys)-80,maxY=Math.max(...ys)+80,r=svg.getBoundingClientRect(),s=Math.min(r.width/(maxX-minX),r.height/(maxY-minY))*.94;view.s=clamp(s,.18,2);view.x=(r.width-(minX+maxX)*view.s)/2;view.y=(r.height-(minY+maxY)*view.s)/2;applyView();updateLabels()}

function boot(){buildUi()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
