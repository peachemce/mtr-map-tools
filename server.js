const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5173);
const MTR_URL = process.env.MTR_URL || 'http://127.0.0.1:8888/mtr/api/map/stations-and-routes?dimension=0';
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};

function sendFile(res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store'});
    fs.createReadStream(file).pipe(res);
  });
}

async function network(res) {
  try {
    const upstream = await fetch(MTR_URL, {signal: AbortSignal.timeout(2500)});
    if (!upstream.ok) throw new Error(`MTR HTTP ${upstream.status}`);
    const text = await upstream.text();
    JSON.parse(text);
    res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Folityn-Source':'live'});
    res.end(text);
  } catch (error) {
    const fallback = path.join(ROOT, 'data', 'network.json');
    fs.readFile(fallback, 'utf8', (err, text) => {
      if (err) { res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:String(error)})); return; }
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Folityn-Source':'snapshot'});
      res.end(text);
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/network') return network(res);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  sendFile(res, file);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Folityn map: http://127.0.0.1:${PORT}`));
