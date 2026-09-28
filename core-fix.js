// Folityn standalone renderer: consolidated core behavior.
// Loaded immediately after app.js and before its async network request completes.
(() => {
  const nrm = s => String(s ?? '').trim().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');

  // ---------- service identity ----------
  // Only genuinely numeric route names/numbers become numbered lines.
  routeNumber = function(r) {
    const direct = String(r?.number ?? '').trim();
    if (/^\d{1,3}$/.test(direct)) return Number(direct);
    const name = String(r?.name ?? r?.routeName ?? r?.route_name ?? '').trim();
    if (/^\d{1,3}$/.test(name)) return Number(name);
    const prefixed = name.match(/^(\d{1,3})\s*(?:[-–—:]\s*.+)$/);
    return prefixed ? Number(prefixed[1]) : null;
  };

  routeClass = function(r) {
    const t = nrm(r?.type), n = routeNumber(r);
    const name = String(r?.name ?? r?.routeName ?? r?.route_name ?? '').trim().toLowerCase();
    const light = t.includes('light_rail');
    if (light && Number.isFinite(n) && n >= 1 && n <= 20) return 'tram';
    if (light && Number.isFinite(n) && n >= 100) return 'bus';
    if (t.includes('high_speed') || /^ic(?:\b|\s|[-–—:])/.test(name)) return 'high';
    if (!light && (t.includes('train_normal') || t === 'rail' || t.includes('train'))) return 'rail';
    if (light) return 'bus';
    if (Number.isFinite(n) && n >= 100) return 'bus';
    if (Number.isFinite(n) && n >= 1 && n <= 20) return 'tram';
    return 'rail';
  };

  serviceKey = function(r) {
    const cls = routeClass(r), n = routeNumber(r);
    if ((cls === 'tram' || cls === 'bus') && Number.isFinite(n)) return `${cls}:${n}`;
    let name = String(r?.name ?? r?.routeName ?? r?.route_name ?? '').trim();
    name = name.replace(/\s+(?:to|towards?)\s+.+$/i,'').trim();
    return `${cls}:${nrm(name) || String(r?.id ?? 'unnamed')}`;
  };
  serviceLabel = function(r) {
    const n = routeNumber(r);
    return Number.isFinite(n) ? String(n) : String(r?.name ?? r?.routeName ?? r?.route_name ?? 'unnamed');
  };

  // Prefer the complete direction. Only reject it when it is a truly extreme detour.
  variantScore = function(seq,nodes) {
    if (!seq || seq.length < 2) return 1e12;
    let length = 0;
    for (let i=1;i<seq.length;i++) {
      const a=nodes.get(seq[i-1]), b=nodes.get(seq[i]);
      if (a&&b) length += Math.hypot(b.x-a.x,b.y-a.y);
    }
    const a=nodes.get(seq[0]), b=nodes.get(seq.at(-1));
    const direct=a&&b?Math.hypot(b.x-a.x,b.y-a.y):0;
    const detour=direct>1?length/direct:1;
    const extreme=detour>3.2 ? (detour-3.2)*100000 : 0;
    return extreme - seq.length*1000 + detour*10;
  };

  const baseBuildModel = buildModel;

  function findNode(model,names) {
    const wanted=names.map(nrm);
    for (const [key,n] of model.nodes) {
      const candidates=[key,n.label,...(n.rawNames||[])].map(nrm);
      if (candidates.some(c=>wanted.includes(c))) return key;
    }
    return null;
  }

  function resetToTrueGeography(model) {
    // app.js stores pre-schematic projected geography in n.geo.  Mirror that once to undo
    // the historical -x/-z projection, then make it authoritative again.
    const ns=[...model.nodes.values()].filter(n=>n.geo);
    if (!ns.length) return;
    const minX=Math.min(...ns.map(n=>n.geo.x)), maxX=Math.max(...ns.map(n=>n.geo.x));
    const minY=Math.min(...ns.map(n=>n.geo.y)), maxY=Math.max(...ns.map(n=>n.geo.y));
    const cx2=minX+maxX, cy2=minY+maxY;
    state.edits={};
    localStorage.removeItem(EDIT_KEY);
    for (const n of ns) {
      const x=cx2-n.geo.x, y=cy2-n.geo.y;
      n.x=x; n.y=y; n.geo={x,y}; n.lock=null;
    }
  }

  function rawProjection(p,a,v,v2) {
    return ((p.x-a.x)*v.x+(p.z-a.z)*v.y)/v2;
  }

  function lockEastInfrastructure(model) {
    const start=findNode(model,['Dworzec Wschodni','Dworzec Wschodni PKM']);
    const end=findNode(model,['Kraszewo/Nowa','Kraszewo Nowa']);
    if (!start || !end) return {id:'east45',active:false,start,end,members:[]};

    const A=model.nodes.get(start), B=model.nodes.get(end);
    const rawA=A.raw, rawB=B.raw;
    const rv={x:rawB.x-rawA.x,y:rawB.z-rawA.z};
    const r2=rv.x*rv.x+rv.y*rv.y || 1;
    const rawLen=Math.sqrt(r2);

    // Services touching either anchor describe the roads feeding the physical trunk.
    const relevant=new Set();
    for (const svc of model.services) {
      if ((svc.variants||[]).some(seq=>seq.includes(start)||seq.includes(end))) relevant.add(svc.key);
    }

    // Infrastructure membership is geography + connectivity, NOT "one route contains both ends".
    const memberSet=new Set([start,end]);
    const band=Math.max(260,rawLen*.10);
    for (const svc of model.services) {
      if (!relevant.has(svc.key)) continue;
      for (const seq of svc.variants||[]) for (const k of seq) {
        const n=model.nodes.get(k); if (!n?.raw) continue;
        const px=n.raw.x-rawA.x, py=n.raw.z-rawA.z;
        const t=(px*rv.x+py*rv.y)/r2;
        const perp=Math.abs(px*rv.y-py*rv.x)/rawLen;
        if (t>=-.06 && t<=1.06 && perp<=band) memberSet.add(k);
      }
    }

    let ordered=[...memberSet].sort((ka,kb)=>
      rawProjection(model.nodes.get(ka).raw,rawA,rv,r2)-rawProjection(model.nodes.get(kb).raw,rawA,rv,r2));
    ordered=ordered.filter((k,i,a)=>i===0||k!==a[i-1]);
    if (ordered[0]!==start) { ordered=ordered.filter(k=>k!==start); ordered.unshift(start); }
    if (ordered.at(-1)!==end) { ordered=ordered.filter(k=>k!==end); ordered.push(end); }

    // Minimal rotation onto an exact 45° while keeping the corridor centre and length stable.
    const mx=(A.x+B.x)/2, my=(A.y+B.y)/2;
    const L=Math.hypot(B.x-A.x,B.y-A.y)||400;
    const sx=B.x>=A.x?1:-1, sy=B.y>=A.y?1:-1;
    const hx=sx*L/(2*Math.SQRT2), hy=sy*L/(2*Math.SQRT2);
    const p0={x:mx-hx,y:my-hy}, p1={x:mx+hx,y:my+hy};

    const old=new Map(ordered.map(k=>[k,{x:model.nodes.get(k).x,y:model.nodes.get(k).y}]));
    ordered.forEach((k,i)=>{
      const n=model.nodes.get(k); if(!n) return;
      let t=Math.max(0,Math.min(1,rawProjection(n.raw,rawA,rv,r2)));
      if (ordered.length>2) t=.82*t+.18*(i/(ordered.length-1));
      n.x=p0.x+(p1.x-p0.x)*t;
      n.y=p0.y+(p1.y-p0.y)*t;
      n.lock='east45';
    });

    // Branches move with their attachment point for only two stops; the effect decays fast.
    const shifts=new Map(), weights=[0,.62,.25];
    for (const svc of model.services) for (const seq of svc.variants||[]) {
      for (let i=0;i<seq.length;i++) {
        const root=seq[i]; if(!memberSet.has(root)) continue;
        const before=old.get(root), now=model.nodes.get(root); if(!before||!now) continue;
        const dx=now.x-before.x, dy=now.y-before.y;
        for (const dir of [-1,1]) for (let d=1;d<=2;d++) {
          const j=i+dir*d; if(j<0||j>=seq.length) break;
          const k=seq[j]; if(memberSet.has(k)) break;
          const n=model.nodes.get(k); if(!n) continue;
          if(!shifts.has(k)) shifts.set(k,[]);
          shifts.get(k).push({x:dx*weights[d],y:dy*weights[d]});
        }
      }
    }
    for (const [k,list] of shifts) {
      const n=model.nodes.get(k); if(!n) continue;
      const xs=list.map(v=>v.x).sort((a,b)=>a-b), ys=list.map(v=>v.y).sort((a,b)=>a-b);
      n.x+=xs[Math.floor(xs.length/2)]||0; n.y+=ys[Math.floor(ys.length/2)]||0;
    }

    // Any route using >=2 points of this road inherits the SAME ordered corridor.
    for (const svc of model.services) {
      let chosen=null;
      for (const seq of svc.variants||[]) {
        const hits=seq.filter(k=>memberSet.has(k));
        if(hits.length>=2 && (!chosen || hits.length>chosen.hits.length || (hits.length===chosen.hits.length&&seq.length>chosen.seq.length))) {
          chosen={seq,hits};
        }
      }
      if(!chosen) continue;
      const firstHit=chosen.hits[0], lastHit=chosen.hits.at(-1);
      const oi=ordered.indexOf(firstHit), oj=ordered.indexOf(lastHit);
      if(oi<0||oj<0) continue;
      const trunk=oi<=oj?ordered.slice(oi,oj+1):ordered.slice(oj,oi+1).reverse();
      const seq=chosen.seq, si=seq.indexOf(firstHit), sj=seq.indexOf(lastHit);
      const lo=Math.min(si,sj), hi=Math.max(si,sj);
      const use=si<=sj?trunk:[...trunk].reverse();
      svc.path=[...seq.slice(0,lo),...use,...seq.slice(hi+1)].filter((k,i,a)=>i===0||k!==a[i-1]);
    }

    return {id:'east45',active:true,start,end,members:ordered};
  }

  buildModel = function(data) {
    const model=baseBuildModel(data);
    // Throw away every previous positional experiment; start from geography each load.
    resetToTrueGeography(model);
    const east=lockEastInfrastructure(model);
    model.locks=[east];
    rebuildEdges(model);
    return model;
  };

  // ---------- octilinear drawing ----------
  function octilinearPoints(x1,y1,x2,y2) {
    const dx=x2-x1,dy=y2-y1,ax=Math.abs(dx),ay=Math.abs(dy),sx=dx<0?-1:1,sy=dy<0?-1:1;
    if(ax<.5||ay<.5||Math.abs(ax-ay)<.5) return [[x1,y1],[x2,y2]];
    if(ax>ay) return [[x1,y1],[x1+sx*ay,y2],[x2,y2]];
    return [[x1,y1],[x2,y1+sy*ax],[x2,y2]];
  }
  function convertLine(line) {
    if(!(line instanceof SVGLineElement)||line.dataset.oct==='1') return;
    const x1=+line.getAttribute('x1'),y1=+line.getAttribute('y1'),x2=+line.getAttribute('x2'),y2=+line.getAttribute('y2');
    if(![x1,y1,x2,y2].every(Number.isFinite)) return;
    const p=document.createElementNS('http://www.w3.org/2000/svg','polyline');
    for(const a of line.getAttributeNames()) if(!['x1','y1','x2','y2'].includes(a)) p.setAttribute(a,line.getAttribute(a));
    p.setAttribute('points',octilinearPoints(x1,y1,x2,y2).map(v=>v.join(',')).join(' '));
    p.setAttribute('fill','none'); p.setAttribute('stroke-linejoin','round'); p.setAttribute('stroke-linecap','round'); p.dataset.oct='1';
    if(line.onclick) p.onclick=line.onclick;
    line.replaceWith(p);
  }
  const observer=new MutationObserver(ms=>{
    for(const m of ms) for(const n of m.addedNodes) if(n.nodeType===1) {
      if(n.matches?.('line.corridor-base,line.route-line')) convertLine(n);
      n.querySelectorAll?.('line.corridor-base,line.route-line').forEach(convertLine);
    }
  });
  const beginObserve=()=>{
    if(!corridorsLayer||!routesLayer) return setTimeout(beginObserve,20);
    observer.observe(corridorsLayer,{childList:true,subtree:true});
    observer.observe(routesLayer,{childList:true,subtree:true});
  };
  beginObserve();

  // ---------- labels ----------
  // Ordinary labels are hover-only. Hubs stay visible, but text stays the same SCREEN size while zooming.
  updateLabelVisibility = function() {
    if(!state.model) return;
    const inv=1/Math.max(.001,state.scale);
    labelsLayer.querySelectorAll('.station-label').forEach(t=>{
      const n=state.model.nodes.get(t.dataset.labelFor); if(!n){t.style.display='none';return;}
      const persistent=n.kind==='major-hub'||n.kind==='hub';
      t.style.display=persistent?'':'none';
      const x=Number(t.getAttribute('x'))||n.x, y=Number(t.getAttribute('y'))||n.y;
      t.setAttribute('transform',`translate(${x} ${y}) scale(${inv}) translate(${-x} ${-y})`);
    });
  };

  const getLabel=key=>[...labelsLayer.querySelectorAll('.station-label')].find(t=>t.dataset.labelFor===key);
  stationsLayer.addEventListener('pointerover',ev=>{
    const g=ev.target.closest?.('.station-group'); if(!g) return;
    const t=getLabel(g.dataset.key); if(!t) return;
    const n=state.model?.nodes.get(g.dataset.key); if(!n) return;
    const inv=1/Math.max(.001,state.scale),x=Number(t.getAttribute('x'))||n.x,y=Number(t.getAttribute('y'))||n.y;
    t.setAttribute('transform',`translate(${x} ${y}) scale(${inv}) translate(${-x} ${-y})`);
    t.style.display='';
  });
  stationsLayer.addEventListener('pointerout',ev=>{
    const g=ev.target.closest?.('.station-group'); if(!g) return;
    if(ev.relatedTarget?.closest?.('.station-group')===g) return;
    updateLabelVisibility();
  });

  // If app.js somehow finished before this file executed, rebuild once through the new model.
  if(state.network) {
    state.model=buildModel(state.network);
    render(); fit();
  }
})();
