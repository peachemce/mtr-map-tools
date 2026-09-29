'use strict';
const NS='http://www.w3.org/2000/svg', EDIT_KEY='folityn-layout-v3';
const $=s=>document.querySelector(s);
const svg=$('#map'),viewport=$('#viewport'),popup=$('#stationPopup');
const layers={corridors:$('#corridorsLayer'),routes:$('#routesLayer'),stations:$('#stationsLayer'),labels:$('#labelsLayer')};
const el=(tag,attrs={})=>{const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
function readEdits(){try{return JSON.parse(localStorage.getItem(EDIT_KEY)||'{}')??{};}catch{return {};}}
const state={model:null,network:null,config:null,edits:readEdits(),hiddenClasses:new Set(),hiddenServices:new Set(),scale:1,tx:0,ty:0,editing:false,busy:false,lastSuccess:null};
const visible=s=>!state.hiddenClasses.has(s.class)&&!state.hiddenServices.has(s.key);
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const endpoint=location.hostname==='peachemce.github.io'?'http://127.0.0.1:5173/api/network':'./api/network';
async function refresh(){
  if(state.busy)return;state.busy=true;$('#refresh').disabled=true;
  try{
    if(!state.config){const r=await fetch('./data/schematic.json',{cache:'no-store'});if(!r.ok)throw new Error('Could not load corridor layout');state.config=await r.json();}
    const r=await fetch(endpoint,{cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(!r.ok)throw new Error('MTR is unavailable. Keep Minecraft and its web map running on port 8888.');
    const json=await r.json(),network=TransitModel.unwrap(json),model=TransitModel.build(network,state.config,state.edits);
    const first=!state.model;state.network=network;state.model=model;state.lastSuccess=new Date();
    $('#statusDot').className='status-dot ok';$('#connectionStatus').textContent='Connected to live MTR';
    $('#connectionDetail').textContent=`${model.stationCount} stations · ${model.services.length} services · every 15s`;
    $('#updatedAt').textContent='Updated '+state.lastSuccess.toLocaleTimeString();
    $('#emptyState').hidden=true;buildControls();render();if(first)fit(true);
  }catch(error){
    $('#statusDot').className='status-dot bad';$('#connectionStatus').textContent=state.model?'Connection lost · map is stale':'MTR is offline';
    $('#connectionDetail').textContent=state.lastSuccess?'Last received '+state.lastSuccess.toLocaleTimeString()+' · retrying every 15s':error.message;
    $('#emptyState').hidden=!!state.model;
  }finally{state.busy=false;$('#refresh').disabled=false;}
}
function buildControls(){
  $('#networkCount').textContent=state.model.stationCount+' stops';
  $('#classFilters').replaceChildren();
  for(const [cls,label] of Object.entries({tram:'Trams',bus:'Buses',rail:'Regional rail',high:'High speed / IC'})){
    const row=document.createElement('label');row.className='toggle-row';const input=document.createElement('input');input.type='checkbox';input.checked=!state.hiddenClasses.has(cls);
    input.onchange=()=>{input.checked?state.hiddenClasses.delete(cls):state.hiddenClasses.add(cls);render();};
    const text=document.createElement('span');text.textContent=label;row.append(input,text);$('#classFilters').append(row);
  }
  $('#routeList').replaceChildren();
  for(const s of state.model.services){
    const row=document.createElement('label');row.className='route-item';const input=document.createElement('input');input.type='checkbox';input.checked=!state.hiddenServices.has(s.key);
    input.onchange=()=>{input.checked?state.hiddenServices.delete(s.key):state.hiddenServices.add(s.key);render();};
    const sw=document.createElement('span');sw.className='swatch';sw.style.background=s.color;
    const label=document.createElement('span');label.textContent=s.label;row.title=s.class+' · '+s.servedStops.size+' stops';row.append(input,sw,label);$('#routeList').append(row);
  }
  $('#corridorList').replaceChildren();
  for(const c of state.model.corridors.filter(c=>['central','theatre','east','drzewiec','rogowska','muzea','jamnikowsko','rynek'].includes(c.id))){const b=document.createElement('button');b.textContent=c.label;b.onclick=()=>fitNodes(c.keys.map(k=>state.model.nodes.get(k)));$('#corridorList').append(b);}
}
function pointsText(points){return points.map(p=>p.x+','+p.y).join(' ');}
function offsetPoints(points,off){
  // Intersection of neighboring parallel segments gives sharp, continuous 45° elbows.
  const lines=[];
  for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],l=Math.hypot(b.x-a.x,b.y-a.y)||1;const nx=-(b.y-a.y)/l,ny=(b.x-a.x)/l;lines.push({a:{x:a.x+nx*off,y:a.y+ny*off},b:{x:b.x+nx*off,y:b.y+ny*off}});}
  const out=[lines[0].a];
  for(let i=1;i<lines.length;i++){const u=lines[i-1],v=lines[i],dx=u.b.x-u.a.x,dy=u.b.y-u.a.y,ex=v.b.x-v.a.x,ey=v.b.y-v.a.y,den=dx*ey-dy*ex;if(Math.abs(den)<1e-8){out.push(u.b);continue;}const t=((v.a.x-u.a.x)*ey-(v.a.y-u.a.y)*ex)/den;out.push({x:u.a.x+t*dx,y:u.a.y+t*dy});}
  out.push(lines.at(-1).b);return out;
}
function render(){
  if(!state.model)return;popup.hidden=true;
  Object.values(layers).forEach(l=>l.replaceChildren());
  const {nodes,services,edges}=state.model,byKey=new Map(services.map(s=>[s.key,s])),drawnNodes=new Set();
  const lanePools=new Map();
  const edgeCorridor=new Map();
  for(const edge of edges.values()) {
    const corridor=state.model.corridors.find(c=>c.keys.includes(edge.a)&&c.keys.includes(edge.b));
    if(!corridor)continue;
    edgeCorridor.set(edge.key,corridor.id);
    if(!lanePools.has(corridor.id))lanePools.set(corridor.id,new Set());
    for(const key of edge.services)if(visible(byKey.get(key)))lanePools.get(corridor.id).add(key);
  }
  for(const edge of edges.values()){
    const active=services.filter(s=>edge.services.has(s.key)&&visible(s));if(!active.length)continue;
    drawnNodes.add(edge.a);drawnNodes.add(edge.b);
    // Keep lanes in a consistent spatial orientation across adjacent edges.
    const ps=edge.points[0].x<edge.points.at(-1).x||(edge.points[0].x===edge.points.at(-1).x&&edge.points[0].y<edge.points.at(-1).y)?edge.points:[...edge.points].reverse();
    layers.corridors.append(el('polyline',{points:pointsText(ps),class:'corridor-base'}));
    const pool=lanePools.get(edgeCorridor.get(edge.key));
    const lanes=pool?services.filter(s=>pool.has(s.key)):active;
    active.forEach(s=>{
      const i=lanes.indexOf(s);
      const offset=(i-(lanes.length-1)/2)*5;
      let points=offsetPoints(ps,offset);
      if(edge.loop) {
        const ring=state.model.corridors.find(c=>c.id===edge.loop);
        const ringPoints=ring.keys.map(k=>nodes.get(k));
        const polygon=offsetPoints([ringPoints.at(-1),...ringPoints,ringPoints[0],ringPoints[1]],offset).slice(1,-2);
        points=[polygon[ring.keys.indexOf(edge.a)],polygon[ring.keys.indexOf(edge.b)]];
      }
      const line=el('polyline',{points:pointsText(points),stroke:s.color,class:'route-line','data-service':s.key});
      line.onclick=e=>{e.stopPropagation();showPopup(s.label,`${s.servedStops.size} stops · ${s.variants.length} direction variants`,[s],e);};layers.routes.append(line);
    });
    if(edge.loop){
      // Arrow follows the configured loop direction, independent of edge storage ordering.
      const c=state.model.corridors.find(c=>c.id===edge.loop),i=c.keys.indexOf(edge.a);
      const forward=c.keys[(i+1)%c.keys.length]===edge.b;
      const a=nodes.get(forward?edge.a:edge.b),b=nodes.get(forward?edge.b:edge.a),angle=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
      const arrow=el('path',{d:'M -7 -5 L 0 0 L -7 5',class:'direction-arrow',transform:`translate(${(a.x+b.x)/2} ${(a.y+b.y)/2}) rotate(${angle})`});layers.stations.append(arrow);
    }
  }
  for(const n of nodes.values()){
    const active=[...n.services].map(k=>byKey.get(k)).filter(s=>s&&visible(s));
    if(n.virtual||!active.length||!drawnNodes.has(n.key))continue;
    const g=el('g',{class:'station-group'+(state.editing&&!n.fixed?' editable':''),'data-key':n.key,tabindex:0,role:'button','aria-label':n.label});
    const hub=['Folityn Centralny','Wzgórzyn PKM','Rogowska Centrum Miejskie','Wity PKM','Drzewiec PKM','Most Śródmiejski'].includes(n.key);
    g.append(el('circle',{cx:n.x,cy:n.y,r:hub?9:4.5,class:hub?'hub':'station-dot'}));
    const title=el('title');title.textContent=n.label+(n.fixed?' · Fixed corridor':'');g.append(title);
    const show=e=>showPopup(n.label,n.locks.has('rynek')?'Rynek · one-way loop':n.fixed?'Fixed corridor station':'Live MTR station',active,e);
    g.onclick=e=>{e.stopPropagation();show(e);};g.onkeydown=e=>{if(e.key==='Enter'){const r=g.getBoundingClientRect();show({clientX:r.x,clientY:r.y});}};
    g.onpointerdown=e=>{if(state.editing&&!n.fixed)startNodeDrag(e,n);};layers.stations.append(g);
    const label=el('text',{x:n.x+12,y:n.y-12,class:'station-label','data-key':n.key,'data-important':hub||n.locks.has('rynek')?'true':'false'});label.textContent=n.label;layers.labels.append(label);
    g.onpointerenter=()=>{label.dataset.hover='true';updateLabels();};g.onpointerleave=()=>{delete label.dataset.hover;updateLabels();};
  }
  const ring=state.model.corridors.find(c=>c.id==='rynek');
  if(ring&&ring.keys.some(k=>drawnNodes.has(k))){const ns=ring.keys.map(k=>nodes.get(k)),label=el('text',{x:ns.reduce((s,n)=>s+n.x,0)/ns.length,y:ns.reduce((s,n)=>s+n.y,0)/ns.length+4,class:'rynek-title','text-anchor':'middle'});label.textContent='RYNEK';layers.labels.append(label);}
  applyTransform();
}
function updateLabels(){
  const placed=[];
  const labels=[...layers.labels.querySelectorAll('.station-label')].sort((a,b)=>(b.dataset.hover?2:b.dataset.important==='true'?1:0)-(a.dataset.hover?2:a.dataset.important==='true'?1:0));
  for(const t of labels){
    const x=+t.getAttribute('x'),y=+t.getAttribute('y');t.setAttribute('transform',`translate(${x} ${y}) scale(${1/state.scale}) translate(${-x} ${-y})`);
    const box={x:x*state.scale,y:y*state.scale,w:t.textContent.length*6.5,h:15};
    const overlap=placed.some(b=>box.x<b.x+b.w+8&&box.x+box.w+8>b.x&&box.y<b.y+b.h+4&&box.y+box.h+4>b.y);
    const show=t.dataset.hover||(!overlap&&(state.scale>.65||t.dataset.important==='true'));
    t.style.display=show?'':'none';if(show)placed.push(box);
  }
}
function showPopup(title,detail,services,event){
  popup.innerHTML=`<button class="close-popup" aria-label="Close">×</button><h3>${escape(title)}</h3><p>${escape(detail)}</p><div class="pills">${services.map(s=>`<span class="pill" style="--c:${s.color}">${escape(s.label)}</span>`).join('')}</div>`;
  popup.querySelector('button').onclick=()=>popup.hidden=true;
  const r=$('.map-shell').getBoundingClientRect();popup.style.left=Math.max(8,Math.min(r.width-300,event.clientX-r.left+12))+'px';popup.style.top=Math.max(60,Math.min(r.height-190,event.clientY-r.top+12))+'px';popup.hidden=false;
}
function applyTransform(){viewport.setAttribute('transform',`translate(${state.tx} ${state.ty}) scale(${state.scale})`);updateLabels();}
function fitNodes(ns){if(!ns.length)return;const r=svg.getBoundingClientRect(),minX=Math.min(...ns.map(n=>n.x))-80,maxX=Math.max(...ns.map(n=>n.x))+160,minY=Math.min(...ns.map(n=>n.y))-100,maxY=Math.max(...ns.map(n=>n.y))+100;state.scale=Math.max(.03,Math.min(2,(r.width-80)/(maxX-minX),(r.height-150)/(maxY-minY)));state.tx=(r.width-(maxX-minX)*state.scale)/2-minX*state.scale;state.ty=(r.height-(maxY-minY)*state.scale)/2-minY*state.scale;applyTransform();}
function fit(city){if(state.model)fitNodes([...state.model.nodes.values()].filter(n=>!city||n.fixed));}
function zoom(f,x=svg.clientWidth/2,y=svg.clientHeight/2){const next=Math.max(.025,Math.min(5,state.scale*f)),ratio=next/state.scale;state.tx=x-(x-state.tx)*ratio;state.ty=y-(y-state.ty)*ratio;state.scale=next;applyTransform();}
function screenToMap(e){const r=svg.getBoundingClientRect();return{x:(e.clientX-r.left-state.tx)/state.scale,y:(e.clientY-r.top-state.ty)/state.scale};}
function startNodeDrag(e,n){
  e.stopPropagation();let changed=false;
  const move=event=>{const p=screenToMap(event);state.edits[n.key]={x:Math.round(p.x/20)*20,y:Math.round(p.y/20)*20};state.model=TransitModel.build(state.network,state.config,state.edits);changed=true;render();};
  const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);if(changed)try{localStorage.setItem(EDIT_KEY,JSON.stringify(state.edits));}catch{$('#connectionDetail').textContent='Layout edits could not be saved in this browser.';}};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);
}
let drag=null;
svg.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,tx:state.tx,ty:state.ty};svg.setPointerCapture(e.pointerId);popup.hidden=true;});
svg.addEventListener('pointermove',e=>{if(!drag)return;state.tx=drag.tx+e.clientX-drag.x;state.ty=drag.ty+e.clientY-drag.y;applyTransform();});
for(const name of ['pointerup','pointercancel'])svg.addEventListener(name,()=>drag=null);
svg.addEventListener('wheel',e=>{e.preventDefault();const r=svg.getBoundingClientRect();zoom(e.deltaY<0?1.15:1/1.15,e.clientX-r.left,e.clientY-r.top);},{passive:false});
$('#zoomIn').onclick=()=>zoom(1.25);$('#zoomOut').onclick=()=>zoom(.8);$('#fitCity').onclick=()=>fit(true);$('#fitMap').onclick=()=>fit(false);
$('#refresh').onclick=refresh;$('#retry').onclick=refresh;$('#showAll').onclick=()=>{state.hiddenClasses.clear();state.hiddenServices.clear();if(state.model){buildControls();render();}};
$('#menu').onclick=()=>document.body.classList.toggle('sidebar-open');
$('#editLayout').onclick=()=>{state.editing=!state.editing;$('#editLayout').textContent=state.editing?'Finish editing':'Edit layout';render();};
$('#exportLayout').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(state.edits,null,2)],{type:'application/json'}));a.download='folityn-layout-edits.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
$('#resetLayout').onclick=()=>{if(!confirm('Reset your saved adjustments?'))return;state.edits={};try{localStorage.removeItem(EDIT_KEY);}catch{}if(state.network){state.model=TransitModel.build(state.network,state.config);render();}};
$('#stationSearch').oninput=e=>{
  const box=$('#searchResults');box.replaceChildren();const q=TransitModel.norm(e.target.value);if(!q||!state.model)return;
  const found=[...state.model.nodes.values()].filter(n=>!n.virtual&&(TransitModel.norm(n.label).includes(q)||(q==='rynek'&&n.locks.has('rynek')))).slice(0,12);
  for(const n of found){const b=document.createElement('button');b.textContent=n.locks.has('rynek')?n.label+' · Rynek':n.label;b.onclick=()=>{state.scale=1.25;state.tx=svg.clientWidth/2-n.x*state.scale;state.ty=svg.clientHeight/2-n.y*state.scale;applyTransform();box.replaceChildren();document.body.classList.remove('sidebar-open');};box.append(b);}
};
refresh();setInterval(()=>{if(!state.editing)refresh();},15000);
