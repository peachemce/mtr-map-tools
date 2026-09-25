const NS = 'http://www.w3.org/2000/svg';

const state = {
  network: null,
  model: null,
  hiddenClasses: new Set(),
  hiddenServices: new Set(),
  scale: 1,
  tx: 0,
  ty: 0,
  drag: null,
  edit: false,
  edits: JSON.parse(localStorage.getItem('folityn-layout-edits-geo-v1') || '{}'),
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
const routeType = r => norm(r?.type);
function routeNumber(r){
  const direct=String(r?.number??'').trim();
  if(/^\d+$/.test(direct)) return Number(direct);
  const m=routeName(r).match(/(?:^|\D)(\d{1,3})(?:\D|$)/); return m ? Number(m[1]) : null;
}
function routeColor(v){ const raw=v?.color ?? v?.routeColor; if(typeof raw==='number') return '#'+(raw&0xffffff).toString(16).padStart(6,'0'); const s=String(raw??'').trim(); if(/^#?[0-9a-f]{6}$/i.test(s)) return s.startsWith('#')?s:'#'+s; if(/^\d+$/.test(s)) return '#'+(Number(s)&0xffffff).toString(16).padStart(6,'0'); return '#78909c'; }
function routeClass(r){ const t=routeType(r), n=routeNumber(r), name=norm(routeName(r)); const light=t.includes('light_rail') || t==='light_rail'; if(light && n>=1 && n<=20) return 'tram'; if(light && n>=100) return 'bus'; if(t.includes('high_speed') || name==='ic' || name.startsWith('ic_')) return 'high'; if(!light && (t.includes('train_normal') || t==='rail' || t.includes('train'))) return 'rail'; if(Number.isFinite(n) && n>=100) return 'bus'; if(Number.isFinite(n) && n>=1 && n<=20) return 'tram'; return 'rail'; }
function serviceKey(r){ const c=routeClass(r), n=routeNumber(r); return (c==='tram'||c==='bus') && Number.isFinite(n) ? `${c}:${n}` : `${c}:${norm(routeName(r).replace(/\s+(to|towards?)\s+.+$/i,''))}`; }
function serviceLabel(r){ const n=routeNumber(r); return Number.isFinite(n) ? String(n) : routeName(r) || serviceKey(r); }

// Only genuine visual mergers. They inherit their position from the real stations.
const HUB_GROUPS = [
  {key:'RYNEK', label:'Rynek', kind:'major-hub', names:['Aleje Osamasona','Stare Miasto','Muzeum Narodowa','Królewska']},
  {key:'Wity', label:'Wity', kind:'hub', names:['Folityn Wity','Wity PKM']},
];
const alias = new Map();
for(const g of HUB_GROUPS) for(const n of g.names) alias.set(norm(n),g.key);
const canonical = name => alias.get(norm(name)) || name;

async function loadJSON(url){ const res=await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${url}: HTTP ${res.status}`); return res.json(); }
async function load(){
  const status=$('#snapshotStatus'), time=$('#snapshotTime'), dot=$('#statusDot');
  try {
    const netRes=await fetch('/api/network',{cache:'no-store'});
    let json, source='snapshot';
    if(netRes.ok){ json=await netRes.json(); source=netRes.headers.get('X-Folityn-Source') || 'live'; }
    else json=await loadJSON('./data/network.json');
    state.network=payload(json);
    state.model=buildModel(state.network);
    dot.className='status-dot ok';
    status.textContent=source==='live'?'Live MTR geography':'Saved MTR geography';
    time.textContent=`${state.model.services.length} services · ${state.model.nodes.size} stations · geography locked`;
    $('.help-card strong').textContent='Geography locked';
    $('.help-card p').textContent='Every station starts from its real MTR x/z position, rotated 180°. No guessed schematic coordinates. Edit mode is only for small manual corrections.';
    buildControls(); render(); fit();
  } catch(err){
    console.error(err); dot.className='status-dot bad'; status.textContent='Could not load map'; time.textContent=err.message; $('#emptyState').hidden=false;
  }
}

function median(vals){ const a=[...vals].sort((x,y)=>x-y),m=a.length>>1; return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function medianPoint(a){ return {x:median(a.map(p=>p.x)), z:median(a.map(p=>p.z))}; }

function buildModel(data){
  const topNames=new Map((data.stations||[]).map(s=>[sid(s),String(s.name??s.stationName??sid(s))]));
  const rawByKey=new Map(), rawNames=new Map();
  const addRaw=(key,x,z,name)=>{
    if(!Number.isFinite(x)||!Number.isFinite(z)) return;
    if(!rawByKey.has(key)) rawByKey.set(key,[]);
    rawByKey.get(key).push({x,z});
    if(!rawNames.has(key)) rawNames.set(key,new Set()); rawNames.get(key).add(name);
  };
  for(const r of data.routes||[]) for(const st of routeStations(r)){
    const name=topNames.get(sid(st)) || String(st.name??sid(st));
    addRaw(canonical(name),xOf(st),zOf(st),name);
  }

  const rawCenters=new Map();
  for(const [key,pts] of rawByKey) rawCenters.set(key,medianPoint(pts));
  const xs=[...rawCenters.values()].map(p=>-p.x), ys=[...rawCenters.values()].map(p=>-p.z);
  const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
  const rangeX=Math.max(1,maxX-minX), rangeY=Math.max(1,maxY-minY);
  const SCALE=Math.min(2200/rangeX,1500/rangeY);
  const PAD=120;
  const project=p=>({x:(-p.x-minX)*SCALE+PAD,y:(-p.z-minY)*SCALE+PAD});

  const nodes=new Map();
  for(const [key,p] of rawCenters){
    const q=project(p), edit=state.edits[key];
    const group=HUB_GROUPS.find(g=>g.key===key);
    nodes.set(key,{key,x:edit?.x??q.x,y:edit?.y??q.y,label:group?.label||key,kind:group?.kind||'normal',services:new Set(),rawNames:rawNames.get(key)||new Set([key]),raw:p});
  }

  const servicesMap=new Map();
  for(const r of data.routes||[]){
    const key=serviceKey(r), cls=routeClass(r);
    if(!servicesMap.has(key)) servicesMap.set(key,{key,label:serviceLabel(r),name:routeName(r)||serviceLabel(r),color:routeColor(r),class:cls,number:routeNumber(r),variants:[],path:[],servedStops:new Set()});
    const seq=[];
    for(const st of routeStations(r)){
      const name=canonical(topNames.get(sid(st))||String(st.name??sid(st)));
      if(nodes.has(name) && seq.at(-1)!==name) seq.push(name);
    }
    if(seq.length>=2) servicesMap.get(key).variants.push(seq);
    seq.forEach(k=>servicesMap.get(key).servedStops.add(k));
  }

  // Direction variants do not get separate roads. The most detailed variant is the backbone.
  for(const svc of servicesMap.values()){
    svc.variants.sort((a,b)=>b.length-a.length);
    svc.path=svc.variants[0]||[];
    svc.path.forEach(k=>nodes.get(k)?.services.add(svc.key));
    // Stops seen only in another direction still belong to the service, but do not bend the backbone.
    for(const k of svc.servedStops) nodes.get(k)?.services.add(svc.key);
  }

  const services=[...servicesMap.values()].sort(serviceSort);
  const serviceOrder=new Map(services.map((s,i)=>[s.key,i]));
  const edges=new Map();
  for(const s of services){
    for(let i=1;i<s.path.length;i++){
      const a=s.path[i-1],b=s.path[i], ek=edgeKey(a,b);
      if(!edges.has(ek)) edges.set(ek,{a,b,services:new Set()});
      edges.get(ek).services.add(s.key);
    }
  }
  return {nodes,services,serviceOrder,edges,bounds:{width:rangeX*SCALE+PAD*2,height:rangeY*SCALE+PAD*2}};
}

function edgeKey(a,b){ return a<b?`${a}|${b}`:`${b}|${a}`; }
function serviceSort(a,b){ const order={tram:0,bus:1,rail:2,high:3}; return (order[a.class]-order[b.class]) || ((a.number??99999)-(b.number??99999)) || a.name.localeCompare(b.name); }
function visibleService(s){ return !state.hiddenClasses.has(s.class)&&!state.hiddenServices.has(s.key); }

function buildControls(){
  const classBox=$('#classFilters'); classBox.innerHTML='';
  const labels={tram:'Trams 1–20',bus:'Buses 100+',rail:'Normal rail',high:'High speed / IC'};
  for(const cls of ['tram','bus','rail','high']){
    const row=document.createElement('label'); row.className='toggle-row';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=true;
    cb.onchange=()=>{cb.checked?state.hiddenClasses.delete(cls):state.hiddenClasses.add(cls);render();};
    const span=document.createElement('span'); span.textContent=labels[cls]; row.append(cb,span); classBox.append(row);
  }
  const list=$('#routeList'); list.innerHTML='';
  for(const s of state.model.services){
    const row=document.createElement('label'); row.className='route-item';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=true;
    cb.onchange=()=>{cb.checked?state.hiddenServices.delete(s.key):state.hiddenServices.add(s.key);render();};
    const sw=document.createElement('span'); sw.className='swatch'; sw.style.background=s.color;
    const name=document.createElement('span'); name.textContent=s.label; name.title=s.name;
    row.append(cb,sw,name); list.append(row);
  }
}

function render(){
  corridorsLayer.innerHTML=routesLayer.innerHTML=stationsLayer.innerHTML=labelsLayer.innerHTML='';
  const {nodes,services,serviceOrder,edges}=state.model;
  for(const e of edges.values()){
    const A=nodes.get(e.a),B=nodes.get(e.b); if(!A||!B)continue;
    corridorsLayer.append(svgEl('line',{x1:A.x,y1:A.y,x2:B.x,y2:B.y,class:'corridor-base'}));
    const active=[...e.services].map(k=>services.find(s=>s.key===k)).filter(s=>s&&visibleService(s)).sort((a,b)=>serviceOrder.get(a.key)-serviceOrder.get(b.key));
    const dx=B.x-A.x,dy=B.y-A.y,L=Math.hypot(dx,dy)||1,nx=-dy/L,ny=dx/L,gap=4.4;
    active.forEach((s,i)=>{
      const off=(i-(active.length-1)/2)*gap;
      const line=svgEl('line',{x1:A.x+nx*off,y1:A.y+ny*off,x2:B.x+nx*off,y2:B.y+ny*off,stroke:s.color,class:'route-line','data-service':s.key});
      line.onclick=ev=>{ev.stopPropagation();showService(s,ev);}; routesLayer.append(line);
    });
  }
  for(const n of nodes.values()) drawNode(n);
  updateLabelVisibility(); applyTransform();
}

function drawNode(n){
  const active=[...n.services].map(k=>state.model.services.find(s=>s.key===k)).filter(s=>s&&visibleService(s));
  if(!active.length) return;
  const g=svgEl('g',{class:`station-group ${n.kind}`,'data-key':n.key});
  if(state.edit) g.classList.add('editable');
  let shape;
  if(n.kind==='major-hub') shape=svgEl('circle',{cx:n.x,cy:n.y,r:13,class:'hub major-hub'});
  else if(n.kind==='hub') shape=svgEl('circle',{cx:n.x,cy:n.y,r:9,class:'hub'});
  else shape=svgEl('circle',{cx:n.x,cy:n.y,r:4.5,class:'station-dot'});
  g.append(shape); g.onclick=ev=>{ev.stopPropagation();showNode(n,ev);};
  if(state.edit) g.onpointerdown=ev=>startNodeDrag(ev,n);
  stationsLayer.append(g);
  const important=n.kind!=='normal'||active.length>=3;
  const t=svgEl('text',{x:n.x+8,y:n.y-8,class:`station-label${important?' important':''}`,'data-label-for':n.key});
  t.textContent=n.label; labelsLayer.append(t);
}

function updateLabelVisibility(){
  const showAll=state.scale>1.35;
  labelsLayer.querySelectorAll('.station-label').forEach(t=>{ const n=state.model.nodes.get(t.dataset.labelFor); const count=[...n.services].map(k=>state.model.services.find(s=>s.key===k)).filter(s=>s&&visibleService(s)).length; t.style.display=(showAll||n.kind!=='normal'||count>=3)?'':'none'; });
}
function showNode(n,ev){
  const svcs=[...n.services].map(k=>state.model.services.find(s=>s.key===k)).filter(Boolean);
  popup.innerHTML=`<h3>${escapeHTML(n.label)}</h3><p>${[...n.rawNames].map(escapeHTML).join(' · ')}</p><p>Real MTR: x ${Math.round(n.raw.x)}, z ${Math.round(n.raw.z)}</p><div class="pills">${svcs.map(s=>`<span class="pill" style="--c:${s.color}">${escapeHTML(s.label)}</span>`).join('')}</div>`;
  placePopup(ev); popup.hidden=false;
}
function showService(s,ev){ popup.innerHTML=`<h3><span class="inline-swatch" style="background:${s.color}"></span>${escapeHTML(s.name)}</h3><p>${s.class} · ${s.servedStops.size} served stops</p><p>One geographic backbone is used for both directions.</p>`; placePopup(ev); popup.hidden=false; }
function placePopup(ev){ const shell=$('.map-shell').getBoundingClientRect(); popup.style.left=Math.min(shell.width-320,Math.max(10,ev.clientX-shell.left+12))+'px'; popup.style.top=Math.min(shell.height-190,Math.max(10,ev.clientY-shell.top+12))+'px'; }
function escapeHTML(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function applyTransform(){ viewport.setAttribute('transform',`translate(${state.tx} ${state.ty}) scale(${state.scale})`); updateLabelVisibility(); }
function fit(){
  const shell=$('.map-shell').getBoundingClientRect(), ns=[...state.model.nodes.values()]; if(!ns.length)return;
  const minX=Math.min(...ns.map(n=>n.x))-50,maxX=Math.max(...ns.map(n=>n.x))+50,minY=Math.min(...ns.map(n=>n.y))-50,maxY=Math.max(...ns.map(n=>n.y))+50;
  const w=maxX-minX,h=maxY-minY; state.scale=Math.min((shell.width-40)/w,(shell.height-40)/h); state.tx=(shell.width-w*state.scale)/2-minX*state.scale; state.ty=(shell.height-h*state.scale)/2-minY*state.scale; applyTransform();
}
function zoomAt(f,cx,cy){ const old=state.scale, next=Math.max(.08,Math.min(8,old*f)); state.tx=cx-(cx-state.tx)*(next/old); state.ty=cy-(cy-state.ty)*(next/old); state.scale=next; applyTransform(); }
svg.addEventListener('wheel',ev=>{ev.preventDefault();const r=svg.getBoundingClientRect();zoomAt(ev.deltaY<0?1.14:.88,ev.clientX-r.left,ev.clientY-r.top);},{passive:false});
svg.addEventListener('pointerdown',ev=>{ if(state.edit||ev.button!==0)return; popup.hidden=true; state.drag={x:ev.clientX,y:ev.clientY,tx:state.tx,ty:state.ty}; svg.setPointerCapture(ev.pointerId); svg.classList.add('dragging'); });
svg.addEventListener('pointermove',ev=>{ if(!state.drag)return; state.tx=state.drag.tx+ev.clientX-state.drag.x; state.ty=state.drag.ty+ev.clientY-state.drag.y; applyTransform(); });
svg.addEventListener('pointerup',()=>{state.drag=null;svg.classList.remove('dragging');});
svg.addEventListener('click',()=>popup.hidden=true);
$('#zoomIn').onclick=()=>zoomAt(1.2,svg.clientWidth/2,svg.clientHeight/2);
$('#zoomOut').onclick=()=>zoomAt(.82,svg.clientWidth/2,svg.clientHeight/2);
$('#fitMap').onclick=fit;

function startNodeDrag(ev,n){ ev.stopPropagation(); const p=screenToMap(ev.clientX,ev.clientY); const ox=n.x-p.x,oy=n.y-p.y; const move=e=>{const q=screenToMap(e.clientX,e.clientY);n.x=q.x+ox;n.y=q.y+oy;state.edits[n.key]={x:n.x,y:n.y};localStorage.setItem('folityn-layout-edits-geo-v1',JSON.stringify(state.edits));render();}; const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',up); }
function screenToMap(cx,cy){const r=svg.getBoundingClientRect();return{x:(cx-r.left-state.tx)/state.scale,y:(cy-r.top-state.ty)/state.scale};}
$('#editLayout').onclick=()=>{state.edit=!state.edit;$('#editLayout').classList.toggle('active',state.edit);$('#editLayout').textContent=state.edit?'Editing geography':'Edit layout';render();};
$('#resetLayout').onclick=()=>{if(!confirm('Reset manual coordinate edits?'))return;localStorage.removeItem('folityn-layout-edits-geo-v1');state.edits={};state.model=buildModel(state.network);render();fit();};
$('#exportLayout').onclick=()=>{const blob=new Blob([JSON.stringify(state.edits,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='folityn-geography-edits.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};

$('#stationSearch').addEventListener('input',ev=>{
  const q=norm(ev.target.value), box=$('#searchResults'); box.innerHTML=''; if(!q){box.classList.remove('show');return;}
  const found=[...state.model.nodes.values()].filter(n=>norm(n.label).includes(q)||[...n.rawNames].some(x=>norm(x).includes(q))).slice(0,12);
  for(const n of found){const b=document.createElement('button');b.className='search-result';b.textContent=n.label;b.onclick=()=>{centerOn(n);box.classList.remove('show');};box.append(b);} box.classList.toggle('show',!!found.length);
});
function centerOn(n){const shell=$('.map-shell').getBoundingClientRect();state.scale=Math.max(state.scale,1.5);state.tx=shell.width/2-n.x*state.scale;state.ty=shell.height/2-n.y*state.scale;applyTransform();}

load();