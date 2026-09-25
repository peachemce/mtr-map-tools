const NS = 'http://www.w3.org/2000/svg';
const state = {
  network: null,
  schematic: null,
  model: null,
  hiddenClasses: new Set(),
  hiddenServices: new Set(),
  selected: null,
  scale: 1,
  tx: 0,
  ty: 0,
  drag: null,
  edit: false,
  edits: JSON.parse(localStorage.getItem('folityn-layout-edits') || '{}'),
};

const $ = s => document.querySelector(s);
const svg = $('#map');
const viewport = $('#viewport');
const corridorsLayer = $('#corridorsLayer');
const routesLayer = $('#routesLayer');
const stationsLayer = $('#stationsLayer');
const labelsLayer = $('#labelsLayer');
const popup = $('#stationPopup');

const norm = s => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
const svgEl = (tag, attrs={}) => { const el=document.createElementNS(NS,tag); for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,String(v)); return el; };
const payload = j => j?.data && typeof j.data === 'object' ? j.data : j;
const routeStations = r => Array.isArray(r?.stations) ? r.stations : Array.isArray(r?.routeStations) ? r.routeStations : Array.isArray(r?.platforms) ? r.platforms : [];
const sid = s => String(s?.id ?? s?.hexId ?? s?.stationId ?? '');
const xOf = s => Number(s?.x ?? s?.position?.x);
const zOf = s => Number(s?.z ?? s?.position?.z);
const routeName = r => String(r?.name ?? r?.routeName ?? r?.route_name ?? '').trim();
const routeNumber = r => { const m=routeName(r).match(/\d+/); return m ? Number(m[0]) : null; };
const routeType = r => norm(r?.type);
function routeColor(v){ const raw=v?.color ?? v?.routeColor; if(typeof raw==='number') return '#'+(raw&0xffffff).toString(16).padStart(6,'0'); const s=String(raw??'').trim(); if(/^#?[0-9a-f]{6}$/i.test(s)) return s.startsWith('#')?s:'#'+s; if(/^\d+$/.test(s)) return '#'+(Number(s)&0xffffff).toString(16).padStart(6,'0'); return '#78909c'; }
function routeClass(r){ const t=routeType(r), n=routeNumber(r), name=norm(routeName(r)); const light=t.includes('light_rail') || t==='light_rail'; if(light && n>=1 && n<=20) return 'tram'; if(light && n>=100) return 'bus'; if(t.includes('high_speed') || name==='ic' || name.startsWith('ic_')) return 'high'; if(!light && (t.includes('train_normal') || t==='rail' || t.includes('train'))) return 'rail'; if(Number.isFinite(n) && n>=100) return 'bus'; if(Number.isFinite(n) && n>=1 && n<=20) return 'tram'; return 'rail'; }
function serviceKey(r){ const c=routeClass(r), n=routeNumber(r); return (c==='tram'||c==='bus') && Number.isFinite(n) ? `${c}:${n}` : `${c}:${norm(routeName(r))}`; }
function serviceLabel(r){ const n=routeNumber(r); return Number.isFinite(n) ? String(n) : routeName(r) || serviceKey(r); }

async function loadJSON(url){ const res=await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${url}: HTTP ${res.status}`); return res.json(); }
async function load(){
  const status=$('#snapshotStatus'), time=$('#snapshotTime'), dot=$('#statusDot');
  try {
    const [netRes, schematic] = await Promise.all([fetch('/api/network',{cache:'no-store'}), loadJSON('./data/schematic.json')]);
    let json, source='snapshot';
    if(netRes.ok){ json=await netRes.json(); source=netRes.headers.get('X-Folityn-Source') || 'live'; }
    else json=await loadJSON('./data/network.json');
    state.network=payload(json); state.schematic=schematic;
    state.model=buildModel(state.network, schematic);
    dot.className='status-dot ok'; status.textContent=source==='live'?'Live MTR network':'Saved network snapshot';
    time.textContent=`${state.model.services.length} services · ${state.model.nodes.size} schematic nodes`;
    buildControls(); render(); fit();
  } catch(err){
    console.error(err); dot.className='status-dot bad'; status.textContent='Could not load map'; time.textContent=err.message;
    $('#emptyState').hidden=false;
  }
}

function buildModel(data, config){
  const topNames=new Map(); for(const s of data.stations||[]) topNames.set(sid(s),String(s.name??s.stationName??sid(s)));
  const aliases=new Map(Object.entries(config.aliases||{}).map(([a,b])=>[norm(a),b]));
  const canonical = name => aliases.get(norm(name)) || name;

  const rawPositions=new Map(), rawNames=new Map();
  for(const r of data.routes||[]) for(const st of routeStations(r)){
    const id=sid(st); if(!id) continue; const name=topNames.get(id) || String(st.name??id); const key=canonical(name);
    const x=xOf(st),z=zOf(st); if(Number.isFinite(x)&&Number.isFinite(z)){ if(!rawPositions.has(key)) rawPositions.set(key,[]); rawPositions.get(key).push({x,z}); }
    if(!rawNames.has(key)) rawNames.set(key,new Set()); rawNames.get(key).add(name);
  }

  const nodes=new Map();
  const setNode=(key,x,y,meta={})=>{ const edit=state.edits[key]; nodes.set(key,{key,x:edit?.x??x,y:edit?.y??y,label:meta.label||key,kind:meta.kind||'normal',fixed:true,services:new Set(),servedBy:new Map(),rawNames:rawNames.get(key)||new Set([key])}); };
  for(const [key,h] of Object.entries(config.hubs||{})) setNode(key,h.x,h.y,h);
  for(const [key,p] of Object.entries(config.nodes||{})) setNode(key,p[0],p[1],{});

  const graph=new Map(), corridorEdges=new Map();
  const addGraph=(a,b,cid)=>{ if(!graph.has(a))graph.set(a,[]); if(!graph.has(b))graph.set(b,[]); const A=nodes.get(a),B=nodes.get(b); if(!A||!B)return; const w=Math.hypot(B.x-A.x,B.y-A.y); graph.get(a).push({to:b,w,cid}); graph.get(b).push({to:a,w,cid}); const ek=edgeKey(a,b); if(!corridorEdges.has(ek)) corridorEdges.set(ek,{a,b,corridors:new Set(),services:new Set()}); corridorEdges.get(ek).corridors.add(cid); };
  for(const c of config.corridors||[]){ for(let i=1;i<c.stations.length;i++) addGraph(c.stations[i-1],c.stations[i],c.id); }

  const unknown=new Set();
  for(const r of data.routes||[]) for(const st of routeStations(r)){ const name=canonical(topNames.get(sid(st))||String(st.name??sid(st))); if(!nodes.has(name)) unknown.add(name); }
  placeFallbackNodes(unknown,nodes,rawPositions);

  const variants=[], servicesMap=new Map();
  for(const r of data.routes||[]){
    const cls=routeClass(r), sk=serviceKey(r); if(!servicesMap.has(sk)) servicesMap.set(sk,{key:sk,label:serviceLabel(r),name:routeName(r)||serviceLabel(r),color:routeColor(r),class:cls,number:routeNumber(r),paths:[],edges:new Set(),servedStops:new Set()});
    const seq=[]; for(const st of routeStations(r)){ const name=canonical(topNames.get(sid(st))||String(st.name??sid(st))); if(nodes.has(name)&&seq.at(-1)!==name) seq.push(name); }
    if(seq.length<2) continue;
    const expanded=[]; for(let i=1;i<seq.length;i++){ const a=seq[i-1],b=seq[i]; const path=shortestPath(graph,nodes,a,b); if(!expanded.length) expanded.push(...path); else expanded.push(...path.slice(1)); }
    const dedup=[]; for(const k of expanded) if(dedup.at(-1)!==k) dedup.push(k);
    variants.push({service:sk,seq,dedup}); const svc=servicesMap.get(sk); svc.paths.push(dedup); seq.forEach(k=>svc.servedStops.add(k));
    for(let i=1;i<dedup.length;i++){ const ek=edgeKey(dedup[i-1],dedup[i]); svc.edges.add(ek); if(corridorEdges.has(ek)) corridorEdges.get(ek).services.add(sk); }
    seq.forEach(k=>{ const n=nodes.get(k); if(n){ n.services.add(sk); const count=n.servedBy.get(sk)||0; n.servedBy.set(sk,count+1); } });
  }
  const services=[...servicesMap.values()].sort(serviceSort);
  const serviceOrder=new Map(services.map((s,i)=>[s.key,i]));
  return {nodes,graph,corridorEdges,services,serviceOrder,variants,config};
}

function placeFallbackNodes(unknown,nodes,rawPositions){
  const knownRaw=[]; for(const [k,n] of nodes){ const arr=rawPositions.get(k); if(arr?.length) knownRaw.push({k,n,raw:medianPoint(arr)}); }
  const transform=estimateTransform(knownRaw);
  let spill=0;
  for(const key of unknown){ const raw=rawPositions.get(key); let p;
    if(raw?.length && transform){ const q=medianPoint(raw); p=transform(q); }
    if(!p || !Number.isFinite(p.x)||!Number.isFinite(p.y)){ p={x:2250+(spill%6)*90,y:100+Math.floor(spill/6)*70}; spill++; }
    const edit=state.edits[key]; nodes.set(key,{key,x:edit?.x??p.x,y:edit?.y??p.y,label:key,kind:'fallback',fixed:false,services:new Set(),servedBy:new Map(),rawNames:new Set([key])});
  }
}
function medianPoint(a){ const xs=a.map(p=>p.x).sort((a,b)=>a-b),zs=a.map(p=>p.z).sort((a,b)=>a-b),m=Math.floor(a.length/2); return {x:xs[m],z:zs[m]}; }
function estimateTransform(samples){
  if(samples.length<2) return null;
  const rx=samples.map(s=>-s.raw.x), ry=samples.map(s=>-s.raw.z), sx=samples.map(s=>s.n.x), sy=samples.map(s=>s.n.y);
  const scaleX=(Math.max(...sx)-Math.min(...sx))/Math.max(1,Math.max(...rx)-Math.min(...rx));
  const scaleY=(Math.max(...sy)-Math.min(...sy))/Math.max(1,Math.max(...ry)-Math.min(...ry));
  const sc=Math.max(.01,Math.min(scaleX,scaleY)); const ox=median(sx.map((v,i)=>v-rx[i]*sc)), oy=median(sy.map((v,i)=>v-ry[i]*sc));
  return q=>({x:-q.x*sc+ox,y:-q.z*sc+oy});
}
function median(a){ const b=[...a].sort((x,y)=>x-y),m=b.length>>1; return b.length%2?b[m]:(b[m-1]+b[m])/2; }
function edgeKey(a,b){ return a<b?`${a}|${b}`:`${b}|${a}`; }
function serviceSort(a,b){ const order={tram:0,bus:1,rail:2,high:3}; return (order[a.class]-order[b.class]) || ((a.number??99999)-(b.number??99999)) || a.name.localeCompare(b.name); }

function shortestPath(graph,nodes,start,end){
  if(start===end) return [start];
  if(graph.has(start)&&graph.has(end)){
    const dist=new Map([[start,0]]),prev=new Map(),q=new Set(graph.keys());
    while(q.size){ let u=null,du=Infinity; for(const k of q){ const d=dist.get(k)??Infinity; if(d<du){du=d;u=k;} } if(u===null||du===Infinity)break; q.delete(u); if(u===end)break; for(const e of graph.get(u)||[]){ if(!q.has(e.to))continue; const nd=du+e.w; if(nd<(dist.get(e.to)??Infinity)){dist.set(e.to,nd);prev.set(e.to,u);} } }
    if(prev.has(end)){ const path=[end]; let cur=end; while(cur!==start){cur=prev.get(cur);path.push(cur);} return path.reverse(); }
  }
  return [start,end];
}

function buildControls(){
  const classBox=$('#classFilters'); classBox.innerHTML='';
  const labels={tram:'Trams 1–20',bus:'Buses 100+',rail:'Normal rail',high:'High speed / IC'};
  for(const cls of ['tram','bus','rail','high']){ const row=document.createElement('label'); row.className='toggle-row'; const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=true; cb.onchange=()=>{ cb.checked?state.hiddenClasses.delete(cls):state.hiddenClasses.add(cls); render(); }; const span=document.createElement('span'); span.textContent=labels[cls]; row.append(cb,span); classBox.append(row); }
  const list=$('#routeList'); list.innerHTML='';
  for(const s of state.model.services){ const row=document.createElement('label'); row.className='route-item'; const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=true; cb.onchange=()=>{cb.checked?state.hiddenServices.delete(s.key):state.hiddenServices.add(s.key);render();}; const sw=document.createElement('span'); sw.className='swatch'; sw.style.background=s.color; const name=document.createElement('span'); name.textContent=s.label; name.title=s.name; row.append(cb,sw,name); list.append(row); }
}

function visibleService(s){ return !state.hiddenClasses.has(s.class)&&!state.hiddenServices.has(s.key); }
function render(){
  corridorsLayer.innerHTML=routesLayer.innerHTML=stationsLayer.innerHTML=labelsLayer.innerHTML='';
  const {nodes,corridorEdges,services,serviceOrder}=state.model;
  for(const e of corridorEdges.values()){ const A=nodes.get(e.a),B=nodes.get(e.b); const line=svgEl('line',{x1:A.x,y1:A.y,x2:B.x,y2:B.y,class:'corridor-base'}); corridorsLayer.append(line); }
  for(const e of corridorEdges.values()){
    const active=[...e.services].map(k=>services.find(s=>s.key===k)).filter(s=>s&&visibleService(s)).sort((a,b)=>serviceOrder.get(a.key)-serviceOrder.get(b.key));
    if(!active.length) continue; const A=nodes.get(e.a),B=nodes.get(e.b); const dx=B.x-A.x,dy=B.y-A.y,L=Math.hypot(dx,dy)||1,nx=-dy/L,ny=dx/L; const gap=5.2;
    active.forEach((s,i)=>{ const off=(i-(active.length-1)/2)*gap; const line=svgEl('line',{x1:A.x+nx*off,y1:A.y+ny*off,x2:B.x+nx*off,y2:B.y+ny*off,stroke:s.color,class:'route-line','data-service':s.key}); line.addEventListener('click',ev=>{ev.stopPropagation();showService(s,ev);}); routesLayer.append(line); });
  }
  for(const s of services){ if(!visibleService(s))continue; for(const path of s.paths){ for(let i=1;i<path.length;i++){ const ek=edgeKey(path[i-1],path[i]); if(corridorEdges.has(ek))continue; const A=nodes.get(path[i-1]),B=nodes.get(path[i]); if(!A||!B)continue; const line=svgEl('line',{x1:A.x,y1:A.y,x2:B.x,y2:B.y,stroke:s.color,class:'route-line fallback-route'}); routesLayer.append(line); } } }
  for(const n of nodes.values()) drawNode(n);
  updateLabelVisibility(); applyTransform();
}

function drawNode(n){
  const active=[...n.services].map(k=>state.model.services.find(s=>s.key===k)).filter(s=>s&&visibleService(s)); if(!active.length && n.kind==='fallback') return;
  const group=svgEl('g',{class:`station-group ${n.kind}`,'data-key':n.key,transform:`translate(${n.x} ${n.y})`});
  let marker;
  if(n.kind==='central'){ marker=svgEl('circle',{r:18,class:'hub central-hub'}); const ic=svgEl('text',{x:0,y:5,'text-anchor':'middle',class:'hub-icon'}); ic.textContent='⇄'; group.append(marker,ic); }
  else if(n.kind==='major'){ marker=svgEl('circle',{r:15,class:'hub major-hub'}); group.append(marker); }
  else if(n.kind==='interchange'||active.length>=3){ marker=svgEl('rect',{x:-10,y:-7,width:20,height:14,rx:7,class:'hub'}); group.append(marker); }
  else { marker=svgEl('circle',{r:4.5,class:'station-dot'}); group.append(marker); }
  group.addEventListener('click',ev=>{ev.stopPropagation();showStation(n,ev);});
  if(state.edit){ group.classList.add('editable'); group.addEventListener('pointerdown',ev=>startNodeDrag(n,ev)); }
  stationsLayer.append(group);

  const important=n.kind!=='normal'||active.length>=3||n.key==='Wzgórzyn PKM'||n.key==='Muzea'||n.key==='Drzewiec PKM'||n.key==='Folityn Jamnikowsko';
  const label=svgEl('text',{x:n.x+8,y:n.y-9,class:`station-label ${important?'important':''}`,'data-important':important?'1':'0'}); label.textContent=n.label||n.key; labelsLayer.append(label);
}

function updateLabelVisibility(){ const zoom=state.scale; labelsLayer.querySelectorAll('.station-label').forEach(l=>{ const important=l.dataset.important==='1'; l.style.display=important||zoom>.9?'block':'none'; }); }
function applyTransform(){ viewport.setAttribute('transform',`translate(${state.tx} ${state.ty}) scale(${state.scale})`); updateLabelVisibility(); }
function fit(){ const pts=[...state.model.nodes.values()]; if(!pts.length)return; const minX=Math.min(...pts.map(n=>n.x)),maxX=Math.max(...pts.map(n=>n.x)),minY=Math.min(...pts.map(n=>n.y)),maxY=Math.max(...pts.map(n=>n.y)); const w=svg.clientWidth,h=svg.clientHeight,pad=80; state.scale=Math.min((w-pad*2)/Math.max(1,maxX-minX),(h-pad*2)/Math.max(1,maxY-minY)); state.tx=w/2-state.scale*(minX+maxX)/2; state.ty=h/2-state.scale*(minY+maxY)/2; applyTransform(); }
function zoom(f,cx=svg.clientWidth/2,cy=svg.clientHeight/2){ state.tx=cx-(cx-state.tx)*f; state.ty=cy-(cy-state.ty)*f; state.scale*=f; applyTransform(); }

svg.addEventListener('wheel',e=>{e.preventDefault();const r=svg.getBoundingClientRect();zoom(e.deltaY<0?1.13:.885,e.clientX-r.left,e.clientY-r.top);},{passive:false});
svg.addEventListener('pointerdown',e=>{ if(state.edit&&e.target.closest('.station-group'))return; state.drag={x:e.clientX,y:e.clientY,tx:state.tx,ty:state.ty}; svg.setPointerCapture?.(e.pointerId); svg.classList.add('dragging'); });
svg.addEventListener('pointermove',e=>{ if(!state.drag)return;state.tx=state.drag.tx+e.clientX-state.drag.x;state.ty=state.drag.ty+e.clientY-state.drag.y;applyTransform(); });
svg.addEventListener('pointerup',()=>{state.drag=null;svg.classList.remove('dragging');});

function startNodeDrag(n,e){ e.stopPropagation(); const start={x:e.clientX,y:e.clientY,nx:n.x,ny:n.y}; const move=ev=>{ n.x=start.nx+(ev.clientX-start.x)/state.scale; n.y=start.ny+(ev.clientY-start.y)/state.scale; state.edits[n.key]={x:n.x,y:n.y}; render(); }; const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);localStorage.setItem('folityn-layout-edits',JSON.stringify(state.edits));}; window.addEventListener('pointermove',move);window.addEventListener('pointerup',up); }

function showStation(n,e){ state.selected=n.key; popup.hidden=false; const rect=svg.getBoundingClientRect(); popup.style.left=`${Math.min(svg.clientWidth-300,e.clientX-rect.left+12)}px`; popup.style.top=`${Math.min(svg.clientHeight-180,e.clientY-rect.top+12)}px`; const names=[...n.rawNames].join(' / '); const services=[...n.services].map(k=>state.model.services.find(s=>s.key===k)).filter(Boolean).map(s=>`<span class="pill" style="--c:${s.color}">${s.label}</span>`).join(''); popup.innerHTML=`<h3>${n.label||n.key}</h3><p>${names}</p><div class="pills">${services}</div>`; }
function showService(s,e){ popup.hidden=false; const rect=svg.getBoundingClientRect(); popup.style.left=`${Math.min(svg.clientWidth-300,e.clientX-rect.left+12)}px`; popup.style.top=`${Math.min(svg.clientHeight-180,e.clientY-rect.top+12)}px`; popup.innerHTML=`<h3><span class="inline-swatch" style="background:${s.color}"></span>${s.name}</h3><p>${s.class} · ${s.edges.size} corridor edges</p>`; }

document.addEventListener('click',e=>{if(!e.target.closest('.station-popup'))popup.hidden=true;});
$('#zoomIn').onclick=()=>zoom(1.2); $('#zoomOut').onclick=()=>zoom(.83); $('#fitMap').onclick=fit;
$('#editLayout').onclick=()=>{state.edit=!state.edit; $('#editLayout').classList.toggle('active',state.edit); $('#editLayout').textContent=state.edit?'Finish layout':'Edit layout'; render();};
$('#resetLayout').onclick=()=>{localStorage.removeItem('folityn-layout-edits');state.edits={};location.reload();};
$('#exportLayout').onclick=()=>{const blob=new Blob([JSON.stringify(state.edits,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='folityn-layout-edits.json';a.click();URL.revokeObjectURL(a.href);};

const search=$('#stationSearch'),results=$('#searchResults');
search.oninput=()=>{const q=norm(search.value);results.innerHTML='';if(!q){results.classList.remove('show');return;}const matches=[...state.model.nodes.values()].filter(n=>norm(n.label||n.key).includes(q)).slice(0,10);for(const n of matches){const row=document.createElement('button');row.className='search-result';row.textContent=n.label||n.key;row.onclick=()=>{state.tx=svg.clientWidth/2-n.x*state.scale;state.ty=svg.clientHeight/2-n.y*state.scale;applyTransform();results.classList.remove('show');};results.append(row);}results.classList.toggle('show',!!matches.length);};

load();
