// ==UserScript==
// @name         MTR Map Tools - Tram / Bus Light Rail Filters
// @namespace    https://github.com/peachemce/mtr-map-tools
// @version      11.0.0
// @description  Adds Tram (1-20) and Bus (100+) sub-filters on top of MTR's native Light Rail category.
// @match        http://localhost:8888/*
// @match        http://127.0.0.1:8888/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @updateURL    https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// @downloadURL  https://raw.githubusercontent.com/peachemce/mtr-map-tools/main/connector-reroll.user.js
// ==/UserScript==
(() => {
'use strict';

const TARGET=/\/mtr\/api\/map\/stations-and-routes(?:\?|$)/;
const KEY='folityn-light-rail-split-';
const tramsOn=()=>localStorage.getItem(KEY+'trams')!=='0';
const busesOn=()=>localStorage.getItem(KEY+'buses')!=='0';
const norm=s=>String(s??'').trim().toLowerCase().replace(/[\s-]+/g,'_');
const routeType=r=>norm(r?.type);
const isLightRail=r=>{
  const t=routeType(r);
  return t==='train_light_rail'||t==='light_rail'||t.includes('light_rail');
};
const routeNumber=r=>{
  const raw=String(r?.name??r?.routeName??r?.route_name??'').trim();
  const m=raw.match(/\d+/);
  return m?Number(m[0]):null;
};
const classOf=r=>{
  if(!isLightRail(r)) return null;
  const n=routeNumber(r);
  if(Number.isFinite(n)&&n>=1&&n<=20) return 'tram';
  if(Number.isFinite(n)&&n>=100) return 'bus';
  return 'other';
};

function filterEnvelope(env){
  if(!env||typeof env!=='object') return env;
  const src=env.data&&typeof env.data==='object'?env.data:env;
  if(!Array.isArray(src.routes)) return env;
  const out=typeof structuredClone==='function'?structuredClone(env):JSON.parse(JSON.stringify(env));
  const data=out.data&&typeof out.data==='object'?out.data:out;
  const before=data.routes.length;
  data.routes=data.routes.filter(r=>{
    const c=classOf(r);
    if(c==='tram') return tramsOn();
    if(c==='bus') return busesOn();
    return true;
  });
  window.__folitynLightRailFilterDebug={
    before,
    after:data.routes.length,
    trams:tramsOn(),
    buses:busesOn()
  };
  return out;
}

const transformText=text=>{
  try{return JSON.stringify(filterEnvelope(JSON.parse(text)))}
  catch(e){console.warn('[Folityn light rail filters] transform failed',e);return text}
};

const nativeFetch=window.fetch.bind(window);
window.fetch=async function(input,init){
  const url=typeof input==='string'?input:input?.url||'';
  const response=await nativeFetch(input,init);
  if(!TARGET.test(url)) return response;
  try{
    const text=await response.clone().text();
    return new Response(transformText(text),{
      status:response.status,
      statusText:response.statusText,
      headers:response.headers
    });
  }catch(e){
    console.warn('[Folityn light rail filters] fetch hook failed',e);
    return response;
  }
};

try{
  const proto=XMLHttpRequest.prototype;
  const nativeOpen=proto.open;
  const textGetter=Object.getOwnPropertyDescriptor(proto,'responseText')?.get;
  const responseGetter=Object.getOwnPropertyDescriptor(proto,'response')?.get;
  const cache=new WeakMap();

  proto.open=function(method,url,...rest){
    this.__folitynLRFilter=TARGET.test(String(url));
    cache.delete(this);
    return nativeOpen.call(this,method,url,...rest);
  };

  if(textGetter){
    Object.defineProperty(proto,'responseText',{
      configurable:true,
      get(){
        const raw=textGetter.call(this);
        if(!this.__folitynLRFilter||this.readyState!==4||typeof raw!=='string') return raw;
        let item=cache.get(this);
        if(!item){item={text:transformText(raw)};cache.set(this,item)}
        return item.text;
      }
    });
  }

  if(responseGetter){
    Object.defineProperty(proto,'response',{
      configurable:true,
      get(){
        const raw=responseGetter.call(this);
        if(!this.__folitynLRFilter||this.readyState!==4) return raw;
        let item=cache.get(this)||{};
        if(this.responseType==='json'&&raw&&typeof raw==='object'){
          if(!item.json){item.json=filterEnvelope(raw);cache.set(this,item)}
          return item.json;
        }
        if((this.responseType===''||this.responseType==='text')&&typeof raw==='string'){
          if(!item.text){item.text=transformText(raw);cache.set(this,item)}
          return item.text;
        }
        return raw;
      }
    });
  }
}catch(e){
  console.warn('[Folityn light rail filters] XHR hook failed',e);
}

function setFilter(which,on){
  localStorage.setItem(KEY+which,on?'1':'0');
  location.reload();
}

function makeToggle(label,kind,icon){
  const on=kind==='trams'?tramsOn():busesOn();
  const b=document.createElement('button');
  b.type='button';
  b.className='folityn-lr-toggle'+(on?' is-on':' is-off');
  b.dataset.kind=kind;
  b.innerHTML=`<span class="folityn-lr-icon">${icon}</span><span>${label}</span><span class="folityn-lr-state">${on?'ON':'OFF'}</span>`;
  b.addEventListener('click',()=>setFilter(kind,!on));
  return b;
}

function buildControls(){
  const box=document.createElement('div');
  box.id='folityn-lr-filters';
  const title=document.createElement('div');
  title.className='folityn-lr-title';
  title.textContent='Light Rail';
  box.append(title,makeToggle('Trams 1–20','trams','🚋'),makeToggle('Buses 100+','buses','🚌'));
  return box;
}

function findLightRailAnchor(){
  const all=[...document.querySelectorAll('app-map *, app-root *, body *')];
  const exact=all.find(el=>el.children.length<=2&&el.textContent?.trim()==='Light Rail');
  if(!exact) return null;
  let row=exact;
  for(let i=0;i<5&&row.parentElement;i++){
    const p=row.parentElement;
    const txt=p.textContent?.trim()||'';
    if(txt.includes('Light Rail')&&txt.length<120) row=p;
    else break;
  }
  return row;
}

function mountControls(){
  if(!document.body) return setTimeout(mountControls,50);
  if(document.getElementById('folityn-lr-filters')) return;

  const style=document.createElement('style');
  style.id='folityn-lr-filter-style';
  style.textContent=`
#folityn-lr-filters{box-sizing:border-box;font:13px/1.2 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#334155;background:#fff;border:1px solid #dbe3ee;border-radius:9px;padding:8px;display:grid;gap:6px;min-width:190px;box-shadow:0 4px 16px #00000014}
.folityn-lr-title{font-weight:700;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;padding:0 2px 2px}
.folityn-lr-toggle{appearance:none;border:1px solid #dbe3ee;background:#f8fafc;color:#334155;border-radius:7px;padding:7px 8px;display:grid;grid-template-columns:22px 1fr auto;align-items:center;gap:6px;text-align:left;cursor:pointer;font:inherit}
.folityn-lr-toggle:hover{background:#eef4fa}.folityn-lr-toggle.is-off{opacity:.58}.folityn-lr-toggle.is-on{border-color:#b9c9dc;background:#f3f7fb}.folityn-lr-icon{font-size:15px}.folityn-lr-state{font-size:10px;font-weight:800;letter-spacing:.04em;color:#64748b}
@media (prefers-color-scheme:dark){#folityn-lr-filters{background:#101827;color:#e5edf7;border-color:#334155;box-shadow:0 4px 18px #0008}.folityn-lr-title{color:#94a3b8}.folityn-lr-toggle{background:#162033;color:#e5edf7;border-color:#334155}.folityn-lr-toggle:hover{background:#1d2a40}.folityn-lr-toggle.is-on{background:#1a263a;border-color:#52657e}.folityn-lr-state{color:#94a3b8}}
#folityn-lr-filters.folityn-lr-floating{position:fixed;right:18px;top:245px;z-index:2147483646}
`;
  document.head.appendChild(style);

  const box=buildControls();
  const anchor=findLightRailAnchor();
  if(anchor&&anchor.parentElement){
    box.style.margin='6px 0 8px 28px';
    anchor.insertAdjacentElement('afterend',box);
  }else{
    box.classList.add('folityn-lr-floating');
    document.body.appendChild(box);
  }
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountControls,{once:true});
else mountControls();

new MutationObserver(()=>{
  if(!document.getElementById('folityn-lr-filters')) mountControls();
}).observe(document.documentElement,{childList:true,subtree:true});
})();
