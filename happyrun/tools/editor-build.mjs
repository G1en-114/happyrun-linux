// 路网编辑器构建器：
//   1. 拉取更大范围的高德卫星图 + 道路图（z18，墨卡托，与 App 坐标系同帧 GCJ-02）
//   2. 输出 bg-sat.png / bg-road.png + meta.json
//   3. 生成 路网编辑器.html（自包含：底图文件相对路径引用 + 内嵌路网数据）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const jpeg = require(path.join(path.dirname(fileURLToPath(import.meta.url)), 'refine-deps', 'node_modules', 'jpeg-js'));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(HERE, 'editor');
fs.mkdirSync(OUTDIR, { recursive: true });
const net = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'roadnet.json'), 'utf8'));

// ── GCJ⇄WGS（仅用于 OSM 数据参考层，不动主数据）──
const PI = Math.PI;
const tLat = (x, y) => {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return r;
};
const tLon = (x, y) => {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return r;
};
function wgs2gcj(lat, lon) {
  const a = 6378245, ee = 0.00669342162296594323;
  let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35);
  const radLat = lat / 180 * PI;
  let magic = Math.sin(radLat); magic = 1 - ee * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180) / ((a * (1 - ee)) / (magic * sq) * PI);
  dLon = (dLon * 180) / (a / sq * Math.cos(radLat) * PI);
  return [lat + dLat, lon + dLon];
}

const TILE = 256;
const lngToPx = (lng, z) => ((lng + 180) / 360) * (1 << z) * TILE;
const latToPx = (lat, z) => { const s = Math.sin(lat * PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * PI)) * (1 << z) * TILE; };

// ── 范围：覆盖整个校区 + 南河 + 西河 + 全部路网节点 + 余量 ──
let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
for (const [lon, lat] of net.nodes) {
  minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
  minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
}
const box = {
  minLat: Math.min(37.7428, minLat - 0.0018),
  maxLat: Math.max(37.7566, maxLat + 0.0018),
  minLon: Math.min(112.7128, minLon - 0.0022),
  maxLon: Math.max(112.7292, maxLon + 0.0022),
};
console.log('编辑器底图范围:', JSON.stringify(box));

async function fetchTile(z, x, y, style) {
  const sub = ((x + y) % 4) + 1;
  const host = style === 6 ? `webst0${sub}.is.autonavi.com` : `webrd0${sub}.is.autonavi.com`;
  const url = `https://${host}/appmaptile?lang=zh_cn&size=1&scale=1&style=${style}&x=${x}&y=${y}&z=${z}`;
  for (let att = 0; att < 4; att++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', Referer: 'https://www.amap.com/' } });
      if (res.status === 403 || res.status === 429) { await new Promise((r) => setTimeout(r, 500 * (att + 1))); continue; }
      if (!res.ok) throw new Error(String(res.status));
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (att === 3) throw new Error(`tile ${x},${y}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 400 * (att + 1)));
    }
  }
}
// 调色板 PNG 解码（复用 refine-basemap 的实现）
function decodePng(buf) {
  const u32 = (o) => buf.readUInt32BE(o);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8, W = 0, H = 0, bitDepth = 0, colorType = 0, idat = [], plte = null, trns = null;
  while (pos < buf.length) {
    const len = u32(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      W = u32(pos + 8); H = u32(pos + 12); bitDepth = buf[pos + 16]; colorType = buf[pos + 17];
      if (buf[pos + 20] !== 0) throw new Error('interlace');
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : (colorType === 0 || colorType === 3) ? 1 : colorType === 4 ? 2 : -1;
  if (ch < 0 || ![1, 2, 4, 8].includes(bitDepth)) throw new Error(`ct${colorType}/bd${bitDepth}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPx = ch === 1 && colorType === 3 ? bitDepth : bitDepth * ch;
  const stride = Math.ceil(W * bitsPerPx / 8);
  const out = new Uint8Array(W * H * 4);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < H; y++) {
    const ft = raw[rp++];
    cur.set(raw.subarray(rp, rp + stride)); rp += stride;
    for (let x = 0; x < stride; x++) {
      const bpx = Math.max(1, Math.floor(bitsPerPx / 8));
      const a = x >= bpx ? cur[x - bpx] : 0, b = prev[x], c = x >= bpx ? prev[x - bpx] : 0, v = cur[x];
      if (ft === 1) cur[x] = (v + a) & 255;
      else if (ft === 2) cur[x] = (v + b) & 255;
      else if (ft === 3) cur[x] = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        cur[x] = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    prev.set(cur);
    for (let x = 0; x < W; x++) {
      const di = (y * W + x) * 4;
      if (colorType === 3) {
        let idx;
        if (bitDepth === 8) idx = cur[x];
        else {
          const perByte = 8 / bitDepth;
          idx = (cur[(x / perByte) | 0] >> (8 - bitDepth * ((x % perByte) + 1))) & ((1 << bitDepth) - 1);
        }
        const po = idx * 3;
        out[di] = plte[po]; out[di + 1] = plte[po + 1]; out[di + 2] = plte[po + 2]; out[di + 3] = 255;
      } else if (ch === 1) { out[di] = out[di + 1] = out[di + 2] = cur[x]; out[di + 3] = 255; }
      else { const si = x * ch; out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = 255; }
    }
  }
  return { w: W, h: H, data: out };
}

async function stitch(style) {
  const z = 18;
  const x0 = Math.floor(lngToPx(box.minLon, z) / TILE), x1 = Math.floor(lngToPx(box.maxLon, z) / TILE);
  const y0 = Math.floor(latToPx(box.maxLat, z) / TILE), y1 = Math.floor(latToPx(box.minLat, z) / TILE);
  const W = (x1 - x0 + 1) * TILE, H = (y1 - y0 + 1) * TILE;
  console.log(`style${style}: ${(x1 - x0 + 1)}x${(y1 - y0 + 1)} = ${(x1 - x0 + 1) * (y1 - y0 + 1)} 张 (${W}x${H})`);
  const img = new Uint8Array(W * H * 3);
  let done = 0, failed = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      try {
        let rgba;
        const buf = await fetchTile(z, tx, ty, style);
        if (buf[0] === 0x89) rgba = decodePng(buf);
        else rgba = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
        const ox = (tx - x0) * TILE, oy = (ty - y0) * TILE;
        for (let py = 0; py < TILE; py++) for (let pxi = 0; pxi < TILE; pxi++) {
          const si = (py * TILE + pxi) * 4, di = ((oy + py) * W + ox + pxi) * 3;
          img[di] = rgba.data[si]; img[di + 1] = rgba.data[si + 1]; img[di + 2] = rgba.data[si + 2];
        }
      } catch (e) { failed++; if (failed <= 3) console.log('  失败:', e.message); }
      done++;
      if (done % 30 === 0) console.log(`  ${done}...`);
      if (done % 4 === 0) await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (failed) console.log(`  失败共 ${failed}`);
  return { img, W, H };
}

function writePng(file, img, W, H) {
  const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
  const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
  console.log('已写出', file, `${W}x${H} (${(fs.statSync(file).size / 1e6).toFixed(1)}MB)`);
}

let sat, road;
if (process.argv.includes('--refetch') || !fs.existsSync(path.join(OUTDIR, 'bg-sat.png')) || !fs.existsSync(path.join(OUTDIR, 'bg-road.png')) || !fs.existsSync(path.join(OUTDIR, 'meta.json'))) {
  sat = await stitch(6);
  writePng(path.join(OUTDIR, 'bg-sat.png'), sat.img, sat.W, sat.H);
  road = await stitch(8);
  writePng(path.join(OUTDIR, 'bg-road.png'), road.img, road.W, road.H);
} else {
  console.log('底图已存在，跳过抓取（--refetch 强制重抓）');
  sat = { W: 0, H: 0 };
}
const meta0 = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'meta.json'), 'utf8'));
const meta = {
  z: 18, box,
  W: sat.W || meta0.W, H: sat.H || meta0.H,
  x0w: Math.floor(lngToPx(box.minLon, 18) / TILE) * TILE,
  y0w: Math.floor(latToPx(box.maxLat, 18) / TILE) * TILE,
};
fs.writeFileSync(path.join(OUTDIR, 'meta.json'), JSON.stringify(meta, null, 1));

// ── 生成 editor.html ──
const DATA = {
  meta,
  nodes: net.nodes,
  edges: net.edges,
  vena: net.venaPoints || [],
  water: net.waterZones || [],
  bldg: net.forbiddenZones || [],
  corners: net.corners || null,
};
const tpl = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>明向校区路网编辑器（高德卫星 z18，与 App 坐标 1:1）</title>
<style>
 html,body{margin:0;height:100%;overflow:hidden;font:13px/1.5 "Microsoft YaHei",sans-serif;background:#111}
 #bar{position:fixed;top:0;left:0;right:0;height:46px;background:#1b2430;color:#dfe7f0;display:flex;align-items:center;gap:6px;padding:0 10px;box-shadow:0 1px 6px #0009;z-index:10;flex-wrap:wrap}
 #bar button{background:#2c3a4d;color:#dfe7f0;border:1px solid #46586e;border-radius:4px;padding:4px 10px;cursor:pointer}
 #bar button.on{background:#e8a33d;color:#222;border-color:#e8a33d;font-weight:bold}
 #bar button:hover{filter:brightness(1.15)}
 #bar .sep{width:1px;height:24px;background:#46586e;margin:0 4px}
 #info{position:fixed;bottom:0;left:0;right:0;height:30px;background:#1b2430cc;color:#9fb4c8;padding:4px 10px;font-size:12px;z-index:10}
 #hint{position:fixed;top:52px;left:10px;background:#1b2430cc;color:#cfe3f5;padding:8px 12px;border-radius:6px;font-size:12px;max-width:430px;z-index:10}
 canvas{display:block}
</style></head><body>
<div id="bar">
 <button data-m="pan" class="on">平移/缩放</button>
 <button data-m="move">移动节点</button>
 <button data-m="add">加点/连线</button>
 <button data-m="del">删除</button>
 <span class="sep"></span>
 <button data-m="water">水域多边形</button>
 <button data-m="bldg">建筑多边形</button>
 <button id="newZone">新建多边形</button>
 <span class="sep"></span>
 <label><input type="checkbox" id="lySat" checked>卫星图</label>
 <label><input type="checkbox" id="lyRoad">道路图</label>
 <label><input type="checkbox" id="lyWater" checked>水域</label>
 <label><input type="checkbox" id="lyBldg" checked>建筑</label>
 <label><input type="checkbox" id="lyVena" checked>打卡点</label>
 <span class="sep"></span>
 <button id="undo">撤销(Ctrl+Z)</button>
 <button id="reset">恢复初始</button>
 <button id="save" style="background:#2e8b57;border-color:#2e8b57;font-weight:bold">导出 roadnet.json</button>
</div>
<div id="hint"></div>
<div id="info"></div>
<canvas id="cv"></canvas>
<script>
const META = __META__;
const DATA = __DATA__;
const satImg = new Image(); satImg.src = 'bg-sat.png';
const roadImg = new Image(); roadImg.src = 'bg-road.png';
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
let W = 0, H = 0;
function resize(){ W = cv.width = innerWidth; H = cv.height = innerHeight;
  if(!zoomInit && W>0){ zoom = Math.min(W/META.W, H/META.H)*0.96; zoomInit = true; }
  draw(); }
addEventListener('resize', resize);

// ── 世界坐标 = z18 墨卡托像素（与底图像素严格 1:1）──
const TILE=256, PI=Math.PI;
const lngToPx = (lng,z)=>((lng+180)/360)*(1<<z)*TILE;
const latToPx = (lat,z)=>{const s=Math.sin(lat*PI/180);return (0.5-Math.log((1+s)/(1-s))/(4*PI))*(1<<z)*TILE;};
const pxToLng = (px,z)=>px/((1<<z)*TILE)*360-180;
const pxToLat = (py,z)=>{const n=PI-2*PI*py/((1<<z)*TILE);return 180/PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n)));};
const world = (lat,lon)=>[lngToPx(lon,18)-META.x0w, latToPx(lat,18)-META.y0w];   // 世界像素（相对底图左上）
const unworld = (wx,wy)=>[pxToLat(wy+META.y0w,18), pxToLng(wx+META.x0w,18)];

let cam = {x: META.W/2, y: META.H/2}, zoom = 0, MINZ = 0.05, MAXZ = 8, zoomInit = false;
const s2w = (sx,sy)=>[(sx-W/2)/zoom+cam.x,(sy-H/2)/zoom+cam.y];
const w2s = (wx,wy)=>[(wx-cam.x)*zoom+W/2,(wy-cam.y)*zoom+H/2];

// ── 数据 ──
const state = {
  nodes: DATA.nodes.map(n=>n.slice()),
  edges: DATA.edges.map(e=>e.slice()),
  vena: DATA.vena.map(v=>({...v})),
  water: DATA.water.map(r=>r.map(p=>p.slice())),
  bldg: DATA.bldg.map(r=>r.map(p=>p.slice())),
};
const INITIAL = JSON.stringify(state);
let mode = 'pan', linkFrom = -1, zoneDraft = null, zoneKind = null;
let undoStack = [];
const LS_KEY = 'roadnet-editor-autosave';
function persist(){ try { localStorage.setItem(LS_KEY, JSON.stringify({ t: Date.now(), state, undo: undoStack.slice(-30) })); } catch(e){} }
function snapshot(){ undoStack.push(JSON.stringify(state)); if (undoStack.length>60) undoStack.shift(); persist(); }
function undo(){ if(!undoStack.length) return; const s = JSON.parse(undoStack.pop()); Object.assign(state, s); persist(); draw(); setStatus('已撤销'); }
// ── 意外关闭恢复：检测上次自动保存 ──
(function(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || !saved.state || !saved.state.nodes) return;
    const when = new Date(saved.t).toLocaleString('zh-CN');
    const changed = JSON.stringify(saved.state) !== INITIAL;
    if (!changed) return;
    const bar = document.getElementById('hint');
    bar.innerHTML = '检测到上次未导出的编辑（自动保存于 ' + when + '，节点 ' + saved.state.nodes.length + '）　' +
      '<button id="rcv" style="background:#2e8b57;color:#fff;border:0;border-radius:4px;padding:3px 12px;cursor:pointer;font-weight:bold">一键恢复</button>　' +
      '<button id="drp" style="background:#555;color:#ddd;border:0;border-radius:4px;padding:3px 12px;cursor:pointer">丢弃</button>';
    bar.style.background = '#3a2b12'; bar.style.border = '1px solid #e8a33d';
    document.getElementById('rcv').addEventListener('click', () => {
      Object.assign(state, saved.state);
      undoStack = (saved.undo || []).slice();
      persist(); bar.innerHTML = '已恢复上次编辑（' + when + '）。记得改完点「导出 roadnet.json」。';
      draw();
    });
    document.getElementById('drp').addEventListener('click', () => {
      localStorage.removeItem(LS_KEY); bar.innerHTML = '已丢弃上次自动保存。';
    });
  } catch(e) {}
})();

// ── 命中测试 ──
function hitNode(sx,sy){ const r = 9; let best=-1,bd=r;
  for(let i=0;i<state.nodes.length;i++){ const [x,y]=w2s(...world(state.nodes[i][1],state.nodes[i][0]));
    const d=Math.hypot(x-sx,y-sy); if(d<=r&&d<bd){bd=d;best=i;} }
  return best; }
function hitVertex(sx,sy){ const r=8;
  for(const kind of ['water','bldg']){ const arr=state[kind];
    for(let z=0;z<arr.length;z++) for(let v=0;v<arr[z].length;v++){ const [x,y]=w2s(...world(arr[z][v][1],arr[z][v][0]));
      if(Math.hypot(x-sx,y-sy)<=r) return {kind,z,v}; } }
  return null; }
function hitEdge(sx,sy){ const r=6; let best=-1,bd=r;
  for(let i=0;i<state.edges.length;i++){ const [a,b]=state.edges[i];
    const A=world(state.nodes[a][1],state.nodes[a][0]), B=world(state.nodes[b][1],state.nodes[b][0]);
    const p1=w2s(...A), p2=w2s(...B);
    const L=Math.hypot(p2[0]-p1[0],p2[1]-p1[1]); if(L<1) continue;
    const t=Math.max(0,Math.min(1,((sx-p1[0])*(p2[0]-p1[0])+(sy-p1[1])*(p2[1]-p1[1]))/(L*L)));
    const d=Math.hypot(sx-(p1[0]+t*(p2[0]-p1[0])), sy-(p1[1]+t*(p2[1]-p1[1])));
    if(d<=r&&d<bd){bd=d;best=i;} }
  return best; }
function hitZone(sx,sy){ // 从上往下找第一个包含点的多边形（后画的在上）
  const [wx,wy]=s2w(sx,sy); const ll=unworld(wx,wy); const p=[ll[1],ll[0]]; // [lon,lat]
  for(const kind of ['bldg','water']){ const arr=state[kind];
    for(let z=arr.length-1;z>=0;z--) if(inPoly(p,arr[z])) return {kind,z}; }
  return null; }
function inPoly(p,poly){ let ins=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){ const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
    if(((yi>p[1])!==(yj>p[1]))&&(p[0]<(xj-xi)*(p[1]-yi)/(yj-yi)+xi)) ins=!ins; }
  return ins; }

// ── 绘制 ─=
function draw(){ if(!W) return;
  ctx.fillStyle='#0c0f13'; ctx.fillRect(0,0,W,H);
  const [sx0,sy0]=w2s(0,0); // 底图左上角屏幕坐标
  const layers=[['sat',satImg],['road',roadImg]];
  for(const [key,img] of layers){ const el=document.getElementById('ly'+key[0].toUpperCase()+key.slice(1));
    if(el&&el.checked&&img.complete&&img.naturalWidth){ ctx.drawImage(img,sx0,sy0,META.W*zoom,META.H*zoom); } }
  const lw = Math.max(1, 1.6/Math.sqrt(zoom));
  // 水域
  if(document.getElementById('lyWater').checked){ ctx.lineWidth=lw;
    for(const ring of state.water){ ctx.beginPath();
      ring.forEach((p,i)=>{ const [x,y]=w2s(...world(p[1],p[0])); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
      ctx.closePath(); ctx.fillStyle='rgba(60,140,255,0.25)'; ctx.fill(); ctx.strokeStyle='#2f7fe0'; ctx.stroke(); } }
  // 建筑
  if(document.getElementById('lyBldg').checked){ ctx.lineWidth=lw;
    for(const ring of state.bldg){ ctx.beginPath();
      ring.forEach((p,i)=>{ const [x,y]=w2s(...world(p[1],p[0])); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
      ctx.closePath(); ctx.fillStyle='rgba(160,150,130,0.22)'; ctx.fill(); ctx.strokeStyle='#a08a5a'; ctx.stroke(); } }
  // 边
  ctx.lineWidth=Math.max(1.5, 2.2/Math.sqrt(zoom));
  ctx.strokeStyle='rgba(255,255,255,0.75)'; ctx.beginPath();
  for(const [a,b] of state.edges){ const p1=w2s(...world(state.nodes[a][1],state.nodes[a][0])), p2=w2s(...world(state.nodes[b][1],state.nodes[b][0]));
    ctx.moveTo(p1[0],p1[1]); ctx.lineTo(p2[0],p2[1]); } ctx.stroke();
  ctx.strokeStyle='#ff2020'; ctx.beginPath();
  for(const [a,b] of state.edges){ const p1=w2s(...world(state.nodes[a][1],state.nodes[a][0])), p2=w2s(...world(state.nodes[b][1],state.nodes[b][0]));
    ctx.moveTo(p1[0],p1[1]); ctx.lineTo(p2[0],p2[1]); } ctx.stroke();
  // 节点
  const ns = Math.max(2.5, 3/Math.sqrt(zoom));
  ctx.fillStyle='#ff8c00';
  for(const n of state.nodes){ const [x,y]=w2s(...world(n[1],n[0])); ctx.fillRect(x-ns,y-ns,ns*2,ns*2); }
  // 打卡点
  if(document.getElementById('lyVena').checked){ for(const v of state.vena){ const [x,y]=w2s(...world(v.lat,v.lon));
    ctx.beginPath(); ctx.arc(x,y,7,0,2*PI); ctx.strokeStyle='#ff00ff'; ctx.lineWidth=2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(x,y,5,0,2*PI); ctx.strokeStyle='#fff'; ctx.lineWidth=1; ctx.stroke(); } }
  // 连线中 / 新多边形草稿
  if(linkFrom>=0){ const a=state.nodes[linkFrom], [x1,y1]=w2s(...world(a[1],a[0]));
    const [wx,wy]=s2w(mouse.sx,mouse.sy); const [x2,y2]=w2s(wx,wy);
    ctx.setLineDash([6,4]); ctx.strokeStyle='#ffd700'; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); ctx.setLineDash([]); }
  if(zoneDraft){ ctx.strokeStyle='#00ff88'; ctx.fillStyle='rgba(0,255,136,0.15)'; ctx.beginPath();
    zoneDraft.pts.forEach((p,i)=>{ const [x,y]=w2s(...world(p[1],p[0])); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    if(zoneDraft.pts.length>2) ctx.closePath(); ctx.fill(); ctx.stroke(); }
  // 比例尺
  const mPerPx = 156543.03*Math.cos(37.749*PI/180)/ (1<<18) / zoom;
  let bar = 100; if(mPerPx*bar>260) bar=50; if(mPerPx*bar>260) bar=20; if(mPerPx*bar<40) bar=200; if(mPerPx*bar<40) bar=500;
  ctx.fillStyle='#fff'; ctx.fillRect(20,H-30,bar/mPerPx,4);
  ctx.font='12px sans-serif'; ctx.fillText(bar+'m',20,H-38);
  info.textContent = '光标: ' + cursorText + '  |  节点 ' + state.nodes.length + '  边 ' + state.edges.length + '  水域 ' + state.water.length + '  建筑 ' + state.bldg.length + '  |  ' + (hints[mode]||'');
}
let mouse={sx:0,sy:0}, cursorText='', dragging=null, panning=null, downPos=null;
const hints={pan:'拖动平移 / 滚轮缩放', move:'拖动红点移动节点；拖动多边形顶点微调；打卡点需解锁', add:'点空白=新建节点；点节点=开始连线，再点另一节点=成边（右键/ESC取消）', del:'点节点=删节点及其边；点边=删边；点水域/建筑内部=删整个多边形', water:'先点[新建多边形]，然后依次点击顶点；双击最后一个点=完成', bldg:'先点[新建多边形]，然后依次点击顶点；双击最后一个点=完成'};

cv.addEventListener('mousemove',(e)=>{ mouse={sx:e.offsetX,sy:e.offsetY};
  const [wx,wy]=s2w(e.offsetX,e.offsetY); const ll=unworld(wx,wy);
  cursorText = ll[0].toFixed(6)+', '+ll[1].toFixed(6);
  if(panning){ cam.x-=(e.offsetX-panning[0])/zoom; cam.y-=(e.offsetY-panning[1])/zoom; panning=[e.offsetX,e.offsetY]; }
  else if(dragging){ const [wx2,wy2]=s2w(e.offsetX,e.offsetY); const ll2=unworld(wx2,wy2);
    if(dragging.t==='node'){ state.nodes[dragging.i][0]=+ll2[1].toFixed(7); state.nodes[dragging.i][1]=+ll2[0].toFixed(7); }
    else if(dragging.t==='vtx'){ state[dragging.kind][dragging.z][dragging.v][0]=+ll2[1].toFixed(7); state[dragging.kind][dragging.z][dragging.v][1]=+ll2[0].toFixed(7); }
    else if(dragging.t==='vena'){ state.vena[dragging.i].lon=+ll2[1].toFixed(7); state.vena[dragging.i].lat=+ll2[0].toFixed(7); } }
  draw(); });
cv.addEventListener('mousedown',(e)=>{ if(e.button!==0) return;
  downPos=[e.offsetX,e.offsetY];
  const [wx,wy]=s2w(e.offsetX,e.offsetY); const ll=unworld(wx,wy);
  if(mode==='move'||mode==='pan'||mode==='add'){
    const n=hitNode(e.offsetX,e.offsetY);
    const v=hitVertex(e.offsetX,e.offsetY);
    if(v){ snapshot(); dragging={t:'vtx',...v}; return; }
    if(n>=0){ snapshot(); if(mode==='add'){ if(linkFrom<0){ linkFrom=n; setStatus('已选节点#'+n+'，再点另一节点成边（右键取消）'); draw(); return; }
        if(linkFrom!==n){ if(!hasEdge(linkFrom,n)) state.edges.push([linkFrom,n]); linkFrom=-1; draw(); return; } }
      dragging={t:'node',i:n}; return; }
  }
  if(mode==='water'||mode==='bldg'){ const v=hitVertex(e.offsetX,e.offsetY);
    if(v){ snapshot(); dragging={t:'vtx',...v}; return; } }
  panning=[e.offsetX,e.offsetY]; });
cv.addEventListener('click',(e)=>{ if(e.button!==0) return;
  if(downPos && Math.hypot(e.offsetX-downPos[0], e.offsetY-downPos[1])>5) return; // 拖动不算点击
  const [wx,wy]=s2w(e.offsetX,e.offsetY); const ll=unworld(wx,wy);
  if(mode==='add'&&linkFrom<0){ snapshot(); state.nodes.push([+ll[1].toFixed(7),+ll[0].toFixed(7)]);
    linkFrom=state.nodes.length-1; setStatus('新节点#'+linkFrom+'，点另一节点成边'); draw(); return; }
  if((mode==='water'||mode==='bldg')&&zoneDraft){ zoneDraft.pts.push([+ll[1].toFixed(7),+ll[0].toFixed(7)]); draw(); return; }
  if(mode==='del'){ const n=hitNode(e.offsetX,e.offsetY);
    if(n>=0){ snapshot(); state.edges=state.edges.filter(([a,b])=>a!==n&&b!==n);
      state.nodes.splice(n,1);
      state.edges=state.edges.map(([a,b])=>[a>n?a-1:a,b>n?b-1:b]); linkFrom=-1; draw(); return; }
    const ei=hitEdge(e.offsetX,e.offsetY);
    if(ei>=0){ snapshot(); state.edges.splice(ei,1); draw(); return; }
    const zn=hitZone(e.offsetX,e.offsetY);
    if(zn){ if(confirm('删除整个'+(zn.kind==='water'?'水域':'建筑')+'多边形 #'+zn.z+' ?')){ snapshot(); state[zn.kind].splice(zn.z,1); draw(); } return; } } });
cv.addEventListener('dblclick',(e)=>{ 
  if(zoneDraft&&(mode==='water'||mode==='bldg')){
    if(zoneDraft.pts.length>1){ const a=zoneDraft.pts[zoneDraft.pts.length-1], b=zoneDraft.pts[zoneDraft.pts.length-2];
      if(Math.hypot((a[0]-b[0])*88138,(a[1]-b[1])*110540)<1) zoneDraft.pts.pop(); }
    if(zoneDraft.pts.length>=3){ state[zoneDraft.kind].push(zoneDraft.pts); setStatus('多边形已创建，'+zoneDraft.pts.length+' 顶点'); }
    else setStatus('顶点不足3个，已取消');
    zoneDraft=null; draw(); return; }
  const v=hitVertex(e.offsetX,e.offsetY);
  if(v&&(mode==='water'||mode==='bldg')){ snapshot(); state[v.kind][v.z].splice(v.v,1);
    if(state[v.kind][v.z].length<3){ state[v.kind].splice(v.z,1); setStatus('顶点不足，已删除该多边形'); }
    draw(); return; } });
cv.addEventListener('mouseup',()=>{ dragging=null; panning=null; downPos=null; persist(); });
cv.addEventListener('mouseleave',()=>{ dragging=null; panning=null; downPos=null; });
cv.addEventListener('contextmenu',(e)=>{ e.preventDefault(); if(linkFrom>=0){ linkFrom=-1; setStatus('连线取消'); draw(); } });
cv.addEventListener('wheel',(e)=>{ e.preventDefault();
  const [wx,wy]=s2w(e.offsetX,e.offsetY);
  zoom *= e.deltaY<0?1.15:1/1.15; zoom=Math.min(MAXZ,Math.max(MINZ,zoom));
  cam.x = wx-(e.offsetX-W/2)/zoom; cam.y = wy-(e.offsetY-H/2)/zoom; draw(); },{passive:false});

function hasEdge(a,b){ return state.edges.some(([x,y])=>(x===a&&y===b)||(x===b&&y===a)); }
function setStatus(s){ document.getElementById('info').dataset.extra=s; }
document.querySelectorAll('#bar button[data-m]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('#bar button[data-m]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); mode=b.dataset.m; linkFrom=-1;
  document.getElementById('hint').textContent={pan:'拖动平移，滚轮缩放。',move:'直接拖动节点/顶点。',add:'点空白新建节点，点节点连线。',del:'点节点/边/多边形删除。',water:'新建多边形后依次点击顶点，双击最后一点完成。',bldg:'新建多边形后依次点击顶点，双击最后一点完成。'}[mode]; }));
document.getElementById('newZone').addEventListener('click',()=>{
  if(mode!=='water'&&mode!=='bldg'){ setStatus('请先选[水域多边形]或[建筑多边形]模式'); return; }
  snapshot(); zoneDraft={kind:mode,pts:[]}; setStatus('依次点击多边形顶点，双击最后一点完成'); });
for(const id of ['lySat','lyRoad','lyWater','lyBldg','lyVena']) document.getElementById(id).addEventListener('change',draw);
document.getElementById('undo').addEventListener('click',undo);
document.getElementById('reset').addEventListener('click',()=>{ if(confirm('恢复到打开时的状态？')){ Object.assign(state,JSON.parse(INITIAL)); undoStack=[]; persist(); draw(); } });
document.getElementById('save').addEventListener('click',()=>{
  // 校验
  const deg = new Set(); for(let i=0;i<state.nodes.length;i++) deg.add(0);
  const degArr = new Array(state.nodes.length).fill(0);
  for(const [a,b] of state.edges){ degArr[a]++; degArr[b]++; }
  const iso = degArr.map((d,i)=>d===0?i:-1).filter(i=>i>=0);
  let msg = '节点 '+state.nodes.length+'，边 '+state.edges.length+'，水域 '+state.water.length+'，建筑 '+state.bldg.length;
  if(iso.length) msg += '\\n⚠️ 孤立节点: #'+iso.join(', #')+'（导出后规划器会忽略它们）';
  if(!confirm(msg+'\\n\\n导出 roadnet.json ？')) return;
  const out = {
    version: 3,
    corners: DATA.corners,
    nodes: state.nodes, edges: state.edges,
    venaPoints: state.vena,
    waterZones: state.water, forbiddenZones: state.bldg,
    meta: { source: '原版手画路网 + 卫星编辑器人工精修', editedAt: new Date().toISOString(), nodes: state.nodes.length, edges: state.edges.length },
  };
  const blob = new Blob([JSON.stringify(out,null,1)],{type:'application/json'});
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='roadnet.json'; a.click();
  setStatus('已导出 roadnet.json —— 请替换 happyrun/roadnet.json（建议先备份原文件），然后跑 DryRun 校验');
});
addEventListener('keydown',(e)=>{ if(e.key==='Escape'){ linkFrom=-1; zoneDraft=null; draw(); }
  if((e.ctrlKey||e.metaKey)&&e.key==='z'){ e.preventDefault(); undo(); } });
resize();
</script></body></html>`;
fs.writeFileSync(path.join(OUTDIR, '路网编辑器.html'), tpl.replace('__META__', JSON.stringify(meta)).replace('__DATA__', JSON.stringify(DATA)));
console.log('已生成', path.join(OUTDIR, '路网编辑器.html'), `(${(fs.statSync(path.join(OUTDIR, '路网编辑器.html')).size / 1e6).toFixed(2)}MB)`);
