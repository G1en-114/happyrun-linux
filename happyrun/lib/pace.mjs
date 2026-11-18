/**
 * 智能配速规划器 —— 根据打卡点布局决定本次的最终距离与平均配速
 *
 * 需求（2026-10-15 版）：
 *   - 每次距离在 [distanceMinKm, distanceMaxKm]（默认 3.00~3.35km）内随机取；
 *     打卡点走完后若已超过随机目标 → 以必到里程收尾（有效优先，绝不低于下限）
 *   - 平均配速落在 [paceMinS, paceMaxS]（默认 3'15"~3'30"/km = 195~210 s/km）
 *   - 配速随距离【反比】：跑得越长配速越快，使总用时落在锚点时间附近——
 *     用时 = 锚点(默认 643s ≈ 10'43") ± timeJitterS 随机抖动，
 *     反推 pace = 用时 / 距离，再夹进配速带。
 *     距离两端的理论用时：3.00km→627s、3.175km→643s、3.35km→657s，
 *     即“总时长比较均衡，但有 ±15s 左右的适当差异”。
 *   - 距离决策：
 *     finalM = max( 随机目标M, 必到里程 + max(20m, 1%) )
 *     - 打卡点走完后不足随机目标 → 游走补足
 *     - 走完后已超过 → 以必到里程收尾（+余量保证样条变短后仍走完全部打卡点）
 */

/** 秒/km → 3'25" 形式 */
export function fmtPace(sPerKm) {
  const s = Math.round(sPerKm);
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`;
}

/**
 * @param {object} o
 * @param {number} o.mandatoryM    必到里程（走完全部打卡点时的路径长度，米；无打卡点传 0）
 * @param {number} o.targetKm      目标距离（公里）——本次已随机好的目标（3.00~3.35）
 * @param {number} [o.uplift]      兼容旧参数：目标上浮比例（智能距离随机化后传 0）
 * @param {number} [o.paceMinS]    配速带下限 秒/km（默认 195 = 3'15"）
 * @param {number} [o.paceMaxS]    配速带上限 秒/km（默认 210 = 3'30"）
 * @param {number} [o.jitterS]     兼容旧参数（配速抖动秒/km）；新逻辑用 timeJitterS
 * @param {number} [o.timeAnchorS] 用时锚点 秒（默认 643）
 * @param {number} [o.timeJitterS] 用时随机抖动 ±秒（默认 8）
 * @returns {{finalKm:number, usedS:number, paceSPK:number, ratio:number, nearFloor:boolean}}
 */
export function planPace(o) {
  const {
    mandatoryM = 0,
    targetKm = 3,
    uplift = 0,
    paceMinS = 195,
    paceMaxS = 210,
    timeAnchorS = 643,
    timeJitterS = 8,
  } = o;

  const targetM = targetKm * 1000 * (1 + uplift);
  // 必到里程余量：样条平滑会让路径比折线略短（~1%），+max(20m, 1%) 保证
  // 行走距离覆盖全部打卡点
  const goalMarginM = Math.max(20, mandatoryM * 0.01);
  const finalM = Math.max(targetM, mandatoryM + goalMarginM);
  const finalKm = +(finalM / 1000).toFixed(3);

  // 用时锚点 ± 抖动 → 配速 = 用时/距离（距离越长配速越快），夹进配速带
  // 两端各留 1 s/km 余量，避免 usedS 取整后显示配速越界
  const tAnchor = timeAnchorS + (Math.random() * 2 - 1) * timeJitterS;
  const pace = Math.min(paceMaxS - 1, Math.max(paceMinS + 1, Math.round(tAnchor / finalKm)));
  const usedS = Math.max(60, Math.round(finalM / 1000 * pace));

  // 兼容字段：ratio = 必到里程占比；nearFloor = 配速被压到带边
  const ratio = mandatoryM > 0 ? Math.min(1, mandatoryM / finalM) : 0.35;
  const nearFloor = pace <= paceMinS + 1 || pace >= paceMaxS - 1;

  return { finalKm, usedS, paceSPK: +(usedS / finalKm).toFixed(1), ratio: +ratio.toFixed(2), nearFloor };
}
