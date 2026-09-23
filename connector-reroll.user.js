// ==UserScript==
// @name         MTR Map Tools - Folityn Schematic v3.5
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      3.5.0
// @description  Poznan-style schematic: exactly one stroke per public line, opposite directions merged, one-way stop symbols.
// @match        http://localhost:8888/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==

(() => {
'use strict';

const NS='http://www.w3.org/2000/svg';
const KEY='folityn-v35-';
const C={spacing:82,width:5.2,gap:7,radius:18,pad:165,stopL:12,stopW:4.8};
const S={
  enabled:localStorage.getItem(KEY+'enabled')!=='0',
  dark:localStorage.getItem(KEY+'dark')!=='0',
  labels:localStorage.getItem(KEY+'labels')||'key',
  transfers:localStorage.getItem(KEY+'transfers')!=='0',
  visible:new Set(JSON.parse(localStorage.getItem(KEY+'modes')||'["light_rail","rail","high_speed"]')),
  wrapper:null,overlay:null,svg:null,layers:null,model:null,pos:null,view:null,fit:null,drag:null
};

const norm=s=>String(s??'').trim().replace(/\s+/g,' ').toLocaleLowerCase();
const pair=(a,b)=>a<b?`${a}|${b}`:`${b}|${a}`;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dist=(a,b)=>Math.hypot(b.x-a.x,b.y-a.y);
const hex=v=>`#${((Number(v)>>>0)&0xffffff).toString(16).padStart(6,'0')}`;
const modeOf=t=>{t=String(t||'').toLowerCase().replace(/[\s-]+/g,'_');if(t==='train_light_rail')return'light_rail';if(t==='train_normal')return'rail';if(t==='train_high_speed')return'high_speed';return null};
const modeOrder=m=>({high_speed:0,rail:1,light_rail:2})[m]??9;
const labelOf=r=>String(r.name??r.routeNumber??r.route_number??r.number??r.id).trim();
const svgEl=(tag,a={})=>{const e=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(a))e.setAttribute(k,String(v));return e};
function median(a){if(!a.length)return 1;a=[...a].sort((x,y)=>x-y);let m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
async function waitMap(){for(;;){const w=document.querySelector('app-map .wrapper, .wrapper');if(w?.querySelector('canvas'))return w;await new Promise(r=>setTimeout(r,250))}}
async function loadNetwork(){const r=await fetch('/mtr/api/map/stations-and-routes?dimension=0',{cache:'no-store'});if(!r.ok)throw new Error(`MTR network request failed ${r.status}`);const j=await r.json();return j?.data??j}
function overlap(a,b){const A=new Set(a),B=new Set(b);let n=0;for(const x of A)if(B.has(x))n++;return n/Math.max(1,Math.min(A.size,B.size))}

function buildModel(data){
  const rawStation=new Map(),rawToLogical=new Map(),logicalByName=new Map();
  for(const s of data.stations||[]){rawStation.set(s.id,s);const k=norm(s.name)||`id:${s.id}`;let L=logicalByName.get(k);if(!L){L={id:`name:${k}`,name:String(s.name||s.id),rawIds:new Set(),connections:new Set()};logicalByName.set(k,L)}L.rawIds.add(s.id);rawToLogical.set(s.id,L.id)}
  const stationMeta=new Map([...logicalByName.values()].map(x=>[x.id,x]));
  for(const s of data.stations||[]){const from=rawToLogical.get(s.id),m=stationMeta.get(from);if(!m)continue;for(const rr of s.connections||[]){const to=rawToLogical.get(rr);if(to&&to!==from)m.connections.add(to)}}
  const ensure=id=>{if(rawToLogical.has(id))return rawToLogical.get(id);const s=rawStation.get(id),k=norm(s?.name)||`id:${id}`,lid=`name:${k}`;rawToLogical.set(id,lid);if(!stationMeta.has(lid))stationMeta.set(lid,{id:lid,name:String(s?.name||id),rawIds:new Set([id]),connections:new Set()});return lid};

  const occurrences=new Map(),services=[];
  for(const r of data.routes||[]){
    if(r.hidden||!Array.isArray(r.stations)||r.stations.length<2)continue;
    const mode=modeOf(r.type);if(!mode)continue;
    const ids=[];
    for(const st of r.stations){if(!st?.id||!Number.isFinite(+st.x)||!Number.isFinite(+st.z))continue;const id=ensure(st.id);if(ids.at(-1)!==id)ids.push(id);if(!occurrences.has(id))occurrences.set(id,[]);occurrences.get(id).push({x:+st.x,y:+st.z})}
    if(ids.length<2)continue;
    services.push({mode,color:Number(r.color??0),label:labelOf(r),ids});
  }

  const parent=services.map((_,i)=>i);
  const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a};
  for(let i=0;i<services.length;i++)for(let j=i+1;j<services.length;j++){
    const a=services[i],b=services[j];if(a.mode!==b.mode)continue;
    const sameLabel=norm(a.label)===norm(b.label),sameColor=a.color===b.color;
    if(sameLabel||(sameColor&&overlap(a.ids,b.ids)>=0.58))union(i,j);
  }
  const clusters=new Map();
  services.forEach((s,i)=>{const r=find(i);if(!clusters.has(r))clusters.set(r,[]);clusters.get(r).push(s)});

  const routeGroups=new Map();let gnum=0;
  for(const list of clusters.values()){
    const mode=list[0].mode,colorCounts=new Map(),labelCounts=new Map();
    for(const s of list){colorCounts.set(s.color,(colorCounts.get(s.color)||0)+1);labelCounts.set(s.label,(labelCounts.get(s.label)||0)+1)}
    const color=[...colorCounts].sort((a,b)=>b[1]-a[1])[0][0];
    const label=[...labelCounts].sort((a,b)=>b[1]-a[1]||b[0].length-a[0].length)[0][0];
    const variants=[],seen=new Set();
    for(const s of list){const sig=s.ids.join('>');if(!seen.has(sig)){seen.add(sig);variants.push(s.ids)}}
    variants.sort((a,b)=>b.length-a.length);
    const base=[...(variants[0]||[])],baseSet=new Set(base),baseIdx=new Map(base.map((x,i)=>[x,i]));
    const edges=new Set(),nodes=new Set(base),stopDirs=new Map();
    for(let i=1;i<base.length;i++)edges.add(pair(base[i-1],base[i]));
    for(const v of variants){
      for(const x of v)nodes.add(x);
      for(let i=1;i<v.length;i++){const a=v[i-1],b=v[i];if(baseSet.has(a)&&baseSet.has(b))continue;edges.add(pair(a,b))}
      let dir=1,prev=null;
      for(const x of v){const bi=baseIdx.get(x);if(bi===undefined)continue;if(prev!==null&&bi!==prev){dir=bi>prev?1:-1;break}prev=bi}
      for(const x of v){if(!stopDirs.has(x))stopDirs.set(x,new Set());stopDirs.get(x).add(dir)}
    }
    const id=`${mode}|${color}|${gnum++}`;routeGroups.set(id,{id,label,mode,color,variants,base,edges,nodes,stopDirs});
  }

  const edges=new Map(),nodeGroups=new Map(),endpoints=new Set();
  for(const g of routeGroups.values()){
    for(const n of g.nodes){if(!nodeGroups.has(n))nodeGroups.set(n,new Set());nodeGroups.get(n).add(g.id)}
    if(g.base.length){endpoints.add(g.base[0]);endpoints.add(g.base.at(-1))}
    for(const k of g.edges){let e=edges.get(k);if(!e){const[a,b]=k.split('|');e={key:k,a,b,routes:new Set()};edges.set(k,e)}e.routes.add(g.id)}
  }
  const groups=[...routeGroups.values()].sort((a,b)=>modeOrder(a.mode)-modeOrder(b.mode)||a.label.localeCompare(b.label,undefined,{numeric:true})||a.id.localeCompare(b.id));
  const rank=new Map(groups.map((g,i)=>[g.id,i]));

  const original=new Map();
  for(const[id,p]of occurrences)original.set(id,{x:p.reduce((s,q)=>s+q.x,0)/p.length,y:p.reduce((s,q)=>s+q.y,0)/p.length});
  const lens=[];for(const e of edges.values()){const a=original.get(e.a),b=original.get(e.b);if(a&&b)lens.push(dist(a,b))}
  const scale=C.spacing/Math.max(1,median(lens));
  const vals=[...original.values()],cx=vals.reduce((s,p)=>s+p.x,0)/Math.max(1,vals.length),cy=vals.reduce((s,p)=>s+p.y,0)/Math.max(1,vals.length);
  const geo=new Map();
  for(const[id,p]of original){let dx=(p.x-cx)*scale,dy=(p.y-cy)*scale,r=Math.hypot(dx,dy),rr=r>840?840+Math.sqrt(r-840)*12:r,k=r?rr/r:1;geo.set(id,{x:dx*k,y:dy*k})}
  const adjacency=new Map([...geo.keys()].map(id=>[id,[]]));
  for(const e of edges.values())if(geo.has(e.a)&&geo.has(e.b)){adjacency.get(e.a).push(e);adjacency.get(e.b).push(e)}
  const transfers=new Set();
  for(const m of stationMeta.values())for(const o of m.connections||[])if(geo.has(m.id)&&geo.has(o)&&o!==m.id)transfers.add(pair(m.id,o));
  return{stationMeta,routeGroups,groups,rank,edges,nodeGroups,endpoints,original,geo,adjacency,transfers};
}

function oct(a,b){const dx=b.x-a.x,dy=b.y-a.y,ax=Math.abs(dx),ay=Math.abs(dy),eps=.5;if(ax<eps||ay<eps||Math.abs(ax-ay)<eps)return[{...a},{...b}];const sx=Math.sign(dx)||1,sy=Math.sign(dy)||1,m=ax>ay?{x:a.x+sx*(ax-ay),y:a.y}:{x:a.x,y:a.y+sy*(ay-ax)};if(dist(a,m)<eps||dist(m,b)<eps)return[{...a},{...b}];return[{...a},m,{...b}]}
function along(p,f){let ls=[],t=0;for(let i=1;i<p.length;i++){let l=dist(p[i-1],p[i]);ls.push(l);t+=l}if(!t)return{...p[0]};let x=clamp(f,0,1)*t;for(let i=0;i<ls.length;i++){if(x<=ls[i]||i===ls.length-1){let u=ls[i]?x/ls[i]:0;return{x:p[i].x+(p[i+1].x-p[i].x)*u,y:p[i].y+(p[i+1].y-p[i].y)*u}}x-=ls[i]}return{...p.at(-1)}}
function simplify(M){
  const pos=new Map([...M.geo].map(([i,p])=>[i,{...p}])),tr=new Set();for(const k of M.transfers)for(const x of k.split('|'))tr.add(x);
  const anchors=new Set();for(const id of pos.keys()){const d=M.adjacency.get(id)?.length||0;if(d!==2||M.endpoints.has(id)||tr.has(id))anchors.add(id)}
  const vis=new Set();
  for(const start of anchors)for(const first of M.adjacency.get(start)||[]){if(vis.has(first.key))continue;const chain=[start];let cur=start,e=first;while(e){vis.add(e.key);const n=e.a===cur?e.b:e.a;chain.push(n);if(anchors.has(n)&&n!==start)break;const opts=(M.adjacency.get(n)||[]).filter(q=>!vis.has(q.key));if(opts.length!==1)break;cur=n;e=opts[0]}if(chain.length<3)continue;const a=pos.get(chain[0]),b=pos.get(chain.at(-1));if(!a||!b)continue;const spine=oct(a,b);for(let i=1;i<chain.length-1;i++)pos.set(chain[i],along(spine,i/(chain.length-1)))}
  const byName=new Map([...M.stationMeta.values()].map(s=>[norm(s.name),s.id]));
  const names=['Rogowska Centrum Miejskie','Witkowskiego','Rogowska/Dąbka','Rogowska'];const ids=names.map(n=>byName.get(norm(n))).filter(x=>x&&pos.has(x));
  if(ids.length>=3){const f=ids[0],first={...pos.get(f)},rf=M.geo.get(f),rl=M.geo.get(ids.at(-1));const sx=Math.sign((rl?.x??first.x+1)-(rf?.x??first.x))||1,sy=Math.sign((rl?.y??first.y+1)-(rf?.y??first.y))||1,u=1/Math.sqrt(2);let c=0;pos.set(f,first);for(let i=1;i<ids.length;i++){const a=M.geo.get(ids[i-1]),b=M.geo.get(ids[i]);c+=clamp(a&&b?dist(a,b):C.spacing,C.spacing*.72,C.spacing*1.35);pos.set(ids[i],{x:first.x+sx*u*c,y:first.y+sy*u*c})}}
  return pos;
}
function rounded(p,r=C.radius){if(p.length<2)return'';if(p.length===2)return`M ${p[0].x} ${p[0].y} L ${p[1].x} ${p[1].y}`;let d=`M ${p[0].x} ${p[0].y}`;for(let i=1;i<p.length-1;i++){const a=p[i-1],b=p[i],c=p[i+1],l1=dist(a,b),l2=dist(b,c),rr=Math.min(r,l1*.38,l2*.38);if(rr<.5){d+=` L ${b.x} ${b.y}`;continue}const u1={x:(b.x-a.x)/l1,y:(b.y-a.y)/l1},u2={x:(c.x-b.x)/l2,y:(c.y-b.y)/l2},pi={x:b.x-u1.x*rr,y:b.y-u1.y*rr},po={x:b.x+u2.x*rr,y:b.y+u2.y*rr};d+=` L ${pi.x} ${pi.y} Q ${b.x} ${b.y} ${po.x} ${po.y}`}const z=p.at(-1);return d+` L ${z.x} ${z.y}`}
function offset(p,o){if(Math.abs(o)<.001||p.length<2)return p.map(q=>({...q}));const n=[];for(let i=1;i<p.length;i++){let dx=p[i].x-p[i-1].x,dy=p[i].y-p[i-1].y,l=Math.max(.001,Math.hypot(dx,dy));n.push({x:-dy/l,y:dx/l})}return p.map((q,i)=>{let nn;if(i===0)nn=n[0];else if(i===p.length-1)nn=n.at(-1);else{let x=n[i-1].x+n[i].x,y=n[i-1].y+n[i].y,l=Math.hypot(x,y);nn=l<.001?n[i]:{x:x/l,y:y/l}}return{x:q.x+nn.x*o,y:q.y+nn.y*o}})}
function visibleRoutes(e){return[...e.routes].filter(id=>S.visible.has(S.model.routeGroups.get(id)?.mode)).sort((a,b)=>(S.model.rank.get(a)??0)-(S.model.rank.get(b)??0))}
function routePath(g){const chunks=[];for(const k of g.edges){const e=S.model.edges.get(k);if(!e)continue;const a=S.pos.get(e.a),b=S.pos.get(e.b);if(!a||!b)continue;const rs=visibleRoutes(e),idx=rs.indexOf(g.id);if(idx<0)continue;const off=(idx-(rs.length-1)/2)*C.gap;chunks.push(rounded(offset(oct(a,b),off)))}return chunks.join(' ')}
function lineDirectionAt(g,node){const i=g.base.indexOf(node),p=S.pos.get(node);if(!p)return{x:1,y:0};let a=i>0?S.pos.get(g.base[i-1]):null,b=i>=0&&i<g.base.length-1?S.pos.get(g.base[i+1]):null,dx=0,dy=0;if(a){dx+=p.x-a.x;dy+=p.y-a.y}if(b){dx+=b.x-p.x;dy+=b.y-p.y}let l=Math.hypot(dx,dy)||1;return{x:dx/l,y:dy/l}}
function drawStop(layer,g,node,fg,bg){const p=S.pos.get(node);if(!p)return;const dirs=g.stopDirs.get(node)||new Set(),v=lineDirectionAt(g,node),n={x:-v.y,y:v.x},oneWay=dirs.size===1&&g.variants.length>1,sign=oneWay?([...dirs][0]>=0?1:-1):0,L=C.stopL,W=C.stopW;let cx=p.x,cy=p.y,len=L;if(oneWay){cx+=n.x*L*.28*sign;cy+=n.y*L*.28*sign;len=L*.58}const angle=Math.atan2(v.y,v.x)*180/Math.PI+90;layer.appendChild(svgEl('rect',{x:cx-W/2,y:cy-len/2,width:W,height:len,rx:W/2,ry:W/2,transform:`rotate(${angle} ${cx} ${cy})`,fill:bg,stroke:fg,'stroke-width':1.4,'vector-effect':'non-scaling-stroke'}))}
function fit(){const v=[...S.pos.values()],minX=Math.min(...v.map(p=>p.x)),maxX=Math.max(...v.map(p=>p.x)),minY=Math.min(...v.map(p=>p.y)),maxY=Math.max(...v.map(p=>p.y));return{x:minX-C.pad,y:minY-C.pad,w:Math.max(500,maxX-minX+C.pad*2),h:Math.max(360,maxY-minY+C.pad*2)}}
function applyView(){if(S.svg&&S.view)S.svg.setAttribute('viewBox',`${S.view.x} ${S.view.y} ${S.view.w} ${S.view.h}`)}
function panZoom(svg){const end=()=>{S.drag=null;svg.style.cursor='grab'};svg.style.cursor='grab';svg.addEventListener('mousedown',e=>{if(e.button!==0)return;S.drag={x:e.clientX,y:e.clientY,vx:S.view.x,vy:S.view.y};svg.style.cursor='grabbing';e.preventDefault()},true);window.addEventListener('mousemove',e=>{if(!S.drag||(e.buttons&1)!==1){if(S.drag)end();return}const r=svg.getBoundingClientRect();S.view.x=S.drag.vx-(e.clientX-S.drag.x)/r.width*S.view.w;S.view.y=S.drag.vy-(e.clientY-S.drag.y)/r.height*S.view.h;applyView();e.preventDefault()},true);window.addEventListener('mouseup',end,true);window.addEventListener('blur',end,true);svg.addEventListener('wheel',e=>{e.preventDefault();const r=svg.getBoundingClientRect(),mx=S.view.x+(e.clientX-r.left)/r.width*S.view.w,my=S.view.y+(e.clientY-r.top)/r.height*S.view.h,f=e.deltaY>0?1.12:.89;S.view.x=mx+(S.view.x-mx)*f;S.view.y=my+(S.view.y-my)*f;S.view.w*=f;S.view.h*=f;applyView()},{passive:false,capture:true});svg.addEventListener('dblclick',e=>{e.preventDefault();S.view={...S.fit};applyView()})}
function original(show){const c=S.wrapper?.querySelector('canvas');if(c)c.style.visibility=show?'':'hidden';S.wrapper?.querySelectorAll('.label').forEach(x=>x.style.visibility=show?'':'hidden');if(S.overlay)S.overlay.style.display=show?'none':''}
function draw(){const{routeLayer,transferLayer,stopLayer,stationLayer,labelLayer}=S.layers;for(const l of Object.values(S.layers))l.replaceChildren();const bg=S.dark?'#101827':'#f6f8fb',fg=S.dark?'#e6edf7':'#172033',tr=S.dark?'#aeb9c9':'#455166';S.overlay.style.background=bg;for(const g of S.model.groups){if(!S.visible.has(g.mode))continue;const d=routePath(g);if(!d)continue;routeLayer.appendChild(svgEl('path',{d,fill:'none',stroke:hex(g.color),'stroke-width':C.width,'stroke-linecap':'round','stroke-linejoin':'round','vector-effect':'non-scaling-stroke'}));for(const n of g.nodes)drawStop(stopLayer,g,n,fg,bg)}if(S.transfers)for(const k of S.model.transfers){const[a,b]=k.split('|'),pa=S.pos.get(a),pb=S.pos.get(b);if(!pa||!pb)continue;transferLayer.appendChild(svgEl('path',{d:rounded(oct(pa,pb),10),fill:'none',stroke:tr,'stroke-width':1.8,'stroke-dasharray':'6 5','vector-effect':'non-scaling-stroke'}))}for(const[id,p]of S.pos){const ids=[...(S.model.nodeGroups.get(id)||[])].filter(r=>S.visible.has(S.model.routeGroups.get(r)?.mode));if(!ids.length)continue;const m=S.model.stationMeta.get(id),count=ids.length,deg=S.model.adjacency.get(id)?.length||0,major=count>=4||deg>=3;if(major)stationLayer.appendChild(svgEl('rect',{x:p.x-11,y:p.y-7,width:22,height:14,rx:7,fill:bg,stroke:fg,'stroke-width':1.8,'vector-effect':'non-scaling-stroke'}));const show=S.labels==='all'||(S.labels==='key'&&(major||count>=2));if(show&&m?.name){const t=svgEl('text',{x:p.x+13,y:p.y-9,fill:fg,'font-size':major?11:9.5,'font-family':'system-ui,sans-serif','font-weight':major?700:550,'paint-order':'stroke',stroke:bg,'stroke-width':3.6,'vector-effect':'non-scaling-stroke'});t.textContent=m.name;labelLayer.appendChild(t)}}}
function cb(label,mode){const w=document.createElement('label');w.style.cssText='display:flex;align-items:center;gap:6px;cursor:pointer';const i=document.createElement('input');i.type='checkbox';i.checked=S.visible.has(mode);i.onchange=()=>{i.checked?S.visible.add(mode):S.visible.delete(mode);localStorage.setItem(KEY+'modes',JSON.stringify([...S.visible]));draw()};w.append(i,document.createTextNode(label));return w}
function controls(){document.querySelectorAll('[id^="folityn-v"][id$="-controls"]').forEach(x=>x.remove());const p=document.createElement('div');p.id='folityn-v35-controls';p.style.cssText='position:fixed;left:14px;bottom:14px;z-index:1000000;width:280px;padding:11px;border-radius:11px;background:rgba(17,24,39,.97);color:#fff;box-shadow:0 6px 22px #0006;font:600 12px/1.35 system-ui,sans-serif';p.innerHTML='<strong style="font-size:14px">Folityn schematic v3.5</strong><div style="opacity:.65;margin-top:2px;font-weight:500">ONE colored stroke per public line · half stops for one-way service</div>';const modes=document.createElement('div');modes.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px';modes.append(cb('Light Rail','light_rail'),cb('Rail','rail'),cb('High Speed','high_speed'));const row=document.createElement('div');row.style.cssText='display:flex;gap:8px;margin-top:8px';const dark=document.createElement('label'),di=document.createElement('input');di.type='checkbox';di.checked=S.dark;di.onchange=()=>{S.dark=di.checked;localStorage.setItem(KEY+'dark',S.dark?'1':'0');draw()};dark.append(di,document.createTextNode(' Dark'));const tr=document.createElement('label'),ti=document.createElement('input');ti.type='checkbox';ti.checked=S.transfers;ti.onchange=()=>{S.transfers=ti.checked;localStorage.setItem(KEY+'transfers',S.transfers?'1':'0');draw()};tr.append(ti,document.createTextNode(' Transfers'));row.append(dark,tr);const labels=document.createElement('select');labels.innerHTML='<option value="key">Key labels</option><option value="all">All labels</option><option value="none">No labels</option>';labels.value=S.labels;labels.style.cssText='width:100%;margin-top:8px;padding:5px;background:#1f2937;color:#fff;border:1px solid #4b5563;border-radius:7px';labels.onchange=()=>{S.labels=labels.value;localStorage.setItem(KEY+'labels',S.labels);draw()};const buttons=document.createElement('div');buttons.style.cssText='display:flex;gap:6px;margin-top:8px';const b=t=>{const x=document.createElement('button');x.textContent=t;x.style.cssText='padding:6px 9px;border:1px solid #4b5563;border-radius:7px;background:#1f2937;color:#fff;cursor:pointer';return x};const sch=b('Schematic'),ori=b('Original'),f=b('Fit');sch.onclick=()=>{S.enabled=true;original(false)};ori.onclick=()=>{S.enabled=false;original(true)};f.onclick=()=>{S.view={...S.fit};applyView()};buttons.append(sch,ori,f);const note=document.createElement('div');note.style.cssText='opacity:.6;font-weight:500;font-size:10.5px;margin-top:7px';note.textContent='Opposite directions are merged before geometry is built.';p.append(modes,row,labels,buttons,note);document.body.appendChild(p)}
function overlay(){document.querySelectorAll('[id^="folityn-v"][id$="-overlay"]').forEach(x=>x.remove());S.wrapper.style.position='relative';const o=document.createElement('div');o.id='folityn-v35-overlay';o.style.cssText='position:absolute;inset:0;z-index:30;overflow:hidden;pointer-events:auto';const svg=svgEl('svg',{width:'100%',height:'100%',preserveAspectRatio:'xMidYMid meet'});svg.style.display='block';svg.style.pointerEvents='all';const routeLayer=svgEl('g'),transferLayer=svgEl('g'),stopLayer=svgEl('g'),stationLayer=svgEl('g'),labelLayer=svgEl('g');svg.append(routeLayer,transferLayer,stopLayer,stationLayer,labelLayer);o.append(svg);S.wrapper.append(o);S.overlay=o;S.svg=svg;S.layers={routeLayer,transferLayer,stopLayer,stationLayer,labelLayer};S.fit=fit();S.view={...S.fit};panZoom(svg);controls();draw();original(!S.enabled)}
(async()=>{try{const[w,data]=await Promise.all([waitMap(),loadNetwork()]);S.wrapper=w;S.model=buildModel(data);S.pos=simplify(S.model);overlay();console.log('[MTR Map Tools] Folityn v3.5 loaded',{publicLines:S.model.groups.length,stations:S.pos.size})}catch(e){console.error('[MTR Map Tools] Folityn v3.5 failed',e)}})();
})();