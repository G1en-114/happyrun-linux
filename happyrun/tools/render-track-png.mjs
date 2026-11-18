/**
 * 轨迹可视化工具 —— 把 record-preview.json 画成 PNG（纯 Node，无第三方依赖）
 *
 * 用法：
 *   node tools/render-track-png.mjs [record.json] [--roadnet=roadnet.json] [--out=track.png]
 *
 * 画的内容：
 *   - 路网边（浅灰细线）+ 打卡点（红色圆圈），--roadnet 给了才画
 *   - 轨迹线：按相邻点距离算瞬时速度，复刻 detail 页 computePointsSpeed 的
 *     4.16 m/s 阈值配色（绿=慢跑 / 橙=快于阈值），肉眼检查平滑度
 *   - 起点绿方块 / 终点黑方块
 *
 * 同时打印平滑度指标（相邻点方向变化、位移统计），供改造前后对比。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── 参数 ──
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = true;
}
const recordPath = (() => {
  const pos = process.argv.slice(2).find((a) => !a.startsWith('--'));
  return pos ? (path.isAbsolute(pos) ? pos : path.join(process.cwd(), pos)) : path.join(ROOT, 'record-preview.json');
})();
const outPath = args.out || path.join(ROOT, 'tools', 'track.png');
const roadnetPath = args.roadnet
  ? (path.isAbsolute(args.roadnet) ? args.roadnet : path.join(ROOT, args.roadnet))
  : null;

// ── 读取数据 ──
const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
const pts = (record.file || []).map((p) => [p.a, p.o, p.s, p.b]); // [lat, lon, speed, distM]
if (pts.length < 2) {
  console.error('record.file 点数不足:', pts.length);
  process.exit(1);
}
let net = null;
if (roadnetPath && fs.existsSync(roadnetPath)) {
  net = JSON.parse(fs.readFileSync(roadnetPath, 'utf8'));
}

// ── 投影：局部等距圆柱（米），北在上 ──
// --spanM=600：以起点为中心只画 600m 范围（放大看线条质量）；默认画全部
const lat0 = pts[0][0];
const M_PER_DEG = 111320;
const toXY = (lat, lon) => [
  (lon - pts[0][1]) * M_PER_DEG * Math.cos((lat0 * Math.PI) / 180),
  -(lat - lat0) * M_PER_DEG,
];

// ── 画布 ──
// --style=app：白底 + 深色粗线（还原乐跑详情页的轨迹画法，便于和手机截图直接对照）
const appStyle = args.style === 'app';
const allXY = pts.map((p) => toXY(p[0], p[1]));
const netEdgesXY = []; // [[p1,p2],...]
const venaXY = [];     // [[x,y],...]
if (net) {
  for (const [a, b] of net.edges) {
    netEdgesXY.push([toXY(net.nodes[a][1], net.nodes[a][0]), toXY(net.nodes[b][1], net.nodes[b][0])]);
  }
  for (const v of net.venaPoints || []) venaXY.push(toXY(v.lat, v.lon));
}
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const [x, y] of allXY) {
  minX = Math.min(minX, x); maxX = Math.max(maxX, x);
  minY = Math.min(minY, y); maxY = Math.max(maxY, y);
}
for (const [p1, p2] of netEdgesXY) {
  for (const [x, y] of [p1, p2]) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
}
for (const [x, y] of venaXY) {
  minX = Math.min(minX, x); maxX = Math.max(maxX, x);
  minY = Math.min(minY, y); maxY = Math.max(maxY, y);
}
if (args.spanM) {
  const s = Number(args.spanM);
  if (args.center) {
    // --center=lon,lat：以指定经纬度为中心裁剪
    const parts = args.center.split(',').map(Number);
    const c = toXY(parts[1], parts[0]); // toXY(lat, lon)
    minX = c[0] - s; maxX = c[0] + s; minY = c[1] - s; maxY = c[1] + s;
  } else {
    minX = -s; maxX = s; minY = -s; maxY = s;
  }
}
const WIDTH = 1600;
const MARGIN = 40;
const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
const scale = (WIDTH - 2 * MARGIN) / Math.max(spanX, spanY);
const HEIGHT = Math.max(400, Math.ceil(spanY * scale) + 2 * MARGIN);
const px = (x, y) => [Math.round((x - minX) * scale) + MARGIN, Math.round((y - minY) * scale) + MARGIN];

// ── PNG 编码（RGB8，filter 0）──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const img = new Uint8Array(WIDTH * HEIGHT * 3); // 默认白底
const BG = appStyle ? [255, 255, 255] : [0, 0, 0];
for (let i = 0; i < img.length; i += 3) {
  img[i] = BG[0]; img[i + 1] = BG[1]; img[i + 2] = BG[2];
}
function setPx(x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 3;
  img[i] = r; img[i + 1] = g; img[i + 2] = b;
}
function fillRect(x, y, w, h, c) {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) setPx(x + dx, y + dy, c);
}
/** 粗线：沿线以步长 0.5px 填 t×t 方块 */
function drawLine(p1, p2, color, t = 2) {
  const [x1, y1] = p1, [x2, y2] = p2;
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x1 + ((x2 - x1) * i) / steps);
    const y = Math.round(y1 + ((y2 - y1) * i) / steps);
    fillRect(x - (t >> 1), y - (t >> 1), t, t, color);
  }
}
function drawCircle(cx, cy, r, color) {
  for (let a = 0; a < 360; a += 2) {
    const x = Math.round(cx + r * Math.cos((a * Math.PI) / 180));
    const y = Math.round(cy + r * Math.sin((a * Math.PI) / 180));
    setPx(x, y, color);
  }
}

/** 多边形填充（扫描线） */
function fillPoly(screenPts, color) {
  let yMin = Infinity, yMax = -Infinity;
  for (const [, y] of screenPts) { yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); }
  for (let y = Math.max(0, Math.ceil(yMin)); y <= Math.min(HEIGHT - 1, Math.floor(yMax)); y++) {
    const xs = [];
    for (let i = 0, j = screenPts.length - 1; i < screenPts.length; j = i++) {
      const [xi, yi] = screenPts[i], [xj, yj] = screenPts[j];
      if ((yi > y) !== (yj > y)) xs.push(xj + (y - yj) * (xi - xj) / (yi - yj));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.round(xs[k])); x <= Math.min(WIDTH - 1, Math.round(xs[k + 1])); x++) setPx(x, y, color);
    }
  }
}

// ── 画禁区（水域=蓝，建筑=灰）──
if (net && Array.isArray(net.waterZones)) {
  for (const poly of net.waterZones) fillPoly(poly.map(p => px(...toXY(p[1], p[0]))), appStyle ? [198, 226, 250] : [40, 80, 160]);
}
if (net && Array.isArray(net.forbiddenZones)) {
  for (const poly of net.forbiddenZones) fillPoly(poly.map(p => px(...toXY(p[1], p[0]))), appStyle ? [236, 234, 228] : [70, 70, 70]);
}

// ── 画路网 ──
const GRAY = appStyle ? [228, 226, 222] : [210, 210, 210];
const RED = appStyle ? [225, 90, 90] : [220, 40, 40];
for (const [p1, p2] of netEdgesXY) drawLine(px(p1[0], p1[1]), px(p2[0], p2[1]), GRAY, 1);
for (const [x, y] of venaXY) {
  const [cx, cy] = px(x, y);
  drawCircle(cx, cy, 6, RED);
  drawCircle(cx, cy, 5, [255, 255, 255]);
  drawCircle(cx, cy, 4, RED);
}

// ── 画轨迹（detail 页速度配色：绝对速度阈值，红≥4.16）──
function speedColor(v) {
  if (v >= 4.16) return [215, 50, 40];  // 红（快）
  if (v >= 3.8) return [235, 130, 40];  // 橙
  if (v >= 3.3) return [230, 200, 60];  // 黄
  return [60, 150, 70];                 // 绿（慢）
}
let renderLenM = 0;
const headDiffs = [];
const stepDists = [];
const colorBins = { red: 0, orange: 0, yellow: 0, green: 0 };
function binOf(v) {
  if (v >= 4.16) return 'red';
  if (v >= 3.8) return 'orange';
  if (v >= 3.3) return 'yellow';
  return 'green';
}
for (let i = 1; i < pts.length; i++) {
  const [x1, y1] = px(...allXY[i - 1]);
  const [x2, y2] = px(...allXY[i]);
  const dM = Math.hypot(allXY[i][0] - allXY[i - 1][0], allXY[i][1] - allXY[i - 1][1]);
  renderLenM += dM;
  stepDists.push(dM);
  colorBins[binOf(dM)]++; // detail 页按相邻点位移配色，这里统计同口径的占比
  if (i >= 2) {
    const h1 = Math.atan2(allXY[i - 1][1] - allXY[i - 2][1], allXY[i - 1][0] - allXY[i - 2][0]);
    const h2 = Math.atan2(allXY[i][1] - allXY[i - 1][1], allXY[i][0] - allXY[i - 1][0]);
    let dh = ((h2 - h1) * 180) / Math.PI;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    headDiffs.push(Math.abs(dh));
  }
  const c = appStyle ? [45, 55, 75] : speedColor(pts[i][2] || 0);
  drawLine([x1, y1], [x2, y2], c, appStyle ? 4 : 2);
}
// 起终点
{
  const [sx, sy] = px(allXY[0][0], allXY[0][1]);
  fillRect(sx - 4, sy - 4, 8, 8, [30, 160, 60]);
  const [ex, ey] = px(allXY[allXY.length - 1][0], allXY[allXY.length - 1][1]);
  fillRect(ex - 4, ey - 4, 8, 8, [20, 20, 20]);
}

// ── 写 PNG ──
const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y++) {
  raw[y * (WIDTH * 3 + 1)] = 0; // filter none
  Buffer.from(img.buffer, y * WIDTH * 3, WIDTH * 3).copy(raw, y * (WIDTH * 3 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(outPath, png);

// ── 平滑度指标 ──
function pct(arr, p) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
const distM = pts.length ? pts[pts.length - 1][3] : 0;
const maxSpeed = Math.max(...pts.map((p) => p[2] || 0));
console.log(`图: ${outPath}  (${WIDTH}x${HEIGHT}, 比例尺 ${scale.toFixed(3)} px/m)`);
console.log(`点数=${pts.length} 上报距离=${(distM / 1000).toFixed(3)}km 渲染长度=${(renderLenM / 1000).toFixed(3)}km 最大速度=${maxSpeed.toFixed(2)}m/s`);
console.log(`每秒位移 m: min=${Math.min(...stepDists).toFixed(2)} avg=${(renderLenM / stepDists.length).toFixed(2)} max=${Math.max(...stepDists).toFixed(2)}`);
console.log(`转向角 deg/步: p50=${pct(headDiffs, 0.5).toFixed(1)} p90=${pct(headDiffs, 0.9).toFixed(1)} p99=${pct(headDiffs, 0.99).toFixed(1)} max=${Math.max(...headDiffs).toFixed(1)}  均值=${(headDiffs.reduce((a, b) => a + b, 0) / headDiffs.length).toFixed(1)}`);
const sharp = headDiffs.filter((d) => d > 45).length;
console.log(`急转(>45°)步数: ${sharp} / ${headDiffs.length} (${((sharp / headDiffs.length) * 100).toFixed(2)}%)`);
const cb = colorBins;
const cbTotal = cb.red + cb.orange + cb.yellow + cb.green;
console.log(`配色占比(按相邻点位移,同 detail 页口径): 红 ${(cb.red / cbTotal * 100).toFixed(0)}% 橙 ${(cb.orange / cbTotal * 100).toFixed(0)}% 黄 ${(cb.yellow / cbTotal * 100).toFixed(0)}% 绿 ${(cb.green / cbTotal * 100).toFixed(0)}%`);
