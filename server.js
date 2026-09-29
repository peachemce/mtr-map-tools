const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = __dirname;
const DEFAULT_MTR_URL = 'http://127.0.0.1:8888/mtr/api/map/stations-and-routes?dimension=0';
const FILES = new Set(['index.html','app.js','map-model.js','styles.css','data/schematic.json']);
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
function createServer({mtrUrl=process.env.MTR_URL || DEFAULT_MTR_URL, timeout=5000}={}) {
  const upstreamURL = new URL(mtrUrl);
  if(!['http:','https:'].includes(upstreamURL.protocol)) throw new Error('MTR_URL must be HTTP or HTTPS');
  return http.createServer(async (req,res) => {
    const origin=req.headers.origin;
    if(origin && (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || origin==='https://peachemce.github.io')) {
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Private-Network','true');
    }
    if(req.method==='OPTIONS') {res.writeHead(204,{'Access-Control-Allow-Methods':'GET, OPTIONS'});res.end();return;}
    if(req.method!=='GET') {res.writeHead(405,{'Allow':'GET, OPTIONS'});res.end();return;}
    const pathname=new URL(req.url,'http://localhost').pathname;
    res.setHeader('Cache-Control','no-store');
    if(pathname==='/api/network') {
      try {
        const upstream=await fetch(upstreamURL,{signal:AbortSignal.timeout(timeout)});
        if(!upstream.ok) throw new Error('MTR HTTP '+upstream.status);
        const json=await upstream.json(),data=json?.data??json;
        if(!Array.isArray(data.stations)||!Array.isArray(data.routes)) throw new Error('Invalid stations-and-routes response');
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','X-Folityn-Source':'live'});
        res.end(JSON.stringify({data,receivedAt:new Date().toISOString(),source:'live'}));
      } catch(error) {
        res.writeHead(502,{'Content-Type':'application/json; charset=utf-8'});
        res.end(JSON.stringify({error:'Live MTR unavailable. Keep Minecraft and its web map running on port 8888.',detail:error.message}));
      }
      return;
    }
    const name=pathname==='/'?'index.html':pathname.slice(1);
    if(!FILES.has(name)) {res.writeHead(404);res.end('Not found');return;}
    fs.readFile(path.join(ROOT,name),(err,bytes)=>{
      if(err){res.writeHead(404);res.end('Not found');return;}
      res.writeHead(200,{'Content-Type':MIME[path.extname(name)]});res.end(bytes);
    });
  });
}
if(require.main===module) createServer().listen(Number(process.env.PORT||5173),'127.0.0.1',()=>console.log('Folityn Transit: http://127.0.0.1:'+(process.env.PORT||5173)));
module.exports={createServer};
