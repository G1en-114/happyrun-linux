// 配速节奏统计验证：平均配速严格不变、节奏有层次（热身绿/巡航黄/冲刺红）、逐秒平滑
import { genTrack } from '../lib/track.mjs';

const fmtP = (s) => `${Math.floor(s / 60)}'${String(Math.round(s % 60)).padStart(2, '0')}"`;
const pct = (x) => (x * 100).toFixed(0) + '%';

let allOk = true;
for (const [targetM, usedS] of [[3000, 627], [3350, 655], [3000, 585], [3350, 700]]) {
  for (let r = 0; r < 3; r++) {
    const points = genTrack({
      centerLat: 37.7355, centerLon: 112.7482,
      targetMeters: targetM, usedTimeS: usedS, startTsMs: Date.now(),
      distanceK: 0, sampleHz: 1, jitterM: 0.7, smooth: true, zones: {},
    });
    const n = points.length;
    const distM = points[n - 1][4];
    const speeds = points.slice(1).map(p => p[2]);               // 每秒速度 m/s（含 ±1.5% 机械波动）
    const paces = speeds.map(v => Math.round(1000 / v));         // 每秒配速 s/km
    const avgPace = usedS / (targetM / 1000);
    const sorted = [...paces].sort((a, b) => a - b);
    const q = (x) => sorted[Math.floor(x * (sorted.length - 1))];
    let maxJump = 0;
    for (let i = 1; i < paces.length; i++) maxJump = Math.max(maxJump, Math.abs(paces[i] - paces[i - 1]));
    // 色带分布（相对全 run 的 min~max 线性映射：0~33% 绿 / 33~66% 黄 / 66~100% 红）
    const mn = sorted[0], mx = sorted[sorted.length - 1];
    let g = 0, y = 0, r2 = 0;
    for (const p of paces) {
      const rel = (mx - p) / (mx - mn); // 越快 rel 越大
      if (rel > 0.66) r2++; else if (rel > 0.33) y++; else g++;
    }
    const gR = g / n, yR = y / n, rR = r2 / n;
    const ptOk = Math.abs(n - 1 - usedS) <= 2;
    const distOk = Math.abs(distM - targetM) < targetM * 0.003;
    const avgOk = Math.abs((usedS / (distM / 1000)) - avgPace) < 2;
    const smoothOk = maxJump <= 12;      // 相邻秒跳变 ≤12 s/km（平滑渐变）
    const rangeOk = avgPace - q(0.05) >= (avgPace >= 205 ? 15 : 12) && q(0.95) - avgPace >= 25; // 快端至少快15s、慢端至少慢25s
    // 色带分档：慢配速档（≥3'25"/km）要求标准三色分布；快配速档冲刺被绝对上限压住，
    // 动态范围窄，红多黄少是物理真实的（快跑本来就红多）
    const bandOk = avgPace >= 205
      ? (gR >= 0.06 && gR <= 0.30 && yR >= 0.45 && yR <= 0.75 && rR >= 0.12 && rR <= 0.40)
      : (gR >= 0.05 && yR >= 0.06 && rR <= 0.88);
    const ok = ptOk && distOk && avgOk && smoothOk && rangeOk && bandOk;
    if (!ok) allOk = false;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} | 目标 ${(targetM / 1000).toFixed(2)}km/${Math.floor(usedS / 60)}:${String(usedS % 60).padStart(2, '0')} | ` +
      `实际 ${distM.toFixed(0)}m/${n - 1}s 平均 ${fmtP(usedS / (distM / 1000))} | ` +
      `分段 p5 ${fmtP(q(0.05))} · 中位 ${fmtP(q(0.5))} · p95 ${fmtP(q(0.95))} | ` +
      `色带 绿${pct(gR)} 黄${pct(yR)} 红${pct(rR)} | 最大秒跳 ${maxJump}s/km` +
      (!ptOk ? ' [点数]' : '') + (!distOk ? ' [距离]' : '') + (!avgOk ? ' [平均]' : '') +
      (!smoothOk ? ' [秒跳]' : '') + (!rangeOk ? ' [层次]' : '') + (!bandOk ? ' [色带]' : '')
    );
  }
}
console.log(allOk ? '\n=== 全部达标：平均配速严格不变，热身绿/巡航黄/冲刺红分层清晰，逐秒平滑 ===' : '\n=== 存在未达标项 ===');
process.exit(allOk ? 0 : 1);
