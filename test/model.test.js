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
test('Jamnikowsko runs straight to Rondo, then 45 degrees up to Polany',()=>{
 const chain=['Rogowska Centrum Miejskie','Maniaka','Rondo Moryta-Niejawskiego','Grochowa','Strzeleckiego','Szwedzka Stadion','Rondo Nettspenda','Budziszewska','Cmentarzowa','Jamnikowsko','Jamnikowsko PKM','Polany/Kurza','Polany/Północna','Polany/Ukryta','Polany/Rynek','Polany/Straż Pożarna','Polany/Kolejowa'];
 const d=fixture(),r={name:'20',type:'train_light_rail',stations:chain.map(n=>({id:String(names.indexOf(n)),x:config.positions[n][0],z:config.positions[n][1]}))};d.routes.push(r);const m=model.build(d,config);
 const ns=chain.map(n=>m.nodes.get(n));
 for(let i=1;i<3;i++)approx(ns[i].y,ns[0].y);
 for(let i=3;i<ns.length;i++){assert.ok(ns[i].y<ns[i-1].y);approx(Math.abs(ns[i].y-ns[i-1].y),Math.abs(ns[i].x-ns[i-1].x));}
 const edges=[...m.edges.values()].filter(e=>e.services.has('tram:20'));
 assert.ok(edges.some(e=>new Set([e.a,e.b]).has('Maniaka')&&new Set([e.a,e.b]).has('Rogowska Centrum Miejskie')));
 assert.ok(!edges.some(e=>e.a==='Witkowskiego'||e.b==='Witkowskiego'));
});
test('Rynek has four distinct stops and traverses only the forward loop',()=>{
 const d=fixture();d.routes.push({name:'19',type:'train_light_rail',stations:['Królewska','Muzeum Narodowa'].map(n=>({id:String(names.indexOf(n)),x:config.positions[n][0],z:config.positions[n][1]}))});const m=model.build(d,config);const ring=m.corridors.find(c=>c.id==='rynek');assert.equal(ring.keys.length,4);const edges=[...m.edges.values()].filter(e=>e.services.has('tram:19'));assert.equal(edges.length,3);for(const e of edges){const from=[...e.directions.get('tram:19')][0]===1?e.a:e.b;const to=from===e.a?e.b:e.a;assert.equal(ring.keys[(ring.keys.indexOf(from)+1)%4],to);}
});
test('saved edits survive rebuilds but cannot bend locked corridors',()=>{
 const d=fixture();d.stations.push({id:'extra',name:'Surrounding stop'});d.routes[0].stations.push({id:'extra',x:300,z:300});const edits={'Surrounding stop':{x:333,y:444},'Folityn Centralny':{x:20,y:90}};const m=model.build(d,config,edits);assert.equal(m.nodes.get('Surrounding stop').x,333);assert.equal(m.nodes.get('Surrounding stop').y,444);assert.equal(m.nodes.get('Folityn Centralny').x,0);assert.equal(edits['Surrounding stop'].x,333);
});
test('empty and changing live networks do not retain removed services',()=>{assert.equal(model.build({stations:[],routes:[]},config).services.length,0);assert.throws(()=>model.unwrap({error:'offline'}));const d=fixture();d.routes=[];assert.equal(model.build(d,config).edges.size,0);});

test('Rakoniewicka II continues northwest from Rakoniewicka, not back toward Wzgórzyn',()=>{
 const m=model.build(fixture(),config),a=m.nodes.get('Wzgórzyn PKM'),b=m.nodes.get('Rakoniewicka'),c=m.nodes.get('Rakoniewicka II');
 assert.ok(c.x<b.x&&c.y<b.y);approx(b.x-a.x,b.y-a.y);approx(c.x-b.x,c.y-b.y);
 assert.ok((b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y)>0);
});
test('connected neighbors cannot jump across competing short corridor transforms',()=>{
 const cfg={geographicScale:.35,positions:{A:[0,0],B:[100,0],C:[0,100],D:[-100,100]},corridors:[{id:'one',stations:['A','B']},{id:'two',stations:['C','D']}]};
 // Two nearby ten-block segments have opposite schematic directions. The old
 // independent transform would throw P and Q to opposing sides of the map.
 const coordinates={A:[0,0],B:[10,0],C:[0,20],D:[10,20],P:[100,9],Q:[100,11]};
 const station=(name)=>({id:name,x:coordinates[name][0],z:coordinates[name][1]});
 const data={stations:Object.keys(coordinates).map(name=>({id:name,name})),routes:[{name:'100',type:'train_light_rail',stations:['A','B','P','Q','D','C'].map(station)}]};
 const m=model.build(data,cfg),p=m.nodes.get('P'),q=m.nodes.get('Q');
 assert.ok(Math.hypot(p.x-q.x,p.y-q.y)<150,'Neighboring stops must remain close');
 for(const n of m.nodes.values())assert.ok(Math.abs(n.x)<250&&Math.abs(n.y)<250,'No amplified extrapolation');
 const reversed=model.build({...data,routes:data.routes.map(r=>({...r,stations:[...r.stations].reverse()}))},cfg);
 for(const k of ['P','Q']){approx(m.nodes.get(k).x,reversed.nodes.get(k).x);approx(m.nodes.get(k).y,reversed.nodes.get(k).y);}
});
test('new intermediate live stops follow the connected corridor rather than a remote anchor',()=>{
 const cfg={positions:{A:[0,0],B:[300,-300]},corridors:[{id:'diagonal',stations:['A','B']}]};
 const data={stations:['A','P','Q','B'].map(name=>({id:name,name})),routes:[{name:'100',type:'train_light_rail',stations:[{id:'A',x:0,z:0},{id:'P',x:100,z:0},{id:'Q',x:200,z:0},{id:'B',x:300,z:0}]}]};
 const m=model.build(data,cfg),p=m.nodes.get('P'),q=m.nodes.get('Q');assert.ok(p.x>0&&q.x>p.x&&q.x<300);assert.ok(p.y<0&&q.y<p.y&&q.y>-300);assert.ok(Math.abs(p.x+p.y)<.01);assert.ok(Math.abs(q.x+q.y)<.01);
});

test('suburban approaches continue through their junctions instead of doubling back',()=>{
 const sequences=[
  ['Laskowskiego','Laskowskiego Wiadukt','Kobylskiego'],
  ['Laskowskiego Wiadukt','Kobylskiego','Lepianki'],
  ['Rodowa','Muzea','Zmierzch'],
  ['Chwastowa','Muzea','Rodowa'],
  ['Kurzowa','Trzebawska','Solarna']
 ];
 const data=fixture();
 data.routes.push(...sequences.map(stations=>({name:'182',type:'train_light_rail',stations:stations.map(name=>({id:String(names.indexOf(name)),x:config.positions[name][0],z:config.positions[name][1]}))})));
 const m=model.build(data,config);
 for(const keys of sequences) {
  const [a,b,c]=keys.map(k=>m.nodes.get(k));const ux=b.x-a.x,uy=b.y-a.y,vx=c.x-b.x,vy=c.y-b.y;
  assert.ok((ux*vx+uy*vy)/(Math.hypot(ux,uy)*Math.hypot(vx,vy))>=-.01,keys.join(' → '));
 }
});
