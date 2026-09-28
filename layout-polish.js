// Folityn standalone map: master east corridor + compact label behaviour.
// This runs after the route identity patch but before the async network load normally finishes.
(() => {
  const nrm = s => String(s ?? '').trim().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');

  function nodeByNames(model, names) {
    const wanted = names.map(nrm);
    for (const [key,n] of model.nodes) {
      const candidates = [key,n.label,...(n.rawNames || [])].map(nrm);
      if (candidates.some(c => wanted.includes(c))) return key;
    }
    return null;
  }

  function exact45Pair(a,b) {
    const dx=b.x-a.x, dy=b.y-a.y;
    const d=Math.hypot(dx,dy) || 1;
    const sx=dx>=0?1:-1, sy=dy>=0?1:-1;
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
    const h=d/(2*Math.SQRT2);
    return {
      a:{x:mx-sx*h,y:my-sy*h},
      b:{x:mx+sx*h,y:my+sy*h},
    };
  }

  function median(vals){
    const a=[...vals].sort((x,y)=>x-y); if(!a.length) return 0;
    const m=a.length>>1; return a.length%2?a[m]:(a[m-1]+a[m])/2;
  }

  function forceMasterEast45(model) {
    const aKey=nodeByNames(model,['Dworzec Wschodni','Dworzec Wschodni PKM']);
    const bKey=nodeByNames(model,['Kraszewo/Nowa','Kraszewo Nowa']);
    if(!aKey || !bKey) {
      model.masterEast45={active:false,aKey,bKey,members:[]};
      return;
    }

    const A=model.nodes.get(aKey), B=model.nodes.get(bKey);
    const candidateSlices=[];
    for(const svc of model.services){
      const seqs=[...(svc.variants||[])];
      if(svc.path?.length) seqs.push(svc.path);
      for(const seq of seqs){
        const ia=seq.indexOf(aKey), ib=seq.indexOf(bKey);
        if(ia<0||ib<0||ia===ib) continue;
        let sub=seq.slice(Math.min(ia,ib),Math.max(ia,ib)+1);
        if(sub[0]!==aKey) sub=[...sub].reverse();
        if(sub.length>=2) candidateSlices.push({svc,sub});
      }
    }

    // Pick the simplest direct service between the anchors as the infrastructure backbone.
    candidateSlices.sort((x,y)=>x.sub.length-y.sub.length);
    const reference=candidateSlices[0]?.sub || [aKey,bKey];
    const members=[...new Set(reference)];
    const memberSet=new Set(members);

    // Preserve the real relation of the two ends, but rotate the pair minimally onto an exact 45°.
    const old=new Map();
    for(const k of members){
      const n=model.nodes.get(k); if(n) old.set(k,{x:n.x,y:n.y});
    }
    if(!old.has(aKey)) old.set(aKey,{x:A.x,y:A.y});
    if(!old.has(bKey)) old.set(bKey,{x:B.x,y:B.y});

    const target=exact45Pair(A,B);
    const rawA=A.raw || {x:A.x,z:A.y}, rawB=B.raw || {x:B.x,z:B.y};
    const rvx=(rawB.x-rawA.x), rvy=(rawB.z-rawA.z), r2=rvx*rvx+rvy*rvy || 1;
    const projection=k=>{
      const n=model.nodes.get(k), p=n?.raw;
      if(!p) return members.indexOf(k)/Math.max(1,members.length-1);
      return Math.max(0,Math.min(1,((p.x-rawA.x)*rvx+(p.z-rawA.z)*rvy)/r2));
    };

    // Keep order monotonic even if Minecraft geography wiggles locally.
    const ordered=[...members].sort((ka,kb)=>projection(ka)-projection(kb));
    if(ordered[0]!==aKey){ const i=ordered.indexOf(aKey); if(i>=0) ordered.splice(i,1); ordered.unshift(aKey); }
    if(ordered.at(-1)!==bKey){ const i=ordered.indexOf(bKey); if(i>=0) ordered.splice(i,1); ordered.push(bKey); }

    ordered.forEach((k,i)=>{
      const n=model.nodes.get(k); if(!n) return;
      let t=projection(k);
      // If projection bunches several stops together, keep a minimum schematic ordering.
      if(ordered.length>2){
        const idxT=i/(ordered.length-1);
        t=.72*t+.28*idxT;
      }
      n.x=target.a.x+(target.b.x-target.a.x)*t;
      n.y=target.a.y+(target.b.y-target.a.y)*t;
      n.lock='master-east-45';
    });

    // Move the first few stops of branches with their attachment point, with decaying strength.
    const shifts=new Map();
    const weights=[0,.78,.46,.22];
    for(const svc of model.services){
      const paths=[svc.path,...(svc.variants||[])].filter(Boolean);
      for(const path of paths){
        for(let i=0;i<path.length;i++){
          const root=path[i]; if(!memberSet.has(root)) continue;
          const before=old.get(root), now=model.nodes.get(root); if(!before||!now) continue;
          const dx=now.x-before.x, dy=now.y-before.y;
          for(const dir of [-1,1]) for(let d=1;d<=3;d++){
            const j=i+dir*d; if(j<0||j>=path.length) break;
            const k=path[j]; if(memberSet.has(k)) break;
            const n=model.nodes.get(k); if(!n || state.edits[k]) continue;
            const w=weights[d];
            if(!shifts.has(k)) shifts.set(k,[]);
            shifts.get(k).push({x:dx*w,y:dy*w});
          }
        }
      }
    }
    for(const [k,list] of shifts){
      const n=model.nodes.get(k); if(!n) continue;
      n.x+=median(list.map(v=>v.x));
      n.y+=median(list.map(v=>v.y));
    }

    // Any service which really traverses both anchors inherits this same corridor.
    for(const svc of model.services){
      const containing=(svc.variants||[]).filter(seq=>seq.includes(aKey)&&seq.includes(bKey));
      if(!containing.length) continue;
      // Prefer the most complete direction now that route identities are safe.
      containing.sort((x,y)=>y.length-x.length);
      const base=containing[0];
      const ia=base.indexOf(aKey), ib=base.indexOf(bKey);
      const before=base.slice(0,Math.min(ia,ib));
      const after=base.slice(Math.max(ia,ib)+1);
      const trunk=ia<=ib?ordered:[...ordered].reverse();
      svc.path=[...before,...trunk,...after].filter((k,i,a)=>i===0||k!==a[i-1]);
    }

    rebuildEdges(model);
    model.masterEast45={active:true,aKey,bKey,members:ordered};
  }

  const previousBuild=buildModel;
  buildModel=function(data){
    const model=previousBuild(data);
    forceMasterEast45(model);
    return model;
  };

  // At normal map scale, show only the few labels that actually help orientation.
  updateLabelVisibility=function(){
    const showAll=state.scale>2.35;
    labelsLayer.querySelectorAll('.station-label').forEach(t=>{
      const n=state.model?.nodes.get(t.dataset.labelFor);
      if(!n){ t.style.display='none'; return; }
      const count=[...n.services].map(k=>state.model.services.find(s=>s.key===k)).filter(s=>s&&visibleService(s)).length;
      const persistent=n.kind==='major-hub'||n.kind==='hub'||count>=5;
      t.style.display=(showAll||persistent)?'':'none';
    });
  };

  // Hovering a stop temporarily reveals its label regardless of zoom.
  function labelForKey(key){
    return [...labelsLayer.querySelectorAll('.station-label')].find(t=>t.dataset.labelFor===key);
  }
  stationsLayer.addEventListener('pointerover',ev=>{
    const g=ev.target.closest?.('.station-group'); if(!g) return;
    const t=labelForKey(g.dataset.key); if(t) t.style.display='';
  });
  stationsLayer.addEventListener('pointerout',ev=>{
    const g=ev.target.closest?.('.station-group'); if(!g) return;
    const next=ev.relatedTarget?.closest?.('.station-group');
    if(next===g) return;
    updateLabelVisibility();
  });

  // If the model happened to finish loading before this file ran, patch it immediately.
  if(state.model){
    forceMasterEast45(state.model);
    render(); fit();
  }
})();
