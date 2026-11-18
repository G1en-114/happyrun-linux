/**
 * 伪造跑步轨迹 / 步数 / 陀螺仪数据（重写版）
 *
 * ── 关键修正（来自 detail 页源码还原） ──
 * 真实小程序的跑步点（fullPoints / record.file / OSS 轨迹文件）是【数组】而非对象：
 *
 *   point = [ a, o, s, p, b, c, d, e, l ]
 *            |  |  |  |  |  |  |  |  └─ lose(丢失定位标记, 0/1/null)
 *            |  |  |  |  |  |  |  └─── 第7位 desc(描述字符串, 一般 null)
 *            |  |  |  |  |  |  └────── 第6位 pace(配速, 数字)
 *            |  |  |  |  |  └───────── 第5位 distance(累计距离, 米, int)
 *            |  |  |  |  └──────────── 第4位 isPause(暂停标记 1=null)
 *            |  |  |  └─────────────── 第3位 p(是否离线点/补点, 0/1/null)
 *            |  |  └────────────────── 第2位 s(瞬时速度 m/s)
 *            |  └────────────────────── 第1位 o(longitude 经度)
 *            └───────────────────────── 第0位 a(latitude 纬度)
 *
 * 这正是 setLocation 里 push 的：
 *   [latitude, longitude, speed, isPause?1:null, parseInt(distance), pace, desc, null, lose?1:null]
 *
 * detail 页 fullPoints 计算属性用 w(t,9) 解构成 {a,o,s,p,b,c,d,e,l}，
 * makePolyline 用 t.a/t.o 画线，computePointsSpeed 用相邻点 Haversine 距离算速度上色。
 * 所以文件里必须是数组——旧版 genTrack 生成 {longitude,latitude,time,accuracy} 对象，
 * detail 解构会直接抛错 → 点进去无路径、速度无变化。
 *
 * ── 速度变化设计 v3（结构化真实配速节奏） ──
 * 像一场真人 3km 测试赛：热身（前 ~14% 时间 0.86→0.95×）→ 途中巡航（≈平均配速，
 * 叠加 ±1.2% 慢呼吸波）→ 途中 1~4 次 25~45s 冲刺（1.11×，随里程随机布点）→
 * 末段渐进加速一冲（→1.10×）→ 过线缓收；全程 smoothstep 平滑衔接。
 * 最后整表归一化保证 ∫v dt = 目标距离恰好用时 usedTimeS，
 * 总距离/用时/平均配速与规划严格一致，路线行走不受节奏形状影响。
 *
 * ── 距离设计 ──
 * 总距离 = 目标 × (1 + K%)，保证略大于目标，同时受时间窗约束。
 *
 * ── 路径平滑设计 ──
 * route（路网节点折线）先经 lib/smooth.mjs 的 centripetal Catmull-Rom
 * 加密成穿过全部节点的圆滑曲线（拐角变圆弧，穿点不影响打卡点校验），
 * 再按速度沿曲线推进；GPS 噪声为低频慢漂移（OU 过程）+ 微噪声，
 * 轨迹平滑无锯齿，渲染距离与上报距离差 <0.5%。
 */

import { smoothDensify } from './smooth.mjs';

const EARTH_R = 6378137; // 米（与小程序 calcDistance 用的 6378.137 km 一致）

function toRad(d) {
  return (d * Math.PI) / 180;
}

/** 两点距离（米），与小程序 calcDistance 一致（Haversine, 6378.137km） */
export function calcDistance(lat1, lon1, lat2, lon2) {
  const o = toRad(lat1);
  const a = toRad(lat2);
  const u = o - a;
  const s = toRad(lon1) - toRad(lon2);
  const c = 2 * Math.asin(
    Math.sqrt(Math.pow(Math.sin(u / 2), 2) + Math.cos(o) * Math.cos(a) * Math.pow(Math.sin(s / 2), 2)),
  );
  let v = c * 6378.137;
  v = Math.round(1e4 * v) / 1e4;
  v = v * 1000;
  v = parseFloat(v.toFixed(2));
  return v || 0;
}

/** 线性插值随机数 [min,max) */
function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * 生成一条在跑道区域内、带速度变化的轨迹点序列（数组格式）。
 *
 * @param {object} opts
 * @param {number} opts.centerLat      跑步区域中心纬度
 * @param {number} opts.centerLon      跑步区域中心经度
 * @param {number} opts.targetMeters    目标距离（米）
 * @param {number} opts.usedTimeS      目标用时（秒）
 * @param {number} opts.startTsMs      起始毫秒时间戳
 * @param {number} [opts.loopRadius]   跑道半径（米），用于环形跑道
 * @param {number} [opts.speedChangeN] 速度切换基准间隔（秒）
 * @param {number} [opts.speedChangeM] 速度切换间隔随机抖动（秒）
 * @param {number} [opts.distanceK]    距离目标上浮比例（0.05 表示 +5%）
 * @param {number} [opts.sampleHz]     采样频率（Hz），默认 1Hz
 * @param {boolean} [opts.smooth]      是否对 route 做样条平滑加密（默认 true；false 回退旧折线行为）
 * @param {number} [opts.seed]         （暂未用，保留）
 * @returns {object[]} 轨迹点数组，每个点为 [lat,lon,s,p,dist,pace,desc,null,lose]
 */
export function genTrack(opts) {
  const {
    centerLat,
    centerLon,
    targetMeters,
    usedTimeS,
    startTsMs,
    loopRadius = 200, // 400m 标准跑道外圈半径约 200m
    speedChangeN = 22,
    speedChangeM = 10,
    distanceK = 0.04,
    sampleHz = 1,
    smooth = true,
    zones = { water: [], forbidden: [] }, // 禁区：water=水面(桥段 strict 走廊) forbidden=建筑(轨迹禁止进入)
    clampLim = 0, // 最终贴路钳制距离（米）；0 = 默认 1.0m
    // GPS 精度噪声幅度（米）。真实手机 GPS 精度约 ±3~5m，
    // 但连续读数间位置漂移是【相关】的（不是每步独立跳变），
    // 因此用一阶相关漂移模型：漂移量缓慢游走，使相邻点的地理距离
    // 在真实位移基础上叠加小幅波动，自然跨越 computePointsSpeed
    // 的配色阈值（4.16 m/s），在轨迹图上呈现速度变化，
    // 同时不会显著抬高累计距离。
    jitterM = 4,
  } = opts;

  // ── 1. 生成速度时间序列 v3：结构化真实配速节奏 ──
  // 目标：总距离/总用时/平均配速与规划【完全一致】（归一化 ∫v dt = goalMeters 保证），
  // 路线行走只按每秒速度推进、与节奏形状无关，因此路线/轨迹形状不变；
  // 改变的只有途中的配速分配——像一场真人 3km 测试赛：
  //   热身（前 ~14% 时间）0.80→0.91×：明显偏慢 → 轨迹图绿色
  //   途中巡航 0.91→0.945× 渐进（落在配色带中部 → 黄），叠加 ±1.2% 慢呼吸波
  //   途中 1~4 次 25~45s 冲刺（随里程随机布点、间隔≥150s）→ 红
  //   末段（~86% 起）渐进加速一冲 → 红；最后 ~3% 过线缓收
  // 冲刺深度按【绝对目标速度 5.45 m/s（≈3'04"）】两遍收敛反解：
  // 归一化后峰值恰落在 5.5 m/s 安全夹之下（服务端最快 5.56），
  // 全表不触夹 → 距离/用时积分严格守恒、无平顶无陡沿。speedChangeN/M 参数保留但不再使用。
  const goalMeters = targetMeters * (1 + distanceK);
  // 平均速度（m/s），用于速度区间基准与归一化
  const avgSpeed = goalMeters / usedTimeS;

  const smoothstep = (x) => {
    x = Math.min(1, Math.max(0, x));
    return x * x * (3 - 2 * x);
  };
  const waveAmp = 0.012;
  const wavePeriod = usedTimeS / (2 + Math.random());
  const wavePhase = Math.random() * Math.PI * 2;

  // 构建倍率表（倍率 × avgSpeed = 该秒速度）。锚点为相对平均速度的倍率：
  //   热身起点 ~0.80×（慢端安全夹 2.2 m/s）→ 0.91×：明显偏慢 → 轨迹图绿色
  //   巡航 0.91→0.945× 渐进（≈平均配速略慢，落在配色带中部 → 黄），叠 ±1.2% 呼吸波
  //   冲刺段 D×（随里程随机布 1~4 次、间隔≥150s、25~45s 长）→ 红
  //   末段（~86% 起）一冲至 D-0.01×；最后 ~3% 过线缓收至 0.975×
  const buildTable = (D) => {
    const warmEnd = Math.max(15, Math.min(usedTimeS * 0.14, 90));
    const kickStart = usedTimeS * 0.86;
    const easeStart = usedTimeS * 0.97;
    let wS = Math.max(0.78, Math.min(0.86, 2.2 / avgSpeed));
    // 快配速档（冲刺被 5.45 m/s 绝对上限压住时）自适应加深热身与巡航，
    // 让巡航落在配色带中部（否则快跑全程贴红，层次全无）
    if (D < 1.03) wS = 0.73;
    const cA = D < 1.03 ? Math.max(0.84, 0.91 - (1.03 - D) * 1.35) : 0.91;
    const cB = cA + 0.035;
    const kP = D - 0.01;
    const tbl = new Array(usedTimeS);
    // 冲刺段：次数随时长自适应，位置均分槽位+随机抖动，与热身/末段留足间隔
    const cruiseFrom = Math.ceil(warmEnd + 30);
    const cruiseTo = Math.floor(kickStart - 45);
    const span = cruiseTo - cruiseFrom;
    const nSurge = Math.max(0, Math.min(4, Math.floor(span / 150)));
    const surges = [];
    const slot = span / Math.max(1, nSurge);
    for (let k = 0; k < nSurge; k++) {
      const len = Math.round(25 + Math.random() * 20); // 25~45s
      const s0 = Math.max(cruiseFrom, Math.min(cruiseTo - len, Math.round(cruiseFrom + slot * k + slot * (0.25 + Math.random() * 0.5) - len / 2)));
      surges.push({ s0: Math.max(0, s0 - 10), s1: Math.min(usedTimeS, s0 + len + 10), depth: D * (0.995 + Math.random() * 0.01) });
    }
    for (let t = 0; t < usedTimeS; t++) {
      let m;
      if (t < warmEnd) {
        const hold = warmEnd * 0.35; // 起步先稳住慢速（深绿），再平滑起坡进入巡航
        const u = t < hold ? 0 : (t - hold) / (warmEnd - hold);
        m = wS + (cA - wS) * smoothstep(u);
      }
      else if (t < kickStart) m = cA + (cB - cA) * smoothstep((t - warmEnd) / (kickStart - warmEnd)); // 巡航渐进（黄色中部）
      else if (t < easeStart) m = cB + (kP - cB) * smoothstep((t - kickStart) / (easeStart - kickStart)); // 末段一冲
      else m = kP + (0.975 - kP) * smoothstep((t - easeStart) / Math.max(1, usedTimeS - easeStart)); // 过线缓收
      m *= 1 + waveAmp * Math.sin((2 * Math.PI * t) / wavePeriod + wavePhase);
      for (const s of surges) {
        if (t >= s.s0 && t <= s.s1) {
          const w = smoothstep((t - s.s0) / 10) * (1 - smoothstep((t - (s.s1 - 10)) / 10)); // 进出各 10s 平滑坡
          m = m + (s.depth - m) * w;
        }
      }
      tbl[t] = m;
    }
    return tbl;
  };

  // 冲刺深度定点收敛：归一化后峰值速度 ≡ 5.45 m/s（≈3'04"，红且为全 run 最快档）
  // 归一化后峰值 = D×avgSpeed/mean(D) = 5.45 → D ← 5.45×mean(D)/avgSpeed（两遍收敛）
  let surgeMult = Math.min(1.11, 5.45 / avgSpeed);
  for (let it = 0; it < 5; it++) {
    const tbl = buildTable(surgeMult);
    let mean = 0;
    for (let t = 0; t < usedTimeS; t++) mean += tbl[t];
    mean /= usedTimeS;
    surgeMult = Math.min(1.11, (5.45 * mean) / avgSpeed);
  }

  // 归一化：speed = mult × avgSpeed/mean(mult) → mean(speed) ≡ avgSpeed 精确成立，
  // ∫v dt = goalMeters —— 总距离/用时/平均配速与规划严格一致（峰值 5.45 < 5.55 夹，不触发）
  const speedTable = new Array(usedTimeS);
  {
    const tbl = buildTable(surgeMult);
    let meanMult = 0;
    for (let t = 0; t < usedTimeS; t++) meanMult += tbl[t];
    meanMult /= usedTimeS;
    const k = avgSpeed / meanMult;
    for (let t = 0; t < usedTimeS; t++) {
      speedTable[t] = Math.min(5.55, Math.max(2.0, tbl[t] * k));
    }
  }

  /** 取某时刻的速度（查表，sampleHz=1 时每秒一个值） */
  function targetSpeedAt(t) {
    const i = Math.min(usedTimeS - 1, Math.max(0, Math.floor(t)));
    return speedTable[i];
  }

  // ── 2. 沿路径采样点 ──
  // 若提供 routeNodes（来自 lib/route.mjs 的 planRoute），则沿该节点路径前进；
  // 否则使用椭圆跑道。
  const aRad = loopRadius * 1.2; // 长轴
  const bRad = loopRadius * 0.8; // 短轴
  const latPerM = 1 / (toRad(1) * EARTH_R);
  const lonPerM = 1 / (toRad(1) * EARTH_R * Math.cos(toRad(centerLat)));

  // ── GPS 噪声模型 v2.1：三分量（低频漂移 + 中频摆动 + 微噪声） ──
  // 旧模型每秒随机走 ±jitterM*0.6 米，相邻点横向抖动与跑步位移同量级，
  // 轨迹呈毛刺锯齿状（实测 27% 的采样步转向 >45°），渲染距离还比上报距离
  // 膨胀约 9%。真实手机 GPS 的漂移是【低频】的：几秒~十几秒内缓慢朝一个
  // 方向偏、再慢慢偏回，同时线上有 1~2m 的自然微波（对照真人跑图）。
  //   - 慢分量：OU 过程，幅度上限 jitterM（config.run.jitterM 可调），相关时间 ~20s
  //   - 中频分量：OU 过程 ~0.8m、相关时间 ~4s → 线条的自然微波，不产生锯齿
  //   - 微噪声：每点 ±0.35m 白噪声 → 打破机械感
  //   - 渲染距离与上报距离之差 ~1-2%（与真实跑者一致）
  let driftLat = 0, driftLon = 0;
  let wigLat = 0, wigLon = 0;
  let prevJLat = 0, prevJLon = 0; // 上一秒的最终噪声（增量限幅用）
  let smLat = 0, smLon = 0;       // 低通滤波后的噪声状态（丝滑化）
  let smInit = false;
  const ouK = 0.038; // 慢分量均值回归系数（相关时间约 26 秒，慢悠悠偏出又偏回）
  const ouSigma = jitterM * 0.216; // 步进幅度 → 稳态标准差 ≈ 0.55×jitterM
  const fwK = 0.08; // 中频分量回归系数（相关时间约 12 秒，长波浪而非小抖动）
  const fwSigma = 0.42; // → 稳态标准差 ≈ 0.65m
  const micro = Math.min(0.10, jitterM * 0.05); // 每点微噪声上限（米）——丝滑化：减半
  // ── 禁区引擎：water=水面（桥段轨迹 strict 走廊 ±1.5m）；forbid=建筑（轨迹点禁止进入） ──
  // roadnet.json 的 waterZones/forbiddenZones 多边形（[lon,lat]，OSM 真实轮廓）
  const zoneList = [
    ...(zones.water || []).map(poly => ({ poly, kind: 'water', x0: Math.min(...poly.map(q => q[0])), y0: Math.min(...poly.map(q => q[1])), x1: Math.max(...poly.map(q => q[0])), y1: Math.max(...poly.map(q => q[1])) })),
    ...(zones.forbidden || []).map(poly => ({ poly, kind: 'forbid', x0: Math.min(...poly.map(q => q[0])), y0: Math.min(...poly.map(q => q[1])), x1: Math.max(...poly.map(q => q[0])), y1: Math.max(...poly.map(q => q[1])) })),
  ];
  function inPolyLL(lon, lat, poly) {
    let ins = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) ins = !ins;
    }
    return ins;
  }
  function inZone(lon, lat, kind) {
    for (const z of zoneList) {
      if (z.kind !== kind) continue;
      if (lon < z.x0 - 0.0015 || lon > z.x1 + 0.0015 || lat < z.y0 - 0.0015 || lat > z.y1 + 0.0015) continue;
      if (inPolyLL(lon, lat, z.poly)) return true;
    }
    return false;
  }
  // 带安全边版：进入多边形、或距建筑边界 < marginM(0.8m) 都算"坏"——
  // 保证噪声收缩后轨迹永远与真实楼体保持 ≥0.8m 的物理间隔
  function inZoneMargin(lon, lat, kind, marginM) {
    const mDeg = marginM / (111320 * Math.cos(toRad(lat)));
    const mDegY = marginM / 110540;
    for (const z of zoneList) {
      if (z.kind !== kind) continue;
      if (lon < z.x0 - mDeg || lon > z.x1 + mDeg || lat < z.y0 - mDegY || lat > z.y1 + mDegY) continue;
      if (inPolyLL(lon, lat, z.poly)) return true;
      const mx = 111320 * Math.cos(toRad(lat)), my = 110540;
      let best = Infinity;
      for (let i = 0, j = z.poly.length - 1; i < z.poly.length; j = i++) {
        const ax = (z.poly[i][0] - lon) * mx, ay = (z.poly[i][1] - lat) * my;
        const bx = (z.poly[j][0] - lon) * mx, by = (z.poly[j][1] - lat) * my;
        const sx = bx - ax, sy = by - ay;
        const s2 = sx * sx + sy * sy;
        let t = s2 > 0 ? -(ax * sx + ay * sy) / s2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(ax + t * sx, ay + t * sy);
        if (d < best) best = d;
        if (best < marginM) return true;
      }
    }
    return false;
  }

  function gpsJitterBase(cleanLat, cleanLon, stepM = 3) {
    driftLat += (Math.random() * 2 - 1) * ouSigma - driftLat * ouK;
    driftLon += (Math.random() * 2 - 1) * ouSigma - driftLon * ouK;
    wigLat += (Math.random() * 2 - 1) * fwSigma - wigLat * fwK;
    wigLon += (Math.random() * 2 - 1) * fwSigma - wigLon * fwK;
    // 限制慢漂移不超出 jitterM 范围；中频分量限 ±1.5m
    const mag = Math.sqrt(driftLat * driftLat + driftLon * driftLon);
    if (mag > jitterM) {
      driftLat = (driftLat / mag) * jitterM;
      driftLon = (driftLon / mag) * jitterM;
    }
    const wmag = Math.sqrt(wigLat * wigLat + wigLon * wigLon);
    if (wmag > 1.5) {
      wigLat = (wigLat / wmag) * 1.5;
      wigLon = (wigLon / wmag) * 1.5;
    }
    let lat = driftLat + wigLat + (Math.random() * 2 - 1) * micro;
    let lon = driftLon + wigLon + (Math.random() * 2 - 1) * micro;
    // 增量限幅：噪声的【逐秒变化量】≤ 本步位移的 60%（保底 0.3m）。
    // 渲染位移 = 真实位移 + (噪声_i − 噪声_{i-1})，限增量才能保证
    // 渲染位移永远 ∈ [40%, 160%]×真实位移——杜绝个别秒的"原地毛刺"，
    // 效果等同真实小程序 moveDis 的位移平滑。常规巡航时几乎不触发。
    let dLat = lat - prevJLat;
    let dLon = lon - prevJLon;
    const dmag = Math.sqrt(dLat * dLat + dLon * dLon);
    const cap = Math.max(0.3, stepM * 0.6);
    if (dmag > cap) {
      const k = cap / dmag;
      lat = prevJLat + dLat * k;
      lon = prevJLon + dLon * k;
    }
    // 低通滤波（EMA 0.4）：滤掉逐秒高频抖动，保留慢漂移的长波浪——丝滑关键
    if (!smInit) { smLat = lat; smLon = lon; smInit = true; }
    smLat += (lat - smLat) * 0.4;
    smLon += (lon - smLon) * 0.4;
    lat = smLat;
    lon = smLon;
    prevJLat = lat;
    prevJLon = lon;
    return [lat, lon]; // 米
  }

  /**
   * 在净位置 (cleanLat,cleanLon) 上施加 GPS 噪声，返回度制增量 [dLat, dLon]。
   * 禁区钳制（安全硬约束）：
   *   1. 桥段（净位置在水域多边形内）：噪声幅值钳 ±1.5m —— 轨迹严格贴桥面，
   *      无论去程回程都不会偏到水面上
   *   2. 非桥段：噪声点若落入水域/建筑多边形 → 逐级收缩噪声直至退出禁区
   *      （净位置永远在路上，收缩必然能退出，等效真实 App 的贴路过滤）
   */
  function applyGps(cleanLat, cleanLon, stepM = 3) {
    let [nLat, nLon] = gpsJitterBase(cleanLat, cleanLon, stepM); // 米
    const cleanInWater = inZone(cleanLon, cleanLat, 'water');
    const magCap = cleanInWater ? Math.min(1.5, jitterM) : jitterM;
    let mag = Math.hypot(nLat, nLon);
    if (mag > magCap) {
      nLat *= magCap / mag;
      nLon *= magCap / mag;
    }
    let f = 1;
    const badAt = (fl) => {
      const tLon = cleanLon + nLon * fl * lonPerM;
      const tLat = cleanLat + nLat * fl * latPerM;
      if (inZoneMargin(tLon, tLat, 'forbid', 0.8)) return true;      // 建筑：含 0.8m 安全边
      if (!cleanInWater && inZone(tLon, tLat, 'water')) return true; // 非桥段禁止入水
      return false;
    };
    while (f > 0.05 && badAt(f)) f -= 0.25;
    if (f <= 0.05) f = 0;
    const outLat = nLat * f, outLon = nLon * f;
    prevJLat = outLat;
    prevJLon = outLon;
    return [outLat * latPerM, outLon * lonPerM];
  }

  // 构造路径采样器：输入前进距离 d，返回新坐标 (lat,lon)，并维护内部游标。
  // route 是一组 [lat,lon] 节点序列（可能含重复通过的节点）。
  // 走到序列端点时**沿原路折返**（方向取反），不做任何跨点直线跳转——
  // 规划器已保证路径长度 ≥ 目标距离，折返只是"路径不够长"时的兜底。
  function makePathWalker(route) {
    if (!route || route.length < 2) return null;
    let idx = 0; // 当前所在节点索引
    let dir = 1; // 前进方向：+1 沿序列前进，-1 折返
    let curLat = route[0][0];
    let curLon = route[0][1];
    return function advance(d) {
      let remain = d;
      let guard = 0;
      while (remain > 0 && guard++ < 100000) {
        let nextIdx = idx + dir;
        if (nextIdx < 0 || nextIdx >= route.length) {
          dir = -dir; // 到头/到尾 → 折返（相邻节点仍是路网的真实边）
          nextIdx = idx + dir;
          if (nextIdx < 0 || nextIdx >= route.length) break; // 序列只有一个节点
        }
        const next = route[nextIdx];
        const seg = calcDistance(curLat, curLon, next[0], next[1]);
        if (seg <= remain) {
          remain -= seg;
          curLat = next[0];
          curLon = next[1];
          idx = nextIdx;
        } else {
          const r = remain / (seg || 1e-9);
          curLat = curLat + (next[0] - curLat) * r;
          curLon = curLon + (next[1] - curLon) * r;
          remain = 0;
        }
      }
      // 返回净位置（贴路）；GPS 噪声与禁区钳制由主循环统一施加
      return [curLat, curLon];
    };
  }

  // route 提供时使用，否则用椭圆参数化路径
  // smooth !== false 时先用 Catmull-Rom 样条把节点折线加密成圆滑曲线
  //（穿点特性不影响打卡点校验）；--smooth=false 或 run.smooth:false 回退旧折线。
  const routeSmoothed =
    opts.smooth !== false && Array.isArray(opts.route) && opts.route.length >= 2
      ? smoothDensify(opts.route, { stepM: 3 })
      : opts.route;

  // ── 样条鼓包钳制：急转弯处样条会向外甩出几十米（离路），把每个加密点
  //    拉回原始路线折线 3m 走廊内 —— 平滑度保留、贴路精度拉满 ──
  let walkRoute = routeSmoothed;
  if (Array.isArray(opts.route) && opts.route.length >= 2 && Array.isArray(routeSmoothed) && routeSmoothed.length >= 2) {
    const raw = opts.route;
    const distM = (a, b) => Math.hypot((a[1] - b[1]) * 111320 * Math.cos(toRad((a[0] + b[0]) / 2)), (a[0] - b[0]) * 110540);
    function nearestOnRaw(p) {
      let bd = Infinity, bq = null;
      for (let i = 1; i < raw.length; i++) {
        const a = raw[i - 1], b = raw[i];
        const mLat = 110540, mLon = 111320 * Math.cos(toRad((a[0] + b[0]) / 2));
        const ax = (p[0] - a[0]) * mLat, ay = (p[1] - a[1]) * mLon; // 点相对段起点（米）
        const bx = (b[0] - a[0]) * mLat, by = (b[1] - a[1]) * mLon; // 段向量（米）
        const ab2 = bx * bx + by * by;
        let t = ab2 > 0 ? (ax * bx + ay * by) / ab2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(ax - t * bx, ay - t * by);
        if (d < bd) { bd = d; bq = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]; }
      }
      return { d: bd, q: bq };
    }
    const CORR = 1.0; // 走廊半宽（米）——重合优先：样条最多偏离原始折线 1.0m
    let dbgMax = 0;
    walkRoute = routeSmoothed.map(pt => {
      const r = nearestOnRaw(pt);
      if (r.d <= CORR || !r.q) return pt;
      const k = 1 - CORR / r.d; // 向路线移动 (r.d-CORR)/r.d，拉回后距路线恰为 CORR
      const out = [pt[0] + (r.q[0] - pt[0]) * k, pt[1] + (r.q[1] - pt[1]) * k];
      const dOut = distM(out, r.q);
      if (dOut > dbgMax) dbgMax = dOut;
      return out;
    });
    if (dbgMax > 4) console.log(`[clamp-debug] 钳制后最大残差 ${dbgMax.toFixed(2)}m（应≤3m+舍入）`);
  }
  let walker = makePathWalker(walkRoute);
  let theta = 0;
  let lastLat, lastLon;
  if (walker) {
    lastLat = opts.route[0][0];
    lastLon = opts.route[0][1];
  } else {
    lastLat = centerLat + (aRad * latPerM) * Math.sin(theta);
    lastLon = centerLon + (bRad * lonPerM) * Math.cos(theta);
  }
  const dt = 1 / sampleHz;
  const points = [];
  let totalDist = 0;
  let elapsed = 0;

  // 首点
  points.push([
    +lastLat.toFixed(6),
    +lastLon.toFixed(6),
    +targetSpeedAt(0).toFixed(2),
    null,
    0,
    0,
    null,
    null,
    null,
  ]);

  // 跑到目标距离为止（路网会多圈循环），时间上限 usedTimeS*1.2 防止异常
  const maxElapsed = usedTimeS * 1.2;
  while (totalDist < goalMeters && elapsed < maxElapsed) {
    elapsed += dt;
    const v = targetSpeedAt(Math.min(elapsed, usedTimeS - 1));
    const segDist = v * dt;
    totalDist += segDist;

    let lat, lon;
    if (walker) {
      [lat, lon] = walker(segDist);
    } else {
      // 椭圆跑道
      const avgR = Math.sqrt((aRad * aRad + bRad * bRad) / 2);
      const dTheta = segDist / avgR;
      theta += dTheta;
      lat = centerLat + (aRad * latPerM) * Math.sin(theta);
      lon = centerLon + (bRad * lonPerM) * Math.cos(theta);
    }
    // GPS 噪声 + 禁区钳制（lat/lon 此刻为净位置，永远在路上）
    const [jLat, jLon] = applyGps(lat, lon, segDist);
    lat += jLat;
    lon += jLon;
    if (process.env.HR_DEBUG_DEV) {
      const mLat = 110540, mLon = 111320 * Math.cos(toRad(lat));
      let dNoisy = Infinity;
      for (const n of opts.route) dNoisy = Math.min(dNoisy, Math.hypot((n[0] - lat) * mLat, (n[1] - lon) * mLon));
      if (dNoisy > (global._hrMaxNoisy || 0)) global._hrMaxNoisy = dNoisy;
    }

    // s 字段 ±1.5% 微波动：与 GPS 渲染距离的微小起伏一致，避免速度值过于机械
    const vS = v * (1 + (Math.random() - 0.5) * 0.03);
    const pace = vS > 0 ? Math.round(1000 / vS) : 0;

    points.push([
      +lat.toFixed(6),
      +lon.toFixed(6),
      +vS.toFixed(2),
      null,
      Math.round(totalDist),
      pace,
      null,
      null,
      null,
    ]);
    lastLat = lat;
    lastLon = lon;
  }

  // ── 最终贴路钳制（安全硬约束，保证重合度接近 100%）──
  // 任何轨迹点距规划路线超过 4.5m（水域段超过 1.6m）→ 沿垂线拉回到限值。
  // 钳制基准 = 原始路线折线（opts.route）：样条允许在走廊内摆动，
  // 但贴路精度按原始路线口径保证（原始路线即路网边，视觉上就是路面中心线）。
  // walker 不存在（椭圆兜底）时无路线可贴，跳过。
  if (walker && zoneList.length && walkRoute.length >= 2 && Array.isArray(opts.route) && opts.route.length >= 2) {
    const clampBase = opts.route;
    const walkBoxes = []; // 基准折线分段 bbox（粗筛加速）
    for (let i = 1; i < clampBase.length; i++) {
      const a = clampBase[i - 1], b = clampBase[i];
      walkBoxes.push({
        x0: Math.min(a[1], b[1]) - 0.001, x1: Math.max(a[1], b[1]) + 0.001,
        y0: Math.min(a[0], b[0]) - 0.001, y1: Math.max(a[0], b[0]) + 0.001,
        a, b,
      });
    }
    for (const p of points) {
      const lon = p[1], lat = p[0];
      let bd = Infinity, bq = null;
      for (const seg of walkBoxes) {
        if (lon < seg.x0 || lon > seg.x1 || lat < seg.y0 || lat > seg.y1) continue;
        const mx = 111320 * Math.cos(((seg.a[0] + seg.b[0]) / 2) * toRad(1));
        const r = distPointSegLL(lon, lat, seg.a, seg.b, mx);
        if (r.d < bd) { bd = r.d; bq = r.pt; }
      }
      if (!bq) continue;
      const strictWater = inZone(lon, lat, 'water');
      const lim = clampLim > 0 ? clampLim : 1.0;
      if (bd <= lim) continue;
      const k = lim / bd;
      p[0] = +(bq[0] + (lat - bq[0]) * k).toFixed(6);
      p[1] = +(bq[1] + (lon - bq[1]) * k).toFixed(6);
    }
  }

  if (process.env.HR_DEBUG_DEV && zoneList.length) console.log(`[genTrack] 轨迹对路线最大偏离: ${(global._hrMaxNoisy || 0).toFixed(1)}m（含噪声后）`);
  return points;
}

/** 点 [lon,lat] 到线段（[lat,lon] 端点）的距离与最近点，mx 为该处经度米系数 */
function distPointSegLL(lon, lat, aLL, bLL, mx) {
  // A = a-p、D = b-a（米）；最近点参数 t = -(A·D)/|D|²，夹到 [0,1]
  const ax = (aLL[1] - lon) * mx, ay = (aLL[0] - lat) * 110540;
  const dx = (bLL[1] - aLL[1]) * mx, dy = (bLL[0] - aLL[0]) * 110540;
  const dd = dx * dx + dy * dy;
  let t = dd > 0 ? -(ax * dx + ay * dy) / dd : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = aLL[1] + t * (bLL[1] - aLL[1]), qy = aLL[0] + t * (bLL[0] - aLL[0]);
  return { d: Math.hypot(ax + t * dx, ay + t * dy), pt: [qy, qx] };
}

/**
 * 生成步数切片 —— 复刻真实小程序 step_info 格式。
 *
 * 真实小程序（pages_run/app-service.js）：
 *   - 跑步时每 60s 把累积的陀螺仪样本 O 传给 calculateSteps，结果 push 进 step_info
 *   - record getter: step_info: JSON.stringify({interval:60, list: e.step_info})
 *   - step_num: e.step_info.reduce((a,b)=>a+b, 0) || 1
 *
 * step_info 的 list 每项 = 每 60s 窗口的估算步数。
 * 真实跑步步频约 150 步/分钟，因此每窗口约 150 步。
 * 实测服务端对 step_num 不做严格校验（step_num=83 的骑行记录也通过），
 * 因此只需生成合理的真实跑步步数即可。
 *
 * @param {number} usedTimeS 用时秒
 * @param {number} distanceKm 距离公里（用于推算合理步频）
 * @returns {{step_info: string, step_num: number}}
 */
export function genSteps(usedTimeS, distanceKm) {
  const intervals = Math.max(1, Math.ceil(usedTimeS / 60));
  const avgPace = (distanceKm * 1000) / usedTimeS; // m/s
  // 步频随速度缓升：3'20"/km(5m/s)≈203 步/分（步幅 1.5m），慢跑≈190 —— 真实跑步区间
  const stepsPerMin = Math.round(Math.min(215, Math.max(165, 170 + avgPace * 6.5)));
  const list = [];
  for (let i = 0; i < intervals; i++) {
    // 每分钟步数有 ±10% 波动；最后一个窗口按剩余秒数折算
    const jitter = Math.floor((Math.random() - 0.5) * stepsPerMin * 0.2);
    const remainS = usedTimeS - i * 60;
    const frac = Math.min(1, Math.max(0.2, remainS / 60));
    list.push(Math.max(1, Math.round((stepsPerMin + jitter) * frac)));
  }
  const step_num = list.reduce((a, b) => a + b, 0) || 1;
  return {
    step_info: JSON.stringify({ interval: 60, list }),
    step_num,
  };
}

/**
 * 生成伪造陀螺仪数据 —— 复刻真实小程序采集逻辑。
 *
 * 真实采集（pages_run/app-service.js）：
 *   - listenerAcc: 每次 onAccelerometerChange，若距上次 ≥60ms，push
 *       O.push({ t: Date.now(), ax, ay, az, gx, gy, gz })
 *     其中 ax/ay/az = 加速度计值，gx/gy/gz = 最近一次 onGyroscopeChange 的陀螺仪值。
 *   - 采样间隔 ≈60ms（实测加速度计 interval:"game"≈20ms，但代码限流 ≥60ms → 约 16Hz）。
 *   - endRecordStep: setMap({ gyr: JSON.stringify(O), step_info: [...] })，清空 O。
 *   - buildRecord: record.gyr = e.gyr （JSON 字符串）。
 *   - uploadRecord 补传: createTxt(record.gyr) 直接写明文 JSON 字符串（不加密）→ OSS。
 *
 * 因此真实陀螺仪文件内容是【明文 JSON 字符串】，每个样本为
 *   { t: <毫秒时间戳>, ax, ay, az, gx, gy, gz }
 *   ax/ay/az: 加速度计 (m/s²)，重力 ≈9.8，跑步有 1~3 的波动
 *   gx/gy/gz: 陀螺仪 (rad/s)，静止 ≈0，跑步小幅波动 ±0.5
 *
 * @param {number} usedTimeS 用时秒
 * @param {number} [startTsMs] 起始毫秒时间戳（用于 t 字段），默认 Date.now()
 * @param {object} [opts]
 * @param {boolean} [opts.asString] 返回 JSON.stringify 后的字符串（真实 record.gyr 形态），默认 false（返回数组）
 * @returns {Array<object>|string} 陀螺仪样本数组或其 JSON 字符串
 */
export function genGyro(usedTimeS, startTsMs = Date.now(), opts = {}) {
  const { asString = false } = opts;
  // 真实采样间隔 60ms → 约 16.67Hz；用 60ms 步进。
  const intervalMs = 60;
  const samples = Math.floor((usedTimeS * 1000) / intervalMs);
  const list = [];
  let t = startTsMs;

  // 步频参数：约 2.5 步/秒（150 步/分钟，跑步步频），周期 ≈0.4s
  // 60ms 采样 → 每步约 6.7 个采样点
  const stepPeriod = 6.7; // 采样点数/步
  // 每步的加速度冲击：垂直方向(az)有明显的冲击峰，ax/ay 有小幅摇摆
  // 步态模型：每步一个主冲击 + 一个次要冲击（脚跟落地 + 脚趾离地）
  for (let i = 0; i < samples; i++) {
    const phase = (i % stepPeriod) / stepPeriod; // 0~1 循环
    // 主冲击（脚跟落地，phase≈0）：az 突增 + 噪声
    // 次冲击（脚趾离地，phase≈0.5）：az 次峰
    const heelStrike = Math.exp(-Math.pow((phase - 0.05) * 8, 2)); // 高斯峰
    const toeOff = Math.exp(-Math.pow((phase - 0.55) * 10, 2)) * 0.5;

    // 加速度计（m/s²）：重力 9.8 在 az，步态冲击叠加
    const az = +(9.8 + heelStrike * 3.5 + toeOff * 1.5 + (Math.random() - 0.5) * 0.3).toFixed(3);
    // 水平方向小幅摇摆（走路时身体左右摆）
    const sway = Math.sin(i / stepPeriod * 2 * Math.PI) * 0.6;
    const ax = +(sway + (Math.random() - 0.5) * 0.4).toFixed(3);
    const ay = +(Math.cos(i / stepPeriod * 2 * Math.PI) * 0.3 + (Math.random() - 0.5) * 0.3).toFixed(3);

    // 陀螺仪（rad/s）：跑步时角速度小幅波动
    // 真实跑步陀螺仪各轴约 ±0.1~0.5 rad/s，步态冲击时短暂升高
    const gyroPhase = Math.sin(i / stepPeriod * 2 * Math.PI);
    const gx = +(gyroPhase * 0.25 + (Math.random() - 0.5) * 0.1).toFixed(3);
    const gy = +(Math.cos(i / stepPeriod * 2 * Math.PI) * 0.2 + (Math.random() - 0.5) * 0.08).toFixed(3);
    const gz = +(Math.sin(i / (stepPeriod * 2) * 2 * Math.PI) * 0.1 + (Math.random() - 0.5) * 0.05).toFixed(3);

    list.push({ t, ax, ay, az, gx, gy, gz });
    t += intervalMs;
  }
  return asString ? JSON.stringify(list) : list;
}

// ── 向后兼容旧签名 genTrack(centerLat, centerLon, distanceKm, usedTimeS, startTsMs) ──
export function genTrackLegacy(centerLat, centerLon, distanceKm, usedTimeS, startTsMs = Date.now()) {
  return genTrack({
    centerLat,
    centerLon,
    targetMeters: distanceKm * 1000,
    usedTimeS,
    startTsMs,
  });
}

/**
 * 统计速度变化次数：按 0.2 m/s 分桶，跨越不同桶的次数。
 * 用于校验"速度有变化"。
 * @param {number[][]} points genTrack 返回的点数组
 */
export function countSpeedChanges(points) {
  if (points.length < 2) return 0;
  const sp = points.map((p) => p[2]);
  let changes = 0;
  let lastBucket = Math.round(sp[0] / 0.2);
  for (let i = 1; i < sp.length; i++) {
    const bucket = Math.round(sp[i] / 0.2);
    if (bucket !== lastBucket) {
      changes++;
      lastBucket = bucket;
    }
  }
  return changes;
}
