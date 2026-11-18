// 实时轨迹图本地服务（端口 8947）：
//   /            → 实时轨迹网页
//   /bg-road.png → 真实地图背景
//   /api/meta    → 底图墨卡托参数
//   /api/track   → formal-run.track.json（auto-run 生成的轨迹）
//   /api/status  → formal-run.status.json（实时进度）
// 40 分钟无访问自动退出
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE); // happyrun/
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
let lastHit = Date.now();
setInterval(() => { if (Date.now() - lastHit > 40 * 60 * 1000) process.exit(0); }, 60 * 1000);

http.createServer((req, res) => {
  lastHit = Date.now();
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  res.setHeader('Cache-Control', 'no-store');
  const sendJSON = (obj) => { res.writeHead(200, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify(obj)); };
  try {
    if (p === '/' || p === '/live.html') {
      const c = fs.readFileSync(path.join(HERE, 'live.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(c);
    }
    if (p === '/bg-road.png') {
      const c = fs.readFileSync(path.join(HERE, 'editor', 'bg-road.png'));
      res.writeHead(200, { 'Content-Type': MIME['.png'] });
      return res.end(c);
    }
    if (p === '/api/meta') return sendJSON(JSON.parse(fs.readFileSync(path.join(HERE, 'editor', 'meta.json'), 'utf8')));
    if (p === '/api/track') {
      const f = path.join(ROOT, 'formal-run.track.json');
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('{}'); }
      return sendJSON(JSON.parse(fs.readFileSync(f, 'utf8')));
    }
    if (p === '/api/status') {
      const f = path.join(ROOT, 'formal-run.status.json');
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('{}'); }
      return sendJSON(JSON.parse(fs.readFileSync(f, 'utf8')));
    }
    res.writeHead(404); res.end('404');
  } catch (e) { res.writeHead(500); res.end(String(e.message)); }
}).listen(8947, '127.0.0.1', () => console.log('live: http://127.0.0.1:8947/'));
