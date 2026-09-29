/* Shared by the browser and Node tests. Geometry is infrastructure; services only use it. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TransitModel = factory();
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g,'l').replace(/Ł/g,'L').toLowerCase().replace(/[^a-z0-9]/g,'');
  const id = s => String(s.id ?? s.stationId ?? s.hexId ?? '');
  const stops = r => r.stations ?? r.routeStations ?? r.platforms ?? [];
  const median = values => { const a=[...values].sort((a,b)=>a-b); return (a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2; };
  const distance = (a,b) => Math.hypot(b.x-a.x,b.y-a.y);
  const edgeKey = (a,b) => [a,b].sort().join('|');
  function numericLine(r) {
    // MTR uses number for direction identifiers on some routes (182 has 1 and 2).
    const name=String(r.name ?? r.routeName ?? '').trim();
    const match=name.match(/^(\d{1,3})(?:$|\s*[-–—:]\s*\S)/);
    if(match) return Number(match[1]);
    return /^\d{1,3}$/.test(String(r.number ?? '')) && !name ? Number(r.number) : null;
  }
  function classify(r) {
    const t=norm(r.type), n=numericLine(r);
    if(t.includes('highspeed') || /^IC\b/i.test(r.name ?? '')) return 'high';
    if(t.includes('lightrail')) return n!==null&&n>=1&&n<=20?'tram':'bus';
    return 'rail';
  }
  function color(value) {
    if(typeof value==='number') return '#'+(value&0xffffff).toString(16).padStart(6,'0');
    const s=String(value??'');
    if(/^#?[0-9a-f]{6}$/i.test(s)) return '#'+s.replace('#','');
    return '#94a3b8';
  }
  function unwrap(json) {
    const data=json?.data ?? json;
    if(!data || !Array.isArray(data.stations) || !Array.isArray(data.routes)) throw new Error('MTR response must contain stations and routes arrays.');
    return data;
  }
  // No Bezier curves: at most one 45-degree elbow between unconstrained points.
  function octilinear(a,b) {
    const dx=b.x-a.x,dy=b.y-a.y,ax=Math.abs(dx),ay=Math.abs(dy);
    if(ax<1e-7 || ay<1e-7 || Math.abs(ax-ay)<1e-7) return [{x:a.x,y:a.y},{x:b.x,y:b.y}];
    const p=ax>ay?{x:a.x+Math.sign(dx)*ay,y:b.y}:{x:b.x,y:a.y+Math.sign(dy)*ax};
    return [{x:a.x,y:a.y},p,{x:b.x,y:b.y}];
  }
  function build(json,config,edits={}) {
    const data=unwrap(json), warnings=[];
    const stationById=new Map(data.stations.map(s=>[id(s),s]));
    const aliases=new Map(Object.entries(config.aliases??{}).map(([a,b])=>[norm(a),b]));
    const canonical=name=>aliases.get(norm(name))??name;
    const raw=new Map();
    const nameOf=s=>canonical(String(stationById.get(id(s))?.name ?? s.stationName ?? s.name ?? id(s)));
    for(const r of data.routes) {
      if(r.hidden) continue;
      for(const s of stops(r)) {
        const key=nameOf(s), x=Number(s.x??s.position?.x), y=Number(s.z??s.position?.z);
        if(!Number.isFinite(x)||!Number.isFinite(y)) continue;
        if(!raw.has(key)) raw.set(key,{points:[],ids:new Set()});
        raw.get(key).points.push({x,y});raw.get(key).ids.add(id(s));
      }
    }
    const nodes=new Map([...raw].map(([key,v])=>[key,{key,label:key,raw:{x:median(v.points.map(p=>p.x)),y:median(v.points.map(p=>p.y))},ids:v.ids,services:new Set(),locks:new Set(),virtual:false}]));
    const lookup=new Map([...nodes.keys()].map(k=>[norm(k),k]));
    const resolve=name=>lookup.get(norm(canonical(name)));
    const configured=new Map();
    for(const [name,point] of Object.entries(config.positions)) {
      let key=resolve(name);
      if(name.startsWith('@')) { key=name; nodes.set(key,{key,label:'',virtual:true,services:new Set(),locks:new Set()}); }
      if(!key) { warnings.push('Station missing: '+name); continue; }
      const n=nodes.get(key); n.x=point[0]; n.y=point[1]; n.fixed=true;
      configured.set(name,key);
    }
    const corridors=[];
    for(const spec of config.corridors) {
      const keys=spec.stations.map(name=>configured.get(name)??resolve(name)).filter(Boolean);
      if(keys.length<2) { warnings.push('Corridor unavailable: '+spec.label); continue; }
      const c={...spec,keys}; corridors.push(c);
      for(const k of keys) nodes.get(k).locks.add(c.id);
    }
    // Solve one connected displacement field instead of choosing a different
    // rotation/scale for every stop. Adjacent stops now move together even at
    // corridor boundaries; short raw segments cannot magnify distant branches.
    const adjacency=new Map([...nodes.keys()].map(k=>[k,new Map()]));
    for(const r of data.routes) {
      if(r.hidden)continue;
      const seq=stops(r).map(nameOf).filter(k=>nodes.has(k));
      for(let i=1;i<seq.length;i++) {
        const a=nodes.get(seq[i-1]),b=nodes.get(seq[i]);
        if(a===b||!a.raw||!b.raw)continue;
        const weight=1/Math.max(60,distance(a.raw,b.raw));
        adjacency.get(a.key).set(b.key,weight);
        adjacency.get(b.key).set(a.key,weight);
      }
    }
    const reference=nodes.get(resolve('Folityn Centralny'))?.raw??{x:0,y:0};
    const scale=config.geographicScale??.35;
    const displacement=new Map();
    for(const n of nodes.values()) {
      if(!n.raw)continue;
      n.base={x:(n.raw.x-reference.x)*scale,y:(n.raw.y-reference.y)*scale};
      const edit=edits[n.key];
      if(!n.fixed&&Number.isFinite(edit?.x)&&Number.isFinite(edit?.y)) {
        n.x=edit.x;n.y=edit.y;n.edited=true;
      }
      displacement.set(n.key,n.fixed||n.edited?{x:n.x-n.base.x,y:n.y-n.base.y}:{x:0,y:0});
    }
    // Deterministic Gauss-Seidel relaxation of the weighted graph Laplacian.
    // Anchors and saved edits are boundary conditions, not competing suggestions.
    const free=[...nodes.values()].filter(n=>n.raw&&!n.fixed&&!n.edited).sort((a,b)=>a.key.localeCompare(b.key));
    for(let iteration=0;iteration<1500;iteration++) {
      let movement=0;
      for(const n of free) {
        let x=0,y=0,total=0;
        for(const [key,w] of adjacency.get(n.key)) {
          const d=displacement.get(key);if(!d)continue;
          x+=d.x*w;y+=d.y*w;total+=w;
        }
        if(!total)continue;
        const old=displacement.get(n.key),next={x:x/total,y:y/total};
        movement=Math.max(movement,Math.hypot(next.x-old.x,next.y-old.y));
        displacement.set(n.key,next);
      }
      if(movement<.0001)break;
    }
    for(const n of free) {
      const d=displacement.get(n.key);n.x=n.base.x+d.x;n.y=n.base.y+d.y;
    }
    const servicesByKey=new Map();
    for(const r of data.routes) {
      if(r.hidden) continue;
      const cls=classify(r),number=numericLine(r),label=String(r.name??r.routeName??'Unnamed');
      const key=cls+':'+(number??norm(label));
      const sequence=stops(r).map(nameOf).filter(k=>nodes.has(k)).filter((k,i,a)=>!i||k!==a[i-1]);
      if(sequence.length<2) continue;
      if(!servicesByKey.has(key)) servicesByKey.set(key,{key,class:cls,number,label:number===null?label:String(number),color:color(r.color??r.routeColor),variants:[],servedStops:new Set()});
      const svc=servicesByKey.get(key);svc.variants.push(sequence);
      for(const k of sequence) {svc.servedStops.add(k);nodes.get(k).services.add(key);}
    }
    const order={tram:0,bus:1,rail:2,high:3};
    const services=[...servicesByKey.values()].sort((a,b)=>order[a.class]-order[b.class]||(a.number??9999)-(b.number??9999)||a.label.localeCompare(b.label));
    // The small infrastructure graph is independent from route direction and stopping pattern.
    const graph=new Map();
    function link(a,b) {if(!graph.has(a))graph.set(a,new Set());graph.get(a).add(b);}
    for(const c of corridors) {
      for(let i=1;i<c.keys.length;i++) {link(c.keys[i-1],c.keys[i]);if(!c.oneWay)link(c.keys[i],c.keys[i-1]);}
      if(c.loop) {link(c.keys.at(-1),c.keys[0]);if(!c.oneWay)link(c.keys[0],c.keys.at(-1));}
    }
    function physicalPath(a,b) {
      // Prefer a common corridor explicitly (no shortcut across another road).
      for(const c of corridors) {
        const i=c.keys.indexOf(a),j=c.keys.indexOf(b);if(i<0||j<0)continue;
        if(c.loop&&c.oneWay) {const result=[a];let k=i;while(k!==j){k=(k+1)%c.keys.length;result.push(c.keys[k]);}return result;}
        if(!c.oneWay)return i<=j?c.keys.slice(i,j+1):c.keys.slice(j,i+1).reverse();
      }
      // Only route through the configured graph when both endpoints belong to it.
      if(!graph.has(a)||!graph.has(b))return [a,b];
      const costs=new Map([[a,0]]),prev=new Map(),pending=new Set(graph.keys());
      while(pending.size) {
        let u=null,best=Infinity;
        for(const k of pending) if((costs.get(k)??Infinity)<best){u=k;best=costs.get(k);}
        if(u===null)break;if(u===b){const path=[b];while(path[0]!==a)path.unshift(prev.get(path[0]));return path;}
        pending.delete(u);
        for(const v of graph.get(u)??[]) {const alt=best+distance(nodes.get(u),nodes.get(v));if(alt<(costs.get(v)??Infinity)){costs.set(v,alt);prev.set(v,u);}}
      }
      return [a,b];
    }
    const edges=new Map();
    for(const svc of services) for(const seq of svc.variants) for(let i=1;i<seq.length;i++) {
      const path=physicalPath(seq[i-1],seq[i]);
      for(let j=1;j<path.length;j++) {
        const from=path[j-1],to=path[j];if(from===to)continue;
        const key=edgeKey(from,to);
        if(!edges.has(key)) {
          const [a,b]=[from,to].sort();
          const c=corridors.find(c=>c.loop&&c.keys.includes(a)&&c.keys.includes(b));
          edges.set(key,{key,a,b,points:octilinear(nodes.get(a),nodes.get(b)),services:new Set(),directions:new Map(),loop:c?.id??null});
        }
        const edge=edges.get(key);edge.services.add(svc.key);
        if(!edge.directions.has(svc.key))edge.directions.set(svc.key,new Set());
        edge.directions.get(svc.key).add(from===edge.a?1:-1);
      }
    }
    return {nodes,services,edges,corridors,warnings,stationCount:raw.size,routeCount:data.routes.filter(r=>!r.hidden).length};
  }
  return {norm,numericLine,classify,color,unwrap,octilinear,build};
});
