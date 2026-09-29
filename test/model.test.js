const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const model=require('../map-model.js');
const config=JSON.parse(fs.readFileSync(new URL('../data/schematic.json',require('node:url').pathToFileURL(__filename)),'utf8').replace(/^\uFEFF/,''));
const names=Object.keys(config.positions).filter(n=>!n.startsWith('@'));
function fixture(){return {stations:names.map((name,i)=>({id:String(i),name})),routes:config.corridors.map((c,i)=>({name:String(i+1),type:'train_light_rail',color:0x88aacc,stations:c.stations.filter(n=>names.includes(n)).map(n=>({id:String(names.indexOf(n)),x:config.positions[n][0]*3,z:config.positions[n][1]*3}))}))};}
function approx(a,b){assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);}
function straight(m,id,axis){const ns=m.corridors.find(c=>c.id===id).keys.map(k=>m.nodes.get(k));for(let i=1;i<ns.length;i++){const dx=ns[i].x-ns[0].x,dy=ns[i].y-ns[0].y;if(axis==='v')approx(dx,0);else if(axis==='h')approx(dy,0);else approx(dy,axis*dx);}}
test('all requested primary corridors remain exact, mirrored and parallel',()=>{
 const m=model.build(fixture(),config);
 straight(m,'central','v');straight(m,'theatre','h');straight(m,'drzewiec','v');straight(m,'east',-1);straight(m,'rogowska',1);straight(m,'muzea',1);
 assert.ok(m.nodes.get('Most Śródmiejski').y>m.nodes.get('Rogowska Centrum Miejskie').y);
});
test('all infrastructure and fallback segments use only horizontal, vertical or 45 degrees',()=>{
 const m=model.build(fixture(),config);for(const e of m.edges.values())for(let i=1;i<e.points.length;i++){const dx=Math.abs(e.points[i].x-e.points[i-1].x),dy=Math.abs(e.points[i].y-e.points[i-1].y);assert.ok(dx<1e-7||dy<1e-7||Math.abs(dx-dy)<1e-7);}
 for(const [a,b] of [[{x:7,y:3},{x:30,y:-90}],[{x:0,y:0},{x:-14,y:-5}]])for(const p of model.octilinear(a,b))assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
});
test('182 direction numbers stay grouped as one bus service; rail names are preserved',()=>{
 assert.equal(model.numericLine({name:'182',number:'1'}),182);assert.equal(model.classify({name:'182',number:'1',type:'train_light_rail'}),'bus');assert.equal(model.numericLine({name:'KF N 1',number:'1'}),null);
 const d=fixture();d.routes=d.routes.slice(0,1).flatMap(r=>[{...r,name:'182',number:'1'},{...r,name:'182',number:'2',stations:[...r.stations].reverse()}]);const m=model.build(d,config);assert.equal(m.services.length,1);assert.equal(m.services[0].variants.length,2);
});
test('skipped stops share infrastructure without inventing a served stop',()=>{
 const d=fixture();const ns=['Folityn Centralny','Most Śródmiejski'];d.routes=[{name:'10',type:'train_light_rail',stations:ns.map(n=>({id:String(names.indexOf(n)),x:config.positions[n][0],z:config.positions[n][1]}))},...d.routes.map(r=>({...r,name:'99'}))];const m=model.build(d,config),s=m.services.find(s=>s.label==='10');assert.equal(s.servedStops.size,2);assert.ok([...m.edges.values()].some(e=>e.services.has(s.key)&&(e.a==='Wiadukt Torowy'||e.b==='Wiadukt Torowy')));
});
test('Jamnikowsko joins Rogowska through Witkowskiego and then the central spine',()=>{
 const d=fixture(),r={name:'6',type:'train_light_rail',stations:['Maniaka','Rogowska Centrum Miejskie','Wiadukt Torowy'].map(n=>({id:String(names.indexOf(n)),x:config.positions[n][0],z:config.positions[n][1]}))};d.routes.push(r);const m=model.build(d,config);assert.ok([...m.edges.values()].some(e=>new Set([e.a,e.b]).has('Witkowskiego')&&new Set([e.a,e.b]).has('Maniaka')&&e.services.has('tram:6')));
});
test('Rynek has four distinct stops and traverses only the forward loop',()=>{
 const d=fixture();d.routes.push({name:'19',type:'train_light_rail',stations:['Królewska','Muzeum Narodowa'].map(n=>({id:String(names.indexOf(n)),x:config.positions[n][0],z:config.positions[n][1]}))});const m=model.build(d,config);const ring=m.corridors.find(c=>c.id==='rynek');assert.equal(ring.keys.length,4);const edges=[...m.edges.values()].filter(e=>e.services.has('tram:19'));assert.equal(edges.length,3);for(const e of edges){const from=[...e.directions.get('tram:19')][0]===1?e.a:e.b;const to=from===e.a?e.b:e.a;assert.equal(ring.keys[(ring.keys.indexOf(from)+1)%4],to);}
});
test('saved edits survive rebuilds but cannot bend locked corridors',()=>{
 const d=fixture();d.stations.push({id:'extra',name:'Surrounding stop'});d.routes[0].stations.push({id:'extra',x:300,z:300});const edits={'Surrounding stop':{x:333,y:444},'Folityn Centralny':{x:20,y:90}};const m=model.build(d,config,edits);assert.equal(m.nodes.get('Surrounding stop').x,333);assert.equal(m.nodes.get('Surrounding stop').y,444);assert.equal(m.nodes.get('Folityn Centralny').x,0);assert.equal(edits['Surrounding stop'].x,333);
});
test('empty and changing live networks do not retain removed services',()=>{assert.equal(model.build({stations:[],routes:[]},config).services.length,0);assert.throws(()=>model.unwrap({error:'offline'}));const d=fixture();d.routes=[];assert.equal(model.build(d,config).edges.size,0);});
