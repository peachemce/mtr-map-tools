const NS = 'http://www.w3.org/2000/svg';
const EDIT_KEY = 'folityn-layout-edits-schematic-v2';

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
  edits: JSON.parse(localStorage.getItem(EDIT_KEY) || '{}'),
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
function routeColor(v){
  const raw=v?.color ?? v?.routeColor;
  if(typeof raw==='number') return '#'+(raw&0xffffff).toString(16).padStart(6,'0');
  const s=String(raw??'').trim();
  if(/^#?[0-9a-f]{6}$/i.test(s)) return s.startsWith('#')?s:'#'+s;
  if(/^\d+$/.test(s)) return '#'+(Number(s)&0xffffff).toString(16).padStart(6,'0');
  return '#78909c';
}
function routeClass(r){
  const t=routeType(r), n=routeNumber(r), name=norm(routeName(r));
  const light=t.includes('light_rail') || t==='light_rail';
  if(light && n>=1 && n<=20) return 'tram';
  if(light && n>=100) return 'bus';
  if(t.includes('high_speed') || name==='ic' || name.startsWith('ic_')) return 'high';
  if(!light && (t.includes('train_normal') || t==='rail' || t.includes('train'))) return 'rail';
  if(Number.isFinite(n) && n>=100) return 'bus';
  if(Number.isFinite(n) && n>=1 && n<=20) return 'tram';
  return 'rail';
}
function serviceKey(r){
  const c=routeClass(r), n=routeNumber(r);
  return (c==='tram'||c==='bus') && Number.isFinite(n)
    ? `${c}:${n}`
    : `${c}:${norm(routeName(r).replace(/\s+(to|towards?)\s+.+$/i,''))}`;
}
function serviceLabel(r){ const n=routeNumber(r); return Number.isFinite(n) ? String(n) : routeName(r) || serviceKey(r); }

// Only real visual mergers. Their position comes from the real MTR coordinates.
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
    status.textContent=source==='live'?'Live MTR + schematic locks':'Saved MTR + schematic locks';
    const lock=state.model.locks.find(x=>x.id==='east45');
    time.textContent=`${state.model.services.length} services · ${state.model.nodes.size} stations · ${lock?.members?.length||0} stops on east 45° corridor`;
    $('.help-card strong').textContent='Geography first, corridors second';
    $('.help-card p').textContent='Stations start at their real MTR positions. Important physical streets are then locked into shared schematic corridors. Direction variants never create a second road.';
    buildControls(); render(); fit();
  } catch(err){
    console.error(err); dot.className='status-dot bad'; status.textContent='Could not load map'; time.textContent=err.message; $('#emptyState').hidden=false;
  }
}

function median(vals){ const a=[...vals].sort((x,y)=>x-y),m=a.length>>1; return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function medianPoint(a){ return {x:median(a.map(p=>p.x)), z:median(a.map(p=>p.z))}; }
function dist(a,b){ return Math.hypot((b?.x??0)-(a?.x??0),(b?.y??0)-(a?.y??0)); }

function buildModel(data){
  const topNames=new Map((data.stations||[]).map(s=>[sid(s),String(s.name??s.stationName??sid(s))]));
  const rawByKey=new Map(), rawNames=new Map();
  const addRaw=(key,x,z,name)=>{
    if(!Number.isFinite(x)||!Number.isFinite(z)) return;
    if(!rawByKey.has(key)) rawByKey.set(key,[]);
    rawByKey.get(key).push({x,z});
    if(!rawNames.has(key)) rawNames.set(key,new Set());
    rawNames.get(key).add(name);
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
  const SCALE=Math.min(2200/rangeX,1500/rangeY), PAD=120;
  const project=p=>({x:(-p.x-minX)*SCALE+PAD,y:(-p.z-minY)*SCALE+PAD});

  const nodes=new Map();
  for(const [key,p] of rawCenters){
    const q=project(p), edit=state.edits[key], group=HUB_GROUPS.find(g=>g.key===key);
    nodes.set(key,{key,x:edit?.x??q.x,y:edit?.y??q.y,label:group?.label||key,kind:group?.kind||'normal',services:new Set(),rawNames:rawNames.get(key)||new Set([key]),raw:p,geo:{...q}});
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

  // Choose the cleanest direction as the physical backbone, not blindly the longest one.
  for(const svc of servicesMap.values()){
    svc.variants.sort((a,b)=>variantScore(a,nodes)-variantScore(b,nodes));
    svc.path=svc.variants[0]||[];
    for(const k of svc.servedStops) nodes.get(k)?.services.add(svc.key);
  }

  const services=[...servicesMap.values()].sort(serviceSort);
  const model={nodes,services,serviceOrder:new Map(),edges:new Map(),bounds:{width:rangeX*SCALE+PAD*2,height:rangeY*SCALE+PAD*2},locks:[]};
  model.serviceOrder=new Map(services.map((s,i)=>[s.key,i]));

  // First real schematic rule: the eastern trunk is infrastructure, not service geometry.
  const eastLock=lockNamedCorridor45(model, {
    id:'east45',
    start:['Dworzec Wschodni','Dworzec Wschodni PKM'],
    end:['Kraszewo/Nowa','Kraszewo Nowa'],
    branchDepth:3,
  });
  model.locks.push(eastLock);

  // Clean only very small residual kinks. This is intentionally conservative.
  straightenTinyKinks(model, 8);
  rebuildEdges(model);
  return model;
}

function variantScore(seq,nodes){
  if(seq.length<2) return 1e9;
  let length=0;
  for(let i=1;i<seq.length;i++) length+=dist(nodes.get(seq[i-1]),nodes.get(seq[i]));
  const direct=dist(nodes.get(seq[0]),nodes.get(seq.at(-1)));
  if(direct<8) return length - seq.length*.5;
  const detour=length/direct;
  return detour*1000 - Math.min(seq.length,40)*1.5;
}

function findNodeKey(nodes,names){
  const wanted=names.map(norm);
  for(const [key,n] of nodes){
    const candidates=[key,n.label,...n.rawNames].map(norm);
    if(candidates.some(c=>wanted.includes(c))) return key;
  }
  for(const [key,n] of nodes){
    const candidates=[key,n.label,...n.rawNames].map(norm);
    if(candidates.some(c=>wanted.some(w=>c.includes(w)||w.includes(c)))) return key;
  }
  return null;
}

function lockNamedCorridor45(model, spec){
  const {nodes,services}=model;
  const start=findNodeKey(nodes,spec.start), end=findNodeKey(nodes,spec.end);
  if(!start||!end) return {id:spec.id,active:false,start,end,members:[]};

  const candidates=[];
  for(const svc of services){
    for(const seq of svc.variants){
      const ia=seq.indexOf(start), ib=seq.indexOf(end);
      if(ia<0||ib<0||ia===ib) continue;
      const lo=Math.min(ia,ib), hi=Math.max(ia,ib);
      let sub=seq.slice(lo,hi+1);
      if(sub[0]!==start) sub=[...sub].reverse();
      if(sub.length>=2) candidates.push({svc:svc.key,seq:sub});
    }
  }
  if(!candidates.length) return {id:spec.id,active:false,start,end,members:[]};

  candidates.sort((a,b)=>b.seq.length-a.seq.length);
  const ref=candidates[0].seq;
  const A=nodes.get(start), B=nodes.get(end);
  const rawA=A.raw, rawB=B.raw;
  const rv={x:rawB.x-rawA.x,y:rawB.z-rawA.z};
  const r2=rv.x*rv.x+rv.y*rv.y || 1;
  const rawLen=Math.sqrt(r2);
  const members=new Set(ref);

  // Add one-way/variant-only stops only when they genuinely sit near the same physical axis.
  for(const c of candidates) for(const k of c.seq){
    const n=nodes.get(k); if(!n) continue;
    const px=n.raw.x-rawA.x, py=n.raw.z-rawA.z;
    const t=(px*rv.x+py*rv.y)/r2;
    const perp=Math.abs(px*rv.y-py*rv.x)/rawLen;
    if(t>=-.08&&t<=1.08&&perp<=Math.max(350,rawLen*.12)) members.add(k);
  }

  const ordered=[...members].sort((ka,kb)=>rawProjection(nodes.get(ka).raw,rawA,rv,r2)-rawProjection(nodes.get(kb).raw,rawA,rv,r2));
  if(ordered[0]!==start) ordered.splice(ordered.indexOf(start),1),ordered.unshift(start);
  if(ordered.at(-1)!==end) ordered.splice(ordered.indexOf(end),1),ordered.push(end);

  const old=new Map(ordered.map(k=>[k,{x:nodes.get(k).x,y:nodes.get(k).y}]));
  const dx=B.x-A.x,dy=B.y-A.y;
  const sx=dx>=0?1:-1, sy=dy>=0?1:-1, L=Math.hypot(dx,dy)||300;
  const ux=sx/Math.SQRT2, uy=sy/Math.SQRT2;

  for(const k of ordered){
    const n=nodes.get(k);
    const t=Math.max(0,Math.min(1,rawProjection(n.raw,rawA,rv,r2)));
    if(!state.edits[k]){ n.x=A.x+ux*L*t; n.y=A.y+uy*L*t; }
    n.lock=spec.id;
  }

  // Nearby branches inherit a decaying translation from the corridor attachment point.
  const shifts=new Map();
  const memberSet=new Set(ordered);
  const weights=[0,.82,.48,.22];
  for(const svc of services){
    for(const path of svc.variants){
      for(let i=0;i<path.length;i++){
        const root=path[i]; if(!memberSet.has(root)) continue;
        const before=old.get(root), now=nodes.get(root); if(!before||!now) continue;
        const delta={x:now.x-before.x,y:now.y-before.y};
        for(const dir of [-1,1]){
          for(let d=1;d<=spec.branchDepth;d++){
            const j=i+dir*d; if(j<0||j>=path.length) break;
            const k=path[j]; if(memberSet.has(k)) break;
            const n=nodes.get(k); if(!n||state.edits[k]) continue;
            const w=weights[d]||0; if(!w) continue;
            if(!shifts.has(k)) shifts.set(k,[]);
            shifts.get(k).push({x:delta.x*w,y:delta.y*w});
          }
        }
      }
    }
  }
  for(const [k,list] of shifts){
    const n=nodes.get(k); if(!n) continue;
    n.x+=median(list.map(v=>v.x)); n.y+=median(list.map(v=>v.y));
  }

  // Force every service that traverses the trunk to use the same ordered infrastructure.
  for(const svc of services){
    let best=null;
    for(const seq of svc.variants){
      const hits=seq.filter(k=>memberSet.has(k));
      if(hits.length>=2 && (!best||hits.length>best.length)) best=hits;
    }
    if(!best) continue;
    const first=ordered.indexOf(best[0]), last=ordered.indexOf(best.at(-1));
    if(first<0||last<0) continue;
    const trunk=first<=last?ordered.slice(first,last+1):ordered.slice(last,first+1).reverse();
    const path=svc.path;
    const pFirst=path.indexOf(best[0]), pLast=path.indexOf(best.at(-1));
    if(pFirst>=0&&pLast>=0){
      const lo=Math.min(pFirst,pLast),hi=Math.max(pFirst,pLast);
      const before=path.slice(0,lo), after=path.slice(hi+1);
      const use=pFirst<=pLast?trunk:[...trunk].reverse();
      svc.path=[...before,...use,...after].filter((k,i,a)=>i===0||k!==a[i-1]);
    }
  }

  return {id:spec.id,active:true,start,end,members:ordered};
}

function rawProjection(p,a,v,v2){ return ((p.x-a.x)*v.x+(p.z-a.z)*v.y)/v2; }

function straightenTinyKinks(model, tolerance){
  const {nodes,services}=model;
  const protectedNodes=new Set(model.locks.flatMap(l=>l.members||[]));
  const proposals=new Map();
  for(const svc of services){
    const p=svc.path;
    for(let i=1;i<p.length-1;i++){
      const k=p[i]; if(protectedNodes.has(k)||state.edits[k]) continue;
      const A=nodes.get(p[i-1]),M=nodes.get(k),B=nodes.get(p[i+1]); if(!A||!M||!B) continue;
      const vx=B.x-A.x,vy=B.y-A.y,l2=vx*vx+vy*vy; if(l2<1) continue;
      const t=((M.x-A.x)*vx+(M.y-A.y)*vy)/l2; if(t<=0||t>=1) continue;
      const q={x:A.x+vx*t,y:A.y+vy*t};
      if(Math.hypot(M.x-q.x,M.y-q.y)<=tolerance){
        if(!proposals.has(k)) proposals.set(k,[]); proposals.get(k).push(q);
      }
    }
  }
  for(const [k,qs] of proposals){ const n=nodes.get(k); n.x=median(qs.map(q=>q.x)); n.y=median(qs.map(q=>q.y)); }
}

function rebuildEdges(model){
  model.edges=new Map();
  for(const s of model.services){
    for(let i=1;i<s.path.length;i++){
      const a=s.path[i-1],b=s.path[i]; if(a===b) continue;
      const ek=edgeKey(a,b);
      if(!model.edges.has(ek)) model.edges.set(ek,{a,b,services:new Set()});
      model.edges.get(ek).services.add(s.key);
    }
  }
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
  const important=n.kind!=='normal'||active.length>=3||n.lock;
  const t=svgEl('text',{x:n.x+8,y:n.y-8,class:`station-label${important?' important':''}`,'data-label-for':n.key});
  t.textContent=n.label; labelsLayer.append(t);
}

function updateLabelVisibility(){
  const showAll=state.scale>1.35;
  labelsLayer.querySelectorAll('.station-label').forEach(t=>{
    const n=state.model.nodes.get(t.dataset.labelFor);
    const count=[...n.services].map(k=>state.model.services.find(s=>s.key===k)).filter(s=>s&&visibleService(s)).length;
    t.style.display=(showAll||n.kind!=='normal'||count>=3||n.lock)?'':'none';
  });
}
function showNode(n,ev){
  const svcs=[...n.services].map(k=>state.model.services.find(s=>s.key===k)).filter(Boolean);
  popup.innerHTML=`<h3>${escapeHTML(n.label)}</h3><p>${[...n.rawNames].map(escapeHTML).join(' · ')}</p><p>Real MTR: x ${Math.round(n.raw.x)}, z ${Math.round(n.raw.z)}</p>${n.lock?`<p><strong>Corridor:</strong> ${escapeHTML(n.lock)}</p>`:''}<div class="pills">${svcs.map(s=>`<span class="pill" style="--c:${s.color}">${escapeHTML(s.label)}</span>`).join('')}</div>`;
  placePopup(ev); popup.hidden=false;
}
function showService(s,ev){ popup.innerHTML=`<h3><span class="inline-swatch" style="background:${s.color}"></span>${escapeHTML(s.name)}</h3><p>${s.class} · ${s.servedStops.size} served stops</p><p>One physical backbone is used for both directions.</p>`; placePopup(ev); popup.hidden=false; }
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

function startNodeDrag(ev,n){
  ev.stopPropagation(); const p=screenToMap(ev.clientX,ev.clientY); const ox=n.x-p.x,oy=n.y-p.y;
  const move=e=>{const q=screenToMap(e.clientX,e.clientY);n.x=q.x+ox;n.y=q.y+oy;state.edits[n.key]={x:n.x,y:n.y};localStorage.setItem(EDIT_KEY,JSON.stringify(state.edits));rebuildEdges(state.model);render();};
  const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);
}
function screenToMap(cx,cy){const r=svg.getBoundingClientRect();return{x:(cx-r.left-state.tx)/state.scale,y:(cy-r.top-state.ty)/state.scale};}
$('#editLayout').onclick=()=>{state.edit=!state.edit;$('#editLayout').classList.toggle('active',state.edit);$('#editLayout').textContent=state.edit?'Editing layout':'Edit layout';render();};
$('#resetLayout').onclick=()=>{if(!confirm('Reset manual coordinate edits?'))return;localStorage.removeItem(EDIT_KEY);state.edits={};state.model=buildModel(state.network);render();fit();};
$('#exportLayout').onclick=()=>{const blob=new Blob([JSON.stringify(state.edits,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='folityn-schematic-edits.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};

$('#stationSearch').addEventListener('input',ev=>{
  const q=norm(ev.target.value), box=$('#searchResults'); box.innerHTML=''; if(!q){box.classList.remove('show');return;}
  const found=[...state.model.nodes.values()].filter(n=>norm(n.label).includes(q)||[...n.rawNames].some(x=>norm(x).includes(q))).slice(0,12);
  for(const n of found){const b=document.createElement('button');b.className='search-result';b.textContent=n.label;b.onclick=()=>{centerOn(n);box.classList.remove('show');};box.append(b);} box.classList.toggle('show',!!found.length);
});
function centerOn(n){const shell=$('.map-shell').getBoundingClientRect();state.scale=Math.max(state.scale,1.5);state.tx=shell.width/2-n.x*state.scale;state.ty=shell.height/2-n.y*state.scale;applyTransform();}

load();