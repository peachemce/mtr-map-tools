const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createServer}=require('../server.js');
async function listen(s){await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+s.address().port;}
async function close(s){s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}
test('proxy reads changing live data and returns an error instead of snapshots',async()=>{
 let count=1,fail=false;const upstream=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(fail?'{}':JSON.stringify({data:{stations:[{id:String(count++)}],routes:[]}}));});const source=await listen(upstream);const server=createServer({mtrUrl:source}),base=await listen(server);
 try{const a=await fetch(base+'/api/network'),b=await fetch(base+'/api/network');assert.equal(a.headers.get('x-folityn-source'),'live');assert.notEqual((await a.json()).data.stations[0].id,(await b.json()).data.stations[0].id);fail=true;const r=await fetch(base+'/api/network');assert.equal(r.status,502);assert.ok((await r.json()).error.includes('Live MTR unavailable'));}finally{await close(server);await close(upstream);}
});
test('only app assets are exposed, with narrow local and Pages CORS',async()=>{
 const server=createServer(),base=await listen(server);try{for(const file of ['/server.js','/data/network.json','/.git/config','/%2e%2e/package.json'])assert.equal((await fetch(base+file)).status,404);assert.equal((await fetch(base+'/')).status,200);const good=await fetch(base+'/',{headers:{Origin:'https://peachemce.github.io'}});assert.equal(good.headers.get('access-control-allow-origin'),'https://peachemce.github.io');const bad=await fetch(base+'/',{headers:{Origin:'https://example.com'}});assert.equal(bad.headers.get('access-control-allow-origin'),null);}finally{await close(server);}
});
test('upstream timeout produces 502',async()=>{
 const upstream=http.createServer(()=>{}),url=await listen(upstream),server=createServer({mtrUrl:url,timeout:50}),base=await listen(server);try{assert.equal((await fetch(base+'/api/network')).status,502);}finally{await close(server);await close(upstream);}
});
