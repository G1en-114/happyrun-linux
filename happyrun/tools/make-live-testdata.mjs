// 生成实时轨迹图测试数据：formal-run.track.json + formal-run.status.json（模拟跑到 42%）
import fs from 'node:fs';
import { calcDistance, genTrack } from '../lib/track.mjs';
import { planRunRouteNet } from '../lib/route.mjs';
const net = JSON.parse(fs.readFileSync(new URL('../roadnet.json', import.meta.url), 'utf8'));
const netNodes = net.nodes.map(ll => [ll[1], ll[0]]);
const goals = ['7', '50', '15'].map(id => { const v = net.venaPoints.find(p => p.point_id === id); return [v.lat, v.lon]; });
const passPoints = ['7', '50', '15'].map(id => { const v = net.venaPoints.find(p => p.point_id === id); return { id, name: v.address, lat: v.lat, lon: v.lon }; });
const meta = {};
const seq = planRunRouteNet(netNodes, net.edges, goals, 3180, { goalMaxOffM: 85, meta });
const routeNodes = seq.map(i => netNodes[i]);
const usedS = 643, finalKm = 3.15;
const points = genTrack({
  centerLat: 37.749, centerLon: 112.72,
  targetMeters: finalKm * 1000, usedTimeS: usedS, startTsMs: Date.now(),
  distanceK: 0, sampleHz: 1,
  zones: { water: net.waterZones, forbidden: net.forbiddenZones },
  route: routeNodes,
});
fs.writeFileSync(new URL('../formal-run.track.json', import.meta.url), JSON.stringify({
  z: 18,
  points: points.map(p => [+p[0].toFixed(7), +p[1].toFixed(7)]),
  usedS, targetKm: finalKm, plannedPace: "3'21\"",
  passPoints,
}));
const ELAPSED = Math.floor(usedS * 0.42); // 跑到 42%
fs.writeFileSync(new URL('../formal-run.status.json', import.meta.url), JSON.stringify({
  phase: 'running', pid: 12345, account: '2025009166',
  elapsedS: ELAPSED, totalS: usedS, simKm: +(finalKm * 0.42).toFixed(2),
  curPaceS: Math.round(usedS / finalKm), plannedPace: "3'21\"",
  targetKm: finalKm,
  waitStartEpoch: Math.floor(Date.now() / 1000) - ELAPSED,
  runEtaEpoch: Math.floor(Date.now() / 1000) + (usedS - ELAPSED),
}));
console.log(`测试数据已生成: 轨迹 ${points.length} 点, 模拟已跑 ${ELAPSED}s (42%)`);
