/**
 * 轨迹路径平滑 —— centripetal Catmull-Rom 样条加密
 *
 * 解决的问题：路网规划器（planRunRouteNet）输出的是路网节点折线，
 * 节点间距 80~280m，直接沿折线采样时每个节点处都是硬折角，
 * 画出来是"多边形"，不像真人跑步的圆滑曲线。
 *
 * 做法：
 *   用 centripetal Catmull-Rom（α=0.5）样条**穿过每个原始节点**重采样，
 *   拐角处变成圆弧过渡（真实跑者过弯也是圆弧），直线段保持直线。
 *   穿点特性保证：打卡点校验逻辑（轨迹 30m 内经过最近路网节点）完全不受影响；
 *   路径长度与原折线几乎一致（圆弧只切掉拐角极小的内角）。
 *
 * centripetal 参数化的好处：在折返（发卡弯）、锐角处不会像均匀参数化那样
 * 打圈或自交，是路径平滑的标准选择。
 */

/** Haversine 距离（米），[lat,lon] 格式 */
function havM(a, b) {
  const R = 6378137, r = Math.PI / 180;
  const dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const la1 = a[0] * r, la2 = b[0] * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Barry-Goldman 递归式的 centripetal Catmull-Rom 取点 */
function crPoint(P0, P1, P2, P3, u) {
  const alpha = 0.5;
  const t0 = 0;
  const t1 = t0 + Math.pow(Math.max(havM(P0, P1), 1e-6), alpha);
  const t2 = t1 + Math.pow(Math.max(havM(P1, P2), 1e-6), alpha);
  const t3 = t2 + Math.pow(Math.max(havM(P2, P3), 1e-6), alpha);
  const t = t1 + (t2 - t1) * u;
  const lerp = (A, B, ta, tb) => {
    const w = (t - ta) / (tb - ta || 1e-9);
    return [A[0] + (B[0] - A[0]) * w, A[1] + (B[1] - A[1]) * w];
  };
  const A1 = lerp(P0, P1, t0, t1);
  const A2 = lerp(P1, P2, t1, t2);
  const A3 = lerp(P2, P3, t2, t3);
  const B1 = lerp(A1, A2, t0, t2);
  const B2 = lerp(A2, A3, t1, t3);
  return lerp(B1, B2, t1, t2);
}

/**
 * 把节点折线加密成平滑曲线。
 * @param {number[][]} route  [[lat,lon],...] 原始节点序列（≥2 个）
 * @param {object} [opts]
 * @param {number} [opts.stepM=3]   采样步长（米）；越小越圆滑，点文件越大
 * @returns {number[][]} 密集点序列，**穿过全部原始节点**，总长与原折线近似相等
 */
export function smoothDensify(route, { stepM = 3 } = {}) {
  if (!Array.isArray(route) || route.length < 2) return route;
  // ── 预平滑：顶点滑动平均（2 轮），把路口直角揉成小圆弧（真人过弯非瞬间转向）──
  // 每个顶点位移钳制 ≤0.8m：路口圆角不超过路面半宽，远在道路范围内；
  // 直线段不受影响，仅转角处获得自然的过弯弧度。
  let S = route.map(p => p.slice());
  for (let it = 0; it < 2; it++) {
    const nextS = S.map(p => p.slice());
    for (let i = 1; i < S.length - 1; i++) {
      const mx = S[i - 1][0] * 0.25 + S[i][0] * 0.5 + S[i + 1][0] * 0.25;
      const my = S[i - 1][1] * 0.25 + S[i][1] * 0.5 + S[i + 1][1] * 0.25;
      const dLa = (mx - S[i][0]) * 110540, dLo = (my - S[i][1]) * 88138;
      const d = Math.hypot(dLa, dLo);
      if (d > 0.5) {
        const k = 0.5 / d;
        nextS[i][0] = S[i][0] + (mx - S[i][0]) * k;
        nextS[i][1] = S[i][1] + (my - S[i][1]) * k;
      } else {
        nextS[i][0] = mx;
        nextS[i][1] = my;
      }
    }
    S = nextS;
  }
  // 去除连续重复点（折返节点可能出现），否则样条除零
  const P = [S[0]];
  for (let i = 1; i < S.length; i++) {
    if (havM(S[i], P[P.length - 1]) > 0.5) P.push(S[i]);
  }
  if (P.length < 2) return route;

  const out = [P[0]];
  for (let i = 0; i < P.length - 1; i++) {
    const P1 = P[i], P2 = P[i + 1];
    const P0 = i > 0 ? P[i - 1] : P1;        // 端点虚拟控制点 = 自身（退化为直线）
    const P3 = i < P.length - 2 ? P[i + 2] : P2;
    const segM = havM(P1, P2);
    const n = Math.max(2, Math.ceil(segM / stepM));
    for (let j = 1; j <= n; j++) {
      const u = j / n;
      const pt = crPoint(P0, P1, P2, P3, u);
      out.push([pt[0], pt[1]]);
    }
  }
  return out;
}
