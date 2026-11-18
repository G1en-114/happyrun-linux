/**
 * 轨迹功能等价性离线校验（不联网）
 *
 * 复刻 auto-run.mjs dry-run 的打卡点校验逻辑：
 *   每个目标打卡点 → 找路网中离它最近的节点 → 该节点必须被轨迹在 30m 内经过
 * 另加：
 *   - 规划路径的所有节点都被轨迹紧贴经过（样条穿点保证）
 *   - 距离/用时/点数/配速区间合理性
 *
 * 用法：node tools/verify-track.mjs [--dist=4] [--time=1320] [--runs=5]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcDistance, genTrack, countSpeedChanges } from '../lib/track.mjs';
import { planRunRouteNet } from '../lib/route.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] !== undefined ? m[2] : true;
}
const cfg = JSON.parse(fs.readFileSync(fs.existsSync(path.join(ROOT, 'config.json')) ? path.join(ROOT, 'config.json') : path.join(ROOT, 'config.template.json'), 'utf8'));
const run = cfg.run || {};
const net = JSON.parse(fs.readFileSync(path.join(ROOT, 'roadnet.json'), 'utf8'));
const netNodes = (net.nodes || []).map((ll) => [ll[1], ll[0]]);
const netEdges = net.edges || [];

const distKm = Number(args.dist) || run.distanceKm || 4;
const usedS = Number(args.time) || run.usedTimeS || 1320;
const runs = Number(args.runs) || 5;
const smooth = args.smooth !== 'false';

let allOk = true;
for (let r = 0; r < runs; r++) {
  // 随机抽 3 个打卡点（模拟服务端）
  const vp = (net.venaPoints || []).map((v) => [v.lat, v.lon]);
  const goals = [...vp].sort(() => Math.random() - 0.5).slice(0, 3);
  const targetM = distKm * 1000 * 1.05;

  const idxSeq = planRunRouteNet(netNodes, netEdges, goals, targetM, {});
  if (!idxSeq || idxSeq.length < 2) {
    console.log(`#${r} ❌ 规划失败`);
    allOk = false;
    continue;
  }
  const routeNodes = idxSeq.map((i) => netNodes[i]);

  const points = genTrack({
    centerLat: run.centerLat, centerLon: run.centerLon,
    targetMeters: distKm * 1000, usedTimeS: usedS, startTsMs: Date.now(),
    distanceK: 0.05, sampleHz: 1,
    jitterM: run.jitterM != null ? run.jitterM : 4,
    smooth,
    zones: { water: net.waterZones || [], forbidden: net.forbiddenZones || [] },
    route: routeNodes,
  });

  const distM = points[points.length - 1][4];
  const speeds = points.map((p) => p[2]);
  const changes = countSpeedChanges(points);

  // 校验 1：每个打卡点的最近路网节点被轨迹 30m 内经过
  let passOk = 0;
  const details = [];
  for (const g of goals) {
    let ni = 0, nd = Infinity;
    for (let k = 0; k < netNodes.length; k++) {
      const d = calcDistance(netNodes[k][0], netNodes[k][1], g[0], g[1]);
      if (d < nd) { nd = d; ni = k; }
    }
    let minD = Infinity;
    for (const p of points) minD = Math.min(minD, calcDistance(p[0], p[1], netNodes[ni][0], netNodes[ni][1]));
    const ok = minD < 30;
    if (ok) passOk++;
    details.push(`${ok ? '✅' : '❌'}${minD.toFixed(0)}m`);
  }

  // 校验 2：规划路径中"被走到"的节点都被轨迹 10m 内经过（样条穿点保证）。
  // 路径长度可能大于目标距离（补距游走段），轨迹到距离即停，尾部节点不检查。
  let nodeMiss = 0, nodeChecked = 0;
  {
    let cum = 0;
    for (let i = 0; i < routeNodes.length; i++) {
      if (i > 0) {
        cum += calcDistance(routeNodes[i - 1][0], routeNodes[i - 1][1], routeNodes[i][0], routeNodes[i][1]);
      }
      if (cum > distM - 100) break; // 之后的节点在停止点附近/之后（样条弧长略长于折线），不检查
      nodeChecked++;
      let minD = Infinity;
      for (const p of points) minD = Math.min(minD, calcDistance(p[0], p[1], routeNodes[i][0], routeNodes[i][1]));
      if (minD > 10) nodeMiss++;
    }
  }

  // 校验 3：点数/用时/距离/配速
  const nPts = points.length;
  const pace = usedS / distKm;
  const okPts = Math.abs(nPts - 1 - usedS) <= 8; // 1Hz + 首点（快配速削顶时允许少量补走）
  const okDist = distM >= distKm * 1000;
  const okSpeed = changes >= 3;
  const ok = passOk === goals.length && nodeMiss === 0 && okPts && okDist && okSpeed;
  if (!ok) allOk = false;

  console.log(
    `#${r} ${ok ? 'PASS' : 'FAIL'} | ` +
    `打卡点 ${passOk}/${goals.length} [${details.join(' ')}] | ` +
    `路径节点未贴住: ${nodeMiss}/${nodeChecked} | ` +
    `点数 ${nPts}(用时${usedS}${okPts ? '' : '!'}) | ` +
    `距离 ${(distM / 1000).toFixed(3)}km${okDist ? '' : '!'} | ` +
    `配速 ${pace.toFixed(0)}s/km | 速度变化 ${changes}`,
  );
}
console.log(allOk ? '\n=== 全部轮次通过 ===' : '\n=== 存在失败项 ===');
process.exit(allOk ? 0 : 1);
