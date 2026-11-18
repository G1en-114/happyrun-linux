/**
 * happyrun 自动乐跑主入口
 *
 * 用法（三种）：
 *   node auto-run.mjs                  # 默认：读 config.json，跑自由跑
 *   node auto-run.mjs --type=free      # 自由跑（stopFreeRunV220），测试用
 *   node auto-run.mjs --type=formal    # 正式跑（stopRunV278），需打卡点，落地用
 *
 * config.json 由方案 A 抓包得到（在小程序登录一次，导出 vuex 持久化数据）：
 *   {
 *     "school_id": 1001, "term_id": 1, "course_id": 99, "class_id": 50,
 *     "student_num": "2024xxxx", "card_id": "2024xxxx",  // card_id 同学号
 *     "uid": "xxxx", "token": "xxxx",
 *     "baseUrl": "https://tyxyzhpt.tyut.edu.cn"
 *   }
 *
 * 跑步目标参数可在 config.json 的 "run" 字段覆盖：
 *   "run": { "distanceKm": 2.5, "usedTimeS": 900, "centerLat": 37.87, "centerLon": 112.55 }
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnProc } from 'node:child_process';
import { createClient, AuthExpiredError } from './lib/client.mjs';
import { encrypt } from './lib/signer.mjs';
import { genTrack, genSteps, genGyro, calcDistance, countSpeedChanges } from './lib/track.mjs';
import { planPace, fmtPace } from './lib/pace.mjs';
import { getOssSts, uploadByPostObject, ossKeyFromUrl, runRecordKey, gyroscopeKey } from './lib/oss.mjs';
import { pickRecord, fixStartTime, buildRecord } from './lib/record.mjs';
import { planRoute, planRunRouteNet } from './lib/route.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const CONFIG_PATH = path.join(ROOT, 'config.json');

function log(...a) {
  console.log('[happyrun]', ...a);
}

// ── 实时状态文件（watch.sh 每秒读取）与本地有效次数台账（按账号分文件） ──
const STATUS_PATH = path.join(ROOT, 'formal-run.status.json');
let ACCOUNT_KEY = 'default';
let runStartMs = 0;   // 跑步开始时刻（用于台账记录） // 当前账号键（student_num 优先，uid 兜底），runOnce 里设置

function writeStatus(patch) {
  try {
    let prev = {};
    if (fs.existsSync(STATUS_PATH)) {
      prev = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
    }
    fs.writeFileSync(STATUS_PATH, JSON.stringify({ ...prev, ...patch, account: ACCOUNT_KEY, pid: process.pid, updatedAt: Date.now() }));
  } catch {}
}

function saveHistory(entry) {
  try {
    const histPath = path.join(ROOT, `run-history-${ACCOUNT_KEY}.jsonl`);
    let n = 0;
    if (fs.existsSync(histPath)) {
      n = fs.readFileSync(histPath, 'utf8').split('\n').filter((l) => l.trim()).length;
    }
    const rec = { n: n + 1, time: new Date(Date.now() + 8 * 3600000).toISOString().replace('Z',''), account: ACCOUNT_KEY, ...entry };
    fs.appendFileSync(histPath, JSON.stringify(rec) + '\n');
    log(`📋 台账已保存（账号 ${ACCOUNT_KEY} 第 ${n + 1} 次）: ${JSON.stringify(entry).slice(0, 160)}`);
  } catch (e) {
    log(`⚠ 台账写入失败: ${e.message}`);
  }
}

function sleepWithStatus(ms, info) {
  const t0 = Date.now();
  const totalS = Math.round(ms / 1000);
  // 距离投影曲线：优先用真实轨迹的累计距离（含热身/冲刺节奏，与最终轨迹逐秒一致）；
  // 无轨迹数据时退化为「热身-巡航-收尾」近似权重
  const cumKmAt = (() => {
    const cc = Array.isArray(info.cumCurve) ? info.cumCurve : null;
    if (cc && cc.length > 1) {
      return (u) => {
        const x = Math.min(1, Math.max(0, u)) * (cc.length - 1);
        const j = Math.floor(x);
        const f = x - j;
        return (cc[j] + (cc[Math.min(cc.length - 1, j + 1)] - cc[j]) * f) / 1000;
      };
    }
    const N = 200;
    const cum = [0];
    for (let i = 1; i <= N; i++) {
      const u = (i - 0.5) / N;
      const w = u < 0.12 ? 0.78 + 0.22 * (u / 0.12) : (u > 0.85 ? 1 - 0.05 * ((u - 0.85) / 0.15) : 1);
      cum.push(cum[i - 1] + w);
    }
    const wTotal = cum[N];
    return (u) => {
      const x = Math.min(N, Math.max(0, u * N));
      const i = Math.floor(x);
      const f = x - i;
      return (info.finalKm || 0) * (cum[i] + (cum[Math.min(N, i + 1)] - cum[i]) * f) / wTotal;
    };
  })();
  return new Promise((resolve) => {
    const tick = () => {
      const el = Date.now() - t0;
      if (el >= ms) {
        writeStatus({ phase: 'uploading', elapsedS: totalS, simKm: info.finalKm });
        return resolve();
      }
      const frac = el / ms;
      const simKm = +cumKmAt(frac).toFixed(3);
      const curPaceS = Math.round((el / 1000) / Math.max(simKm, 0.05));
      writeStatus({ phase: 'running', elapsedS: Math.round(el / 1000), totalS, simKm, curPaceS });
      setTimeout(tick, 1000);
    };
    tick();
  });
}

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
  }
  return args;
}

function loadConfig() {
  // config.json 不存在时回退 config.template.json：凭证为空 → 探活失败 →
  // start.sh 自动弹出抓包窗口走登录流程（首次使用 / 删掉 config.json 换号更顺滑）
  if (!fs.existsSync(CONFIG_PATH)) {
    const tpl = path.join(ROOT, 'config.template.json');
    if (fs.existsSync(tpl)) {
      log('⚠ 未找到 config.json，暂用模板占位（凭证为空）。请先完成「登录抓包」获取登录态。');
      return JSON.parse(fs.readFileSync(tpl, 'utf8'));
    }
    throw new Error(`缺少 config.json（方案 A 抓包导出）。请先在小程序登录一次，导出 vuex 数据后写入 ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 完整跑步流程（run.md §四时序）：
 *   0. 登录态校验（createClient 已内置白名单）
 *   1. beforeRunV260  → 地图配置/规则
 *   2. getTimestampV278 → 服务端时间戳 + 离线打卡点
 *   3. (可选) getStudentVenaPoint / getVenaPointInfo → 打卡点（正式跑）
 *   4. 本地构造 record
 *   5. (distance>0.2) OSS 上传轨迹文件
 *   6. stopRunV278 / stopFreeRunV220 上传记录
 *   7. (成功且 distance>0.2) 补传陀螺仪
 */
async function runOnce(opts) {
  const cfg = loadConfig();
  const { type, run } = opts;
  const baseUrl = cfg.baseUrl || 'https://tyxyzhpt.tyut.edu.cn';
  const common = {
    school_id: cfg.school_id,
    term_id: cfg.term_id,
    course_id: cfg.course_id,
    class_id: cfg.class_id,
    student_num: cfg.student_num,
    card_id: cfg.card_id || cfg.student_num,
    uid: cfg.uid,
    token: cfg.token,
  };
  const client = createClient({ baseUrl, common });

  const isFormal = type === 'formal';
  // 账号键：台账与实时状态按账号区分，换号后各自从头计数
  ACCOUNT_KEY = String(cfg.student_num || cfg.uid || 'default').replace(/[^\w.\-]/g, '_');
  writeStatus({ phase: 'starting' });
  log(`模式: ${isFormal ? '正式跑 (stopRunV278)' : '自由跑 (stopFreeRunV220)'} | 账号: ${ACCOUNT_KEY}`);
  log(`common: school_id=${common.school_id} uid=${common.uid} student_num=${common.student_num}`);

  const args0 = parseArgs();
  const dryRun = args0.dryRun === true || args0.dryRun === 'true' || args0['dry-run'] === true || args0['dry-run'] === 'true';

  if (dryRun) {
    // dry-run：不等待不上传，但拉 beforeRunV260 获取打卡点做校验
    log('🧪 dry-run 模式：不等待不上传，仅校验轨迹是否经过打卡点');
    const distMinKm = Number(run.distanceMinKm != null ? run.distanceMinKm : 3.0);
    const distMaxKm = Number(run.distanceMaxKm != null ? run.distanceMaxKm : 3.35);
    const baseDistKm = Number(args0.dist) || +(distMinKm + Math.random() * (distMaxKm - distMinKm)).toFixed(3);
    const distanceK = Number(args0.distK) || (run.distanceK != null ? run.distanceK : 0.04);
    const distJitter = (args0.distJitter != null && !isNaN(Number(args0.distJitter))) ? Number(args0.distJitter) : (run.distJitter != null ? run.distJitter : 0.02);
    const distKReal = +(distanceK + Math.random() * distJitter).toFixed(4);
    const usedS = Math.max(60, Math.round((Number(run.timeAnchorS) || 643) + (Math.random() * 2 - 1) * (Number(run.timeJitterS) || 8)));
    log(`目标 ${baseDistKm}km（距离带随机）→ 用时 ${usedS}s，配速 ${Math.round(usedS / baseDistKm)}s/km`);

    // 拉打卡点（复刻真实小程序按距离选择，非随机）
    let venaPointsLocal = [];
    try {
      const before = await client.post('Run2/beforeRunV260', {});
      // ── 有效时段校验：时段外跑步会被判「无效成绩」，直接拦截保护次数 ──
      const tr0 = (before.time_rule_arr || [])[0];
      const mkToday = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return Math.floor(d.getTime() / 1000); };
      let stT = mkToday(6, 0), enT = mkToday(22, 30), srcName = "默认 6:00–22:30";
      if (tr0 && Number(tr0.start_time) > 0 && Number(tr0.end_time) > 0) {
        stT = Number(tr0.start_time); enT = Number(tr0.end_time); srcName = "服务端规则";
      }
      const nowS = Math.floor(Date.now() / 1000);
      const fmt = (t) => new Date(t * 1000).toTimeString().slice(0, 5);
      if (nowS < stT || nowS > enT) {
        log('❌ 当前不在有效跑步时段（' + srcName + '：' + fmt(stT) + '–' + fmt(enT) + '），此时上传会被判「无效成绩」，已拦截');
        writeStatus({ phase: 'aborted', reason: '不在有效跑步时段（' + fmt(stT) + '–' + fmt(enT) + '）' });
        if (!isFormal) { return null; }
        console.error('');
        console.error('  ❌ 已拦截：当前不在有效跑步时段（' + fmt(stT) + ' – ' + fmt(enT) + '）');
        console.error('  时段外跑步会被判「无效成绩」。请在 ' + fmt(stT) + ' – ' + fmt(enT) + ' 内重新开始跑步。');
        process.exit(1);
        }
        log('✓ 有效时段校验通过（' + srcName + '：' + fmt(stT) + '–' + fmt(enT) + '）');

      const rli = before.run_line_info;
      const rules = before.time_rule_arr || [];
      const rule = rules[0];
      const pointNum = rule ? (Number(rule.point_num_online) || Number(rule.min_log_num) || 0) : 0;
      const maxDist1 = Number(rli && rli.point_max_distance1) || 1.0; // km
      const maxDist2 = Number(rli && rli.point_max_distance2) || 2.0; // km
      if (rli && Array.isArray(rli.point_list) && pointNum > 0) {
        // 参考点：优先用路网起点；否则用 before.lat/lon；最后回退 config 中心
        let refLat, refLon;
        if (opts.roadnet) {
          try {
            const netPath0 = path.isAbsolute(opts.roadnet) ? opts.roadnet : path.join(ROOT, opts.roadnet);
            const net0 = JSON.parse(fs.readFileSync(netPath0, 'utf8'));
            refLat = net0.nodes && net0.nodes[0] ? net0.nodes[0][1] : null;
            refLon = net0.nodes && net0.nodes[0] ? net0.nodes[0][0] : null;
          } catch {}
        }
        if (refLat == null) { refLat = before.lat || run.centerLat; refLon = before.lon || run.centerLon; }
        const allPts = rli.point_list.map((p) => {
          const [lat, lon] = p.jingwei.split(',').map(Number);
          const calcDisKm = calcDistance(refLat, refLon, lat, lon) / 1000;
          return { point_id: p.id, lat, lon, address: p.address, type: Number(p.type) || 2, calcDis: calcDisKm };
        });
        function shuffle(a){ return [...a].sort(()=>Math.random()-0.5); }
        const mustPts = allPts.filter(p=>p.type===1);
        const normalPts = allPts.filter(p=>p.type===2);
        function pick(pool){
          const n=mustPts.length; let r=n?1:0; const i=pointNum-normalPts.length;
          if(i>1) r=Math.min(i,n);
          return [...shuffle(mustPts).slice(0,r||0), ...shuffle(pool).slice(0,pointNum-r)];
        }
        let sel = pick(normalPts.filter(p=>p.calcDis<=maxDist1));
        if(sel.length<pointNum) sel = pick(normalPts.filter(p=>p.calcDis<=maxDist2));
        if(sel.length<pointNum) sel = pick(normalPts);
        sel = sel.slice(0, pointNum);
        venaPointsLocal = sel.map(p=>[p.lat,p.lon]);
        log(`打卡点: 需 ${pointNum} 个（min_log_num=${rule?.min_log_num}），服务端下发 ${allPts.length} 个，参考点(${refLat.toFixed(5)},${refLon.toFixed(5)})`);
        log(`  距离阈值 max1=${maxDist1}km max2=${maxDist2}km`);
        for (const p of sel) log(`  ${p.point_id}: ${p.address} (${p.lat},${p.lon}) 距参考点 ${p.calcDis.toFixed(2)}km type=${p.type}`);
      }
    } catch (e) {
      log(`⚠ 拉打卡点失败: ${e.message || e}`);
    }

    let routeNodes = null;
    let trackZones = { water: [], forbidden: [] }; // 禁区（从 roadnet.json 读入）
    if (opts.roadnet) {
      const netPath = path.isAbsolute(opts.roadnet) ? opts.roadnet : path.join(ROOT, opts.roadnet);
      const net = JSON.parse(fs.readFileSync(netPath, 'utf8'));
      trackZones = { water: net.waterZones || [], forbidden: net.forbiddenZones || [] };
      const netNodes = (net.nodes || []).map((ll) => [ll[1], ll[0]]);
      const netEdges = net.edges || [];
      if (venaPointsLocal.length === 0) {
        venaPointsLocal = (net.venaPoints || []).map(v => [v.lat, v.lon]).filter(g => g[0] && g[1]);
      }
      // 识别打卡点在路网中的节点索引（新节点 = 路网末尾的 checkpoint 节点），
      // 供 planRunRouteNet 优先经过未访问的打卡点。
      const checkpointNodes = [];
      const venaObjs = net.venaPoints || [];
      for (let i = net.nodes.length; i < netNodes.length; i++) {
        // netNodes[i] = [lat, lon]，venaObjs 对应 checkpoint 节点
        checkpointNodes.push(i);
      }
      const targetM = baseDistKm * 1000 * (1 + distKReal);
      const idxSeq = planRunRouteNet(netNodes, netEdges, venaPointsLocal, targetM, { checkpointNodes, goalMaxOffM: 85 });
      if (idxSeq && idxSeq.length >= 2) routeNodes = idxSeq.map((i) => netNodes[i]);
      log(`路网规划: ${netNodes.length} 节点 / ${netEdges.length} 边 -> ${idxSeq?.length || 0} 序列, 目标点 ${venaPointsLocal.length} 个`);
    }
    const points = genTrack({
      centerLat: run.centerLat, centerLon: run.centerLon,
      targetMeters: baseDistKm * 1000, usedTimeS: usedS, startTsMs: Date.now(),
      speedChangeN: Number(args0.speedN) || 22, speedChangeM: Number(args0.speedM) || 10,
      distanceK: distKReal, sampleHz: 1,
      jitterM: (args0.jitterM != null && !isNaN(Number(args0.jitterM))) ? Number(args0.jitterM) : 3,
      smooth: args0.smooth != null ? args0.smooth !== 'false' : run.smooth !== false,
      zones: trackZones,
    route: routeNodes,
    });
    const dist = points.length ? points[points.length - 1][4] : 0; const sp = points.map(p => p[2]);
    log(`生成 ${points.length} 点，距离 ${dist.toFixed(0)}m，速度 ${Math.min(...sp).toFixed(2)}~${Math.max(...sp).toFixed(2)} 变化${countSpeedChanges(points)}次`);

    // 校验：离每个目标点最近的路网端点是否被经过
    if (routeNodes && venaPointsLocal.length > 0) {
      const netPath2 = path.isAbsolute(opts.roadnet) ? opts.roadnet : path.join(ROOT, opts.roadnet);
      const netNodes = (JSON.parse(fs.readFileSync(netPath2,'utf8')).nodes||[]).map(ll=>[ll[1],ll[0]]);
      let passOk = 0;
      for (let gi = 0; gi < venaPointsLocal.length; gi++) {
        const [glat, glon] = venaPointsLocal[gi];
        let nearestIdx = 0, nearestD = Infinity;
        for (let ni = 0; ni < netNodes.length; ni++) {
          const d = calcDistance(netNodes[ni][0], netNodes[ni][1], glat, glon);
          if (d < nearestD) { nearestD = d; nearestIdx = ni; }
        }
        const [nlat, nlon] = netNodes[nearestIdx];
        // 该端点是否在生成的路径中（轨迹点30m内）
        let minDist = Infinity;
        for (const p of points) minDist = Math.min(minDist, calcDistance(p[0], p[1], nlat, nlon));
        const ok = minDist < 30;
        log(`  目标点 ${gi}: (${glat.toFixed(5)},${glon.toFixed(5)}) 最近端点#${nearestIdx}(${nearestD.toFixed(1)}m) 轨迹最近 ${minDist.toFixed(1)}m ${ok ? '✅' : '⚠️'}`);
        if (ok) passOk++;
      }
      log(`目标点经过: ${passOk}/${venaPointsLocal.length} ${passOk === venaPointsLocal.length ? '✅' : '⚠️'}`);
    } else {
      log('无目标点（venaPoints为空），跳过经过校验');
    }
    log(`✅ dry-run 完成（未上传，正式跑默认所有目标点均经过）`);
    return;
  }

  // ── 0. 登录态校验 + 补全缺失的 term_id / course_id ──
  // 用白名单接口 UserInfo 探活（不触发登录态校验逻辑分支差异），同时补 common
  try {
    const userInfo = await client.post('WpLogin/UserInfo', {});
    log(`登录态有效，用户: ${JSON.stringify(userInfo).slice(0, 120)}`);
    // UserInfo 响应可能补全 school_id/class_id/student_num/uid
    if (userInfo && typeof userInfo === 'object') {
      for (const k of ['school_id', 'class_id', 'student_num', 'uid']) {
        if (userInfo[k] != null && !common[k]) common[k] = userInfo[k];
      }
    }
  } catch (e) {
    if (e instanceof AuthExpiredError) {
      log('❌ 登录失效，请重新抓包导出 config.json（uid/token 已过期）');
      return;
    }
    throw e;
  }

  // 补 term_id：getTermList 返回数组，取 status=="1"（当前学期）或第一项
  if (!common.term_id) {
    try {
      const termList = await client.post('WpRun/getTermList', {});
      const arr = Array.isArray(termList) ? termList : [termList];
      // 优先取 status=="1" 的当前学期，否则取第一项
      const term = arr.find((t) => String(t.status) === '1') || arr[0];
      if (term && (term.term_id || term.id)) {
        common.term_id = term.term_id || term.id;
        log(`自动补 term_id = ${common.term_id}（来自 getTermList，${term.term_name || ''}）`);
      }
    } catch (e) {
      log(`⚠ getTermList 失败，term_id 留空: ${e.message || e}`);
    }
  }

  // 补 course_id：beforeRunV260 可能下发，在步骤 1 里处理
  log(`common 已就绪: school_id=${common.school_id} term_id=${common.term_id ?? '(空)'} course_id=${common.course_id ?? '(空)'} uid=${common.uid} student_num=${common.student_num}`);

  // ── 1. 开跑前预检 ──
  const before = await client.post('Run2/beforeRunV260', {});
  log(`beforeRunV260: ${JSON.stringify(before).slice(0, 200)}`);
  // beforeRunV260 可能下发 course_id / game_id / areaCode
  if (before && typeof before === 'object') {
    if (!common.course_id && (before.course_id || before.courseId)) {
      common.course_id = before.course_id || before.courseId;
      log(`自动补 course_id = ${common.course_id}（来自 beforeRunV260）`);
    }
  }
  const areaCode = before.game_id || before.areaCode || before.gameId || (run && run.areaCode);
  if (!areaCode) throw new Error('无法从 beforeRunV260 解析 game_id/areaCode，请在 config.run 里指定 areaCode');
  // 跑区中心：优先用 before.run_zone_latlng 围栏质心（服务端下发的真实跑区），
  // 其次 config.run.centerLat/centerLon，最后默认。
  let centerLat = run.centerLat ?? 37.87;
  let centerLon = run.centerLon ?? 112.55;
  const zoneLatLngs = before.run_zone_latlng;
  if (Array.isArray(zoneLatLngs) && zoneLatLngs.length >= 1) {
    // 围栏点格式 "lon,lat"
    let sumLat = 0, sumLon = 0;
    for (const z of zoneLatLngs) {
      const [lo, la] = String(z).split(',').map(Number);
      if (!isNaN(la) && !isNaN(lo)) { sumLat += la; sumLon += lo; }
    }
    if (sumLat && sumLon) {
      centerLat = +(sumLat / zoneLatLngs.length).toFixed(6);
      centerLon = +(sumLon / zoneLatLngs.length).toFixed(6);
      log(`跑区中心取自 run_zone_latlng 质心: (${centerLat},${centerLon})`);
    }
  }

  // ── 2. 服务端时间戳 + 离线打卡点（第一次取，仅用于拿 offlinePoints + 启动基准）──
  // 注意：getTimestampV278 不能带 point_ids 参数（实测带 point_ids 会返回"非法请求"）
  // 真实响应：{ timestamp, str, location_septal, offlinePoints }
  // 实测服务端时钟比本地慢约 140s，不能直接用本地墙钟算时间窗口。
  const tsRes = await client.post('Run/getTimestampV278', { game_id: areaCode });
  log(`getTimestampV278(第一次): ${JSON.stringify(tsRes).slice(0, 200)}`);
  const firstServerTs = Number(tsRes.timestamp) || Math.floor(Date.now() / 1000);
  // 用时/距离支持 CLI 覆盖（--time --dist），并应用时间变数
  const args = parseArgs();
  // ── 智能配速模式 ──
  // 不显式传 --time（或 --time=0）时：距离/用时在路线规划完成后按打卡点布局自动决定，
  // 平均配速随机落在 run.paceMinS~paceMaxS（默认 210~230 s/km = 3'30"~3'50"）带内。
  // 显式传 --time 时退回固定用时模式（旧行为）。
  const explicitTime = Number(args.time) > 0 ? Number(args.time) : null;
  const smartPace = !explicitTime;
  const baseTime = explicitTime || run.usedTimeS;
  const timeJitterM = Number(args.timeJitterM) || (run.timeJitterM != null ? run.timeJitterM : 5);
  const jit = (Math.random() * 2 - 1) * (timeJitterM / 100);
  let usedS = Math.max(10, Math.round(baseTime * (1 + jit)));
  // ── 距离带：无 --dist 时每次在 [distanceMinKm, distanceMaxKm]（默认 3.00~3.35km）内随机取 ──
  // 距离越长本次配速越快（见 planPace），总用时保持在锚点附近（均衡但有差异）
  const distMinKm = Number(run.distanceMinKm != null ? run.distanceMinKm : 3.0);
  const distMaxKm = Number(run.distanceMaxKm != null ? run.distanceMaxKm : 3.35);
  let baseDistKm = Number(args.dist) || +(distMinKm + Math.random() * (distMaxKm - distMinKm)).toFixed(3);
  // 距离上浮：K + Random(0~distJitter)%（K 是基准上浮，distJitter 是额外随机）——仅固定用时模式使用
  const distanceK = Number(args.distK) || (run.distanceK != null ? run.distanceK : 0.04);
  const distJitter = (args.distJitter != null && !isNaN(Number(args.distJitter))) ? Number(args.distJitter) : (run.distJitter != null ? run.distJitter : 0.02);
  const distKReal = +(distanceK + Math.random() * distJitter).toFixed(4);
  // 智能模式距离已随机化（距离带），不再额外上浮
  const upliftK = smartPace ? 0 : +(0.015 + Math.random() * 0.015).toFixed(4);

  // ── 3. 打卡点（正式跑） ──
  // 打卡点来自 beforeRunV260.run_line_info.point_list（服务器下发）。
  // 选择算法复刻真实小程序 setClocks 逻辑（app-service.js）：
  //   pointList = run_line_info.point_list，按 type 分两类：
  //     type==1 必经点(mustPointList)，type==2 普通点(normalPointList)
  //   选择 c(t)：
  //     r = mustPointList.length ? 1 : 0; i = pointNum - normalPointList.length;
  //     if (i>1) r = min(i, mustPointList.length);
  //     取 shuffle(mustPointList).slice(0, r) ++ shuffle(t).slice(0, pointNum - r)
  //   t = normalPointListDis1（calcDis <= point_max_distance1），
  //   若不足 pointNum 再放宽到 normalPointListDis2（calcDis <= point_max_distance2）。
  //   calcDis = 起跑点(当前 GPS 位置) 到打卡点的距离。
  // 注意：打卡点数量来自 time_rule_arr[].point_num_online 或 min_log_num，非 run_line_info.point_num。
  let pointList = [];
  let passPoints = [];
  if (isFormal) {
    const rli = before.run_line_info;
    // 从 time_rule_arr 取打卡点数量（取当前时段的，否则取第一条）
    let pointNum = 0;
    const now = Date.now() / 1000;
    const rules = before.time_rule_arr || [];
    const rule = rules.find((r) => Number(r.start_time) <= now && now <= Number(r.end_time)) || rules[0];
    if (rule) {
      pointNum = Number(rule.point_num_online) || Number(rule.min_log_num) || 0;
    }
    if (!pointNum && rli) pointNum = Number(rli.point_num) || 0;

    if (rli && Array.isArray(rli.point_list) && rli.point_list.length > 0 && pointNum > 0) {
      const updateDist = Number(rli.point_update_distance) || 0.5; // km
      // 距离阈值（服务端下发）
      const maxDist1 = Number(rli.point_max_distance1) || 1.0; // km
      const maxDist2 = Number(rli.point_max_distance2) || 2.0; // km
      // 参考点：起跑位置 = 跑道中心（与路网起点一致）
      const refLat = centerLat;
      const refLon = centerLon;

      // 解析所有可选打卡点，并按 type 分类、计算到参考点的距离
      const allPts = rli.point_list.map((p) => {
        const [lat, lon] = p.jingwei.split(',').map(Number);
        const calcDisKm = calcDistance(refLat, refLon, lat, lon) / 1000;
        return {
          point_id: p.id, id: p.id, latitude: lat, longitude: lon, address: p.address,
          type: Number(p.type) || 2, is_online: p.is_online, index: p.index,
          calcDis: calcDisKm,
        };
      });
      const mustPts = allPts.filter((p) => p.type === 1);   // 必经点
      const normalPts = allPts.filter((p) => p.type === 2);  // 普通点
      // 复刻真实选择函数 c(t)
      function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
      function pickByDistance(pool) {
        const n = mustPts.length;
        let r = n ? 1 : 0;
        const i = pointNum - normalPts.length;
        if (i > 1) r = Math.min(i, n);
        const mustPick = shuffle(mustPts).slice(0, r || 0);
        const normalPick = shuffle(pool).slice(0, pointNum - r);
        return [...mustPick, ...normalPick];
      }
      // 先用近距离(<=maxDist1)，不足再放宽到 <=maxDist2
      const near1 = normalPts.filter((p) => p.calcDis <= maxDist1);
      const near2 = normalPts.filter((p) => p.calcDis <= maxDist2);
      let selected = pickByDistance(near1);
      if (selected.length < pointNum) selected = pickByDistance(near2);
      // 兜底：仍不足则从全部普通点取
      if (selected.length < pointNum) selected = pickByDistance(normalPts);

      passPoints = selected.slice(0, pointNum);
      pointList = passPoints.map((p) => ({ point_id: p.point_id, ...p }));
      log(`打卡点: 需 ${pointNum} 个（time_rule min_log_num=${rule?.min_log_num || 'N/A'}），服务端下发 ${allPts.length} 个（必经 ${mustPts.length}/普通 ${normalPts.length}）`);
      log(`  距离阈值: point_max_distance1=${maxDist1}km point_max_distance2=${maxDist2}km 参考点(${refLat},${refLon})`);
      log(`  近距离(<=${maxDist1}km) ${near1.length} 个，放宽(<=${maxDist2}km) ${near2.length} 个，每 ${updateDist}km 分配一个`);
      for (const p of pointList) log(`  ${p.point_id}: ${p.address} (${p.latitude},${p.longitude}) 距参考点 ${p.calcDis.toFixed(2)}km type=${p.type}`);
    }
    if (pointList.length === 0) {
      log('❌ 正式跑未取到打卡点，中止（不上传记录）');
      writeStatus({ phase: 'aborted', reason: '未取到打卡点' });
      saveHistory({ kind: 'formal', result: 'aborted', reason: '未取到打卡点' });
      return;
    }
  }

  // ── 3.5 路网规划（提前到"等待"之前）──
  // 目的点必须全部走完，A* 沿路网走完后路径可能比目标距离长；
  // 先把路径定下来，据此上调距离/用时，再按最终用时等待（is_check_time 用同一 usedS）。
  let routeNodes = null;
  let routeLenM = 0;        // 路径总长（含补距离）
  let routeMandatoryM = 0;  // 必到里程（走完目标点 + 闭环）
  let routeGoalsM = 0;      // 纯必到里程（无打卡点时为 0，供配速规划用）
  let trackZones = { water: [], forbidden: [] }; // 禁区（从 roadnet.json 读入）
  if (opts.roadnet) {
    const netPath = path.isAbsolute(opts.roadnet) ? opts.roadnet : path.join(ROOT, opts.roadnet);
    if (!fs.existsSync(netPath)) throw new Error(`道路网文件不存在: ${netPath}`);
    const net = JSON.parse(fs.readFileSync(netPath, 'utf8'));
    trackZones = { water: net.waterZones || [], forbidden: net.forbiddenZones || [] };
    const netNodes = (net.nodes || []).map((ll) => [ll[1], ll[0]]); // [lon,lat]->[lat,lon]
    const netEdges = net.edges || [];
    // 目标点：正式跑用步骤3选中的打卡点；自由跑尝试拉服务端打卡点
    let venaGoals = [];
    if (isFormal && passPoints.length > 0) {
      venaGoals = passPoints
        .map((p) => [Number(p.latitude != null ? p.latitude : p.lat), Number(p.longitude != null ? p.longitude : p.lon)])
        .filter((g) => g[0] && g[1]);
      log(`路网规划: 复用步骤3打卡点 ${venaGoals.length} 个作为目标`);
    } else if (!isFormal) {
      try {
        const vena = await client.post('Run2/getVenaPointInfo', {}, { flag: true });
        const list = vena && Array.isArray(vena.list) ? vena.list : Array.isArray(vena) ? vena : [];
        venaGoals = list
          .map((p) => [Number(p.latitude != null ? p.latitude : p.lat), Number(p.longitude != null ? p.longitude : p.lon)])
          .filter((g) => g[0] && g[1]);
        log(`路网规划: 自由跑服务端打卡点 ${venaGoals.length} 个作为目标`);
      } catch (e) {
        log(`路网规划: 自由跑取打卡点失败，无目标点规划: ${e.message || e}`);
      }
    }
    const targetM = baseDistKm * 1000 * (1 + (smartPace ? upliftK : distKReal));
    // 识别打卡点在路网中的节点索引（新增 checkpoint 节点位于路网末尾）
    const checkpointNodes = [];
    if (net.venaPoints && net.venaPoints.length > 0) {
      for (let i = (net.nodes || []).length; i < netNodes.length; i++) checkpointNodes.push(i);
    }
    const meta = {};
    const idxSeq = planRunRouteNet(netNodes, netEdges, venaGoals, targetM, { checkpointNodes, meta, goalMaxOffM: 85 });
    if (idxSeq && idxSeq.length >= 2) {
      routeNodes = idxSeq.map((i) => netNodes[i]);
      for (let i = 1; i < routeNodes.length; i++) {
        routeLenM += calcDistance(routeNodes[i - 1][0], routeNodes[i - 1][1], routeNodes[i][0], routeNodes[i][1]);
      }
      // 必到里程 = 走完全部目标点时的里程（不含补距离的游走）；距离不够时才用 totalM
      routeMandatoryM = Number(meta.mandatoryM) || routeLenM;
      routeGoalsM = Number(meta.mandatoryM) || 0;
      log(`路网规划: ${netNodes.length} 节点 / ${netEdges.length} 边 -> ${idxSeq.length} 序列；必到里程 ${routeMandatoryM.toFixed(0)}m（含补足共 ${routeLenM.toFixed(0)}m，目标 ${targetM.toFixed(0)}m，达标 ${meta.reachedTarget ? '是' : '否'}）`);
      // 目标点没进路径 = 轨迹必然不经过该打卡点 = 上传后必判"打卡点异常"，宁可不上传
      const skippedGoals = Array.isArray(meta.skippedGoals) ? meta.skippedGoals : [];
      if (isFormal && skippedGoals.length > 0) {
        for (const s of skippedGoals) {
          log(`❌ 打卡点 (${Number(s.goal[0]).toFixed(5)},${Number(s.goal[1]).toFixed(5)}) 无法纳入路网路径：${s.why}`);
        }
        log('❌ 该记录若上传必被判"打卡点异常"，本次中止（打卡点是随机选的，重跑一次通常会换一组）');
        writeStatus({ phase: 'aborted', reason: '打卡点无法纳入路网路径' });
        saveHistory({ kind: 'formal', result: 'aborted', reason: `打卡点无法纳入路网路径（${skippedGoals.length}个）` });
        return;
      }
    } else {
      log(`路网规划失败，回退默认 genTrack`);
    }
  }

  // ── 3.6 智能配速规划（路线定了才定距离/用时）──
  // 距离：max(距离带随机目标, 必到里程×1.01)——打卡点远时跟着走完，绝不低于带下限；
  // 配速：随距离【反比】—— 用时 = 锚点(默认643s)±抖动，pace = 用时/距离，
  //       跑得越长配速越快（3.0km→约3'29"，3.35km→约3'16"），总用时均衡（±15s 差异）。
  //       pace 落在 [paceMinS, paceMaxS]（默认 195~210 s/km = 3'15"~3'30"）带内。
  // usedS 在此定型：后面的真实等待 / 时间窗口 / record.used_time 全部用它，墙钟校验自洽。
  if (smartPace) {
    const paceMinS = Number(run.paceMinS) || 195;
    const paceMaxS = Number(run.paceMaxS) || 210;
    const plan = planPace({
      mandatoryM: routeGoalsM,
      targetKm: baseDistKm,
      paceMinS, paceMaxS,
      timeAnchorS: Number(run.timeAnchorS) || 643,
      timeJitterS: Number(run.timeJitterS) || 8,
    });
    baseDistKm = plan.finalKm;
    usedS = plan.usedS;
    log(`智能配速: 必到里程 ${(routeGoalsM / 1000).toFixed(2)}km（占最终距离 ${(plan.ratio * 100).toFixed(0)}%）→ 最终 ${plan.finalKm}km / ${usedS}s，平均配速 ${fmtPace(plan.paceSPK)}/km（带内 ${fmtPace(paceMinS)}~${fmtPace(paceMaxS)}，距离越长配速越快）`);
  } else if (routeNodes && routeMandatoryM > baseDistKm * 1000 * (1 + distKReal) * 1.005) {
    // 固定用时模式（显式 --time）：路径比目标距离长（目标点必须走完，不截断）→ 距离/用时等比放大
    const needKm = +(routeMandatoryM * 1.02 / 1000).toFixed(3);
    const k = needKm / baseDistKm;
    let grownS = Math.round(usedS * k);
    // 配速必须留在服务端规则区间内（min_pace=上限秒/km，max_pace=下限秒/km）
    const ruleNow = (before.time_rule_arr || []).find((r) => Number(r.start_time) <= Date.now() / 1000 && Date.now() / 1000 <= Number(r.end_time)) || (before.time_rule_arr || [])[0] || {};
    const paceMax = Number(ruleNow.min_pace) || 420; // 最慢（秒/km 越大越慢）
    const paceMin = Number(ruleNow.max_pace) || 180; // 最快
    grownS = Math.min(Math.max(grownS, Math.round(paceMin * needKm)), Math.round(paceMax * needKm));
    log(`⚠ 目标点路径 ${(routeMandatoryM / 1000).toFixed(2)}km 超过目标 ${baseDistKm}km → 距离上调到 ${needKm}km、用时 ${usedS}s→${grownS}s（保持配速 ${(grownS / needKm).toFixed(0)}s/km）`);
    baseDistKm = needKm;
    usedS = grownS;
  }

  // ── 4. 真实等待 used_time 秒（is_check_time 要求墙钟耗时 >= used_time）──
  // 从第一次 getTimestampV278 调用时刻起算
  const waitStart = Date.now();
  const serverFirstMs = firstServerTs * 1000;
  // 估算：要等到「服务端时间 >= firstServerTs + usedS」，即本地墙钟等 usedS 秒
  //（因为服务端时钟虽慢但匀速，本地墙钟等 usedS 秒后服务端也走过 usedS 秒）
  const waitMs = usedS * 1000 + 5000; // +5s 余量
  if (smartPace) {
    log(`目标 ${baseDistKm}km（距离带 ${distMinKm}~${distMaxKm}km 随机，距离越长配速越快）→ 用时 ${usedS}s，平均配速 ${fmtPace(usedS / baseDistKm)}/km（智能规划，每次不同）`);
  } else {
    log(`目标 ${baseDistKm}km +${(distanceK*100).toFixed(0)}%~+${((distanceK+distJitter)*100).toFixed(0)}% → 实际距离上浮 ${(distKReal*100).toFixed(1)}%`);
    log(`基准 ${baseTime}s → 实际用时 ${usedS}s (±${timeJitterM}%)`);
  }
  runStartMs = Date.now() - usedS * 1000;   // 跑步开始 = 当前 - 用时
  log(`等待 ${Math.round(waitMs / 1000)}s 模拟真实跑步耗时（is_check_time 校验），可用 watch.sh 实时查看...`);
  // ── 轨迹预生成（在等待前完成，供实时轨迹图逐秒渲染）──
  // genTrack 是纯计算，不依赖真实时间。提前生成后等待期间实时轨迹图可逐秒渲染。
  const distanceKm = baseDistKm;
  const points = genTrack({
    centerLat, centerLon,
    targetMeters: distanceKm * 1000,
    usedTimeS: usedS,
    startTsMs: waitStart,
    loopRadius: run.loopRadius || 200,
    speedChangeN: Number(args.speedN) || run.speedChangeN || 22,
    speedChangeM: Number(args.speedM) || run.speedChangeM || 10,
    distanceK: smartPace ? 0 : distKReal,
    sampleHz: 1,
    jitterM: (args.jitterM != null && !isNaN(Number(args.jitterM))) ? Number(args.jitterM) : (run.jitterM != null ? run.jitterM : 3),
    smooth: args.smooth != null ? args.smooth !== 'false' : run.smooth !== false,
    zones: trackZones,
    route: routeNodes,
  });
  const { step_info, step_num } = genSteps(usedS, distanceKm);
  const realDistM = points.length ? points[points.length - 1][4] : 0;
  const realDistKm = +(realDistM / 1000).toFixed(3);
  log(`轨迹已预生成 ${realDistM.toFixed(1)}m / ${realDistKm}km（目标 ${distanceKm}km），实时轨迹图数据已写入`);

  // 写实时轨迹文件（watch 网页每秒轮询此文件渲染进度）
  try {
    fs.writeFileSync(path.join(ROOT, 'formal-run.track.json'), JSON.stringify({
      z: 18,
      points: points.map(p => [+p[0].toFixed(7), +p[1].toFixed(7)]),
      usedS,
      targetKm: distanceKm,
      plannedPace: fmtPace(usedS / distanceKm),
      passPoints: (pointList || []).map(p => ({ id: String(p.point_id), name: p.address || '', lat: p.latitude || p.lat, lon: p.longitude || p.lon })),
    }));
  } catch (e) { log('实时轨迹文件写入失败(不影响跑步): ' + e.message); }

  // 状态文件初始写入：watch.sh 据此显示实时进度/配速/预计完成时刻
  // 注意：epoch 字段统一用【秒】（watch.sh 按 ToUnixTimeSeconds() 对比），别用毫秒
  writeStatus({
    phase: 'running',
    kind: isFormal ? 'formal' : 'free',
    targetKm: baseDistKm,
    plannedPace: fmtPace(usedS / baseDistKm),
    usedS,
    waitStartEpoch: Math.floor(waitStart / 1000),
    runEtaEpoch: Math.floor(waitStart / 1000) + usedS,          // 跑完（距离完成）预计时刻
    doneEtaEpoch: Math.floor(waitStart / 1000) + Math.round(waitMs / 1000) + 12, // 含上传/陀螺仪
    simKm: 0,
    curPaceS: Math.round(usedS / baseDistKm),
    pointNum: pointList.length,
    mandatoryKm: +(routeGoalsM / 1000).toFixed(2),
  });
  // 实时进度投影用真实累计距离曲线（每 15s 取样 + 末点），含热身/冲刺节奏，逐秒一致
  const cumCurve = points.length ? points.filter((_, i) => i % 15 === 0).map(p => p[4]) : null;
  if (cumCurve && points.length) cumCurve.push(points[points.length - 1][4]);
  await sleepWithStatus(waitMs, { finalKm: baseDistKm, cumCurve });

  // ── 4.5 等待期间刷新登录态 ──
  // 长等待（20 分钟级）可能跨越 token 寿命；等待期间若重新抓包/登录，
  // config.json 会写入新 token，这里在提交前重新读取并切换，避免提交时报登录失效。
  try {
    const cfgNow = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfgNow.token && cfgNow.token !== common.token) {
      common.token = cfgNow.token;
      if (cfgNow.uid) common.uid = cfgNow.uid;
      log('检测到等待期间登录态已更新，提交前采用新 token');
    }
  } catch {}

  // ── 5. 重新取服务端时间，用它定位时间窗口 ──
  // 服务端时钟与本地有偏移，用最新服务端时间作为 end_time 基准最准
  const tsRes2 = await client.post('Run/getTimestampV278', { game_id: areaCode });
  const endTsSec = Number(tsRes2.timestamp) || Math.floor(Date.now() / 1000);
  const startTsSec = endTsSec - usedS;
  const startTsMs = startTsSec * 1000;
  log(`时间窗口: start=${startTsSec} (${new Date(startTsMs).toISOString()}) end=${endTsSec} 用时=${usedS}s`);

  // 回填正式跑打卡点 time（基于确定的 startTsSec）
  if (isFormal && pointList.length > 0) {
    const n = pointList.length;
    pointList = pointList.map((p, i) => ({
      ...p,
      time: String(Math.floor(startTsSec + (usedS * (i + 1)) / (n + 1))),
    }));
  }

  // ── 6. 轨迹与步频已在步骤 4 等待前预生成（points / step_info / realDistM），
  //      实时轨迹图在等待期间即可逐秒渲染；这里只按服务端时间窗口回填打卡点。──

  // 回填正式跑打卡点：**位置和时刻都必须取自轨迹上真实采集的那个点**。
  //
  // 真实小程序（pages_run/app-service.js）在离打卡点 disFrom <= autoUpdateDis(即 log_max_distance)
  // 的那一刻记一次打卡，写入 clocks[i].query_data：
  //     { distance, latitude: 当前GPS纬度, longitude: 当前GPS经度, point_id, time: parseInt(Date.now()/1e3) }
  // 即上报的打卡位置 = 【进入打卡半径时的那个 GPS 点】，不是打卡点自身坐标。
  // 服务端存下来的 point_list 只有 longitude/latitude 没有 time，说明它是用上报坐标去反查轨迹：
  // 位置不是轨迹上的点 -> record_failed_reason="打卡点异常"（实测 8 条记录：脚本上传 0.0m 偏差全异常，
  // 真实 App 上报 90~99m 偏差全通过）。
  if (isFormal && pointList.length > 0) {
    const logMaxDistance = Number(before.run_line_info && before.run_line_info.log_max_distance) || 100; // 米
    // 起跑 200m 内不打卡（客户端 beforePass = 1e3*distance > 200，且 DX 有 dis 门槛）
    const MIN_PASS_M = 200;
    pointList = pointList.map((p) => {
      const cLat = p.latitude != null ? p.latitude : p.lat;
      const cLon = p.longitude != null ? p.longitude : p.lon;
      let firstInIdx = -1; // 首次进入 log_max_distance 半径
      let okInIdx = -1;    // 首次进入且已跑过 MIN_PASS_M
      let nearIdx = 0, nearD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = calcDistance(points[i][0], points[i][1], cLat, cLon);
        if (d < nearD) { nearD = d; nearIdx = i; }
        if (d <= logMaxDistance) {
          if (firstInIdx < 0) firstInIdx = i;
          if (okInIdx < 0 && points[i][4] >= MIN_PASS_M) okInIdx = i;
        }
      }
      const idx = okInIdx >= 0 ? okInIdx : (firstInIdx >= 0 ? firstInIdx : nearIdx);
      const passTime = Math.floor(startTsSec + (idx / points.length) * usedS);
      const pLat = points[idx][0], pLon = points[idx][1];
      return {
        ...p,
        latitude: pLat,        // ★ 上报位置 = 轨迹上的点（原来的写法是打卡点自身坐标）
        longitude: pLon,
        time: String(passTime),
        _passIdx: idx,
        _passDist: calcDistance(pLat, pLon, cLat, cLon),
        _nearDist: nearD,
      };
    });
    // 按轨迹实际经过顺序输出：真实客户端 log_data 的 time 是递增的（打卡点被逐段解锁），
    // 而我们的选择顺序是随机的，直接上报会出现 "time 非单调" 这种机器特征（实测 12/12 轮都会）。
    pointList.sort((a, b) => a._passIdx - b._passIdx);
    log(`打卡点上报名单（位置取轨迹点；半径 ${logMaxDistance}m 首次进入，按经过顺序）：`);
    for (const p of pointList) {
      log(`  ${p.point_id}: 上报(${p.latitude},${p.longitude}) = 轨迹#${p._passIdx}(累计 ${points[p._passIdx][4]}m, 约 ${p._passIdx}s) 距打卡点 ${p._passDist.toFixed(1)}m | 轨迹最近 ${p._nearDist.toFixed(1)}m time=${p.time}`);
    }
  }

  const record = buildRecord({
    common,
    type: isFormal ? 1 : 2,
    game_id: areaCode,
    start_time_sec: startTsSec,
    end_time_sec: endTsSec,
    distance: realDistKm,
    used_time: usedS,
    points,
    step_info,
    step_num,
    point_list: pointList,
    mobileModel: cfg.mobileModel || 'iPhone14,3',
  });
  // 陀螺仪：真实小程序 record.gyr 是 JSON.stringify([{t,ax,ay,az,gx,gy,gz}]) 字符串，
  // 补传时 createTxt(record.gyr) 直接写明文（不加密）。
  record.gyr = genGyro(usedS, startTsMs, { asString: true });

  // ── 7. 上传 OSS 轨迹文件（等待已结束，这段时间不占跑步时间窗口）──
  let sts = null;
  if (record.distance > 0.2) {
    sts = await getOssSts(client);
    const fileKey = runRecordKey(startTsMs);
    // record.file 已是对象格式 [{a,o,s,p,b,c,d,e,l}]（detail 页用 t.a/t.o 取值）
    const fileB64 = encrypt(JSON.stringify(record.file));
    const fileUrl = await uploadByPostObject(sts, fileKey, fileB64);
    record.record_file = ossKeyFromUrl(fileUrl);
    log(`轨迹文件已上传 OSS: ${record.record_file}`);
  }

  // ── 7. 白名单过滤 + start_time 容差 + 上传 ──
  const payload = pickRecord(record);
  fixStartTime(payload, record);
  log(`上传 payload: ${JSON.stringify(payload).slice(0, 200)}`);

  const result = isFormal
    ? await client.post('Run/stopRunV278', payload, { flag: true })
    : await client.post('Run/stopFreeRunV220', payload, { flag: true });

  if (!result) {
    log('上传返回 falsy（flag 接口静默失败），可能当日已达标或参数被拒');
    writeStatus({ phase: 'done', result: 'rejected', reason: '上传返回 falsy（可能当日已达标）' });
    saveHistory({ kind: 'formal', result: 'rejected', reason: '上传返回 falsy（可能当日已达标）', distance_km: realDistKm, used_time_s: usedS });
    return;
  }
  if (result === 'has') {
    log('✅ 本次跑步记录已存在（has），无需重复');
    writeStatus({ phase: 'done', result: 'duplicate', reason: '当日已有记录' });
    saveHistory({ kind: 'formal', result: 'duplicate', reason: '当日已有记录', distance_km: realDistKm, used_time_s: usedS });
    return;
  }
  log(`上传成功，返回: ${JSON.stringify(result).slice(0, 200)}`);
  writeStatus({ phase: 'done', result: 'success', distance_km: realDistKm, used_time_s: usedS, pace: fmtPace(usedS / realDistKm) + '/km' });
  saveHistory({
    kind: 'formal',
    result: 'success',
    distance_km: realDistKm,
    used_time_s: usedS,
    pace: fmtPace(usedS / realDistKm) + '/km',
    pace_s_per_km: +(usedS / realDistKm).toFixed(1),
    point_num: pointList.length,
    record_id: result.record_id || null,
  });

  // ── 8. 补传陀螺仪（distance>0.2 且拿到 record_id） ──
  // 真实小程序（app-service.js uploadRecord）：
  //   createTxt(record.gyr)  ← 明文 JSON 字符串，不加密
  //   uploadGyr → uploadToOSS(filePath, "Public/Upload/file/run_gyroscope/<末3位>", true)
  //   → 返回完整 OSS key（isFile=true 时返回相对 key，含 Public/Upload/file/ 前缀）
  //   gyroscope({ record_id, gyroscope_file: <完整 OSS key> })  ← 不剥离前缀
  if (result.record_id && record.distance > 0.2) {
    if (!sts) sts = await getOssSts(client);
    const gyrKey = gyroscopeKey();
    // record.gyr 已是 JSON 字符串，明文写入（不加密），与真实 createTxt(record.gyr) 一致
    const gyrContent = typeof record.gyr === 'string' ? record.gyr : JSON.stringify(record.gyr);
    const gyrUrl = await uploadByPostObject(sts, gyrKey, gyrContent);
    // 真实小程序传【完整 OSS key】（含 Public/Upload/file/ 前缀），不剥离
    const gyrFileKey = gyrUrl.split('?')[0].includes('Public/Upload/file/')
      ? gyrUrl.split('?')[0].substring(gyrUrl.split('?')[0].indexOf('Public/Upload/file/'))
      : gyrKey;
    const gyrResult = await client.post('Run2/gyroscope', {
      record_id: result.record_id,
      gyroscope_file: gyrFileKey,
    });
    // client.post 的返回值语义（client.mjs:90-105）：
    //   null  = HTTP 200 + status:1 + data 为空 → 接口已接受（写接口正常就是空响应，不是失败）
    //   {..}  = status:1 + data 有内容（该接口不会）
    //   抛错  = status≠1 的业务错误（未传 flag，不会被静默成 false）
    if (gyrResult === null) {
      log(`陀螺仪已补传: ok（服务端 status=1、data 为空，属正常空响应）gyroscope_file=${gyrFileKey} record_id=${result.record_id}`);
    } else if (gyrResult === false) {
      log(`⚠ 陀螺仪补传被静默拒绝（flag 接口返回 false）gyroscope_file=${gyrFileKey}`);
    } else {
      log(`陀螺仪已补传: ${JSON.stringify(gyrResult).slice(0, 120)}`);
    }
  }

  log('🎉 完成');
}

// ───────── CLI ─────────

async function main() {
  const args = parseArgs();
  const type = args.type === 'formal' ? 'formal' : 'free';
  const cfg = loadConfig();
  const run = Object.assign(
    { distanceKm: 3.0, usedTimeS: 700, centerLat: 37.87, centerLon: 112.55 },
    cfg.run || {},
  );
  try {
    if (args.preview) {
      await previewOnly({ type, run });
    } else {
      await runOnce({ type, run, roadnet: args.roadnet });
    }
  } catch (e) {
    if (e instanceof AuthExpiredError) {
      log('❌ 登录失效，请重新抓包导出 config.json');
      process.exit(2);
    }
    console.error(e);
    process.exit(1);
  }
}

/**
 * 仅本地构建（--preview）：不连服务端、不等待、不上传。
 * 按 config.run + 可调速度/距离参数生成一条 record，写入 record-preview.json，
 * 并校验轨迹点格式（数组 [a,o,s,p,b,c,d,e,l]）、速度是否有变化、距离是否达标。
 *
 * 用法：node auto-run.mjs --preview [--speedN=45 --speedM=20 --distK=0.04 --radius=200]
 */
async function previewOnly(opts) {
  const cfg = loadConfig();
  const args = parseArgs();
  const { run } = opts;
  const speedChangeN = Number(args.speedN) || 22;
  const speedChangeM = Number(args.speedM) || 10;
  const distanceK = Number(args.distK) || 0.04;
  // 距离上浮随机部分：K + Random(0~distJitter)
  const distJitter = (args.distJitter != null && !isNaN(Number(args.distJitter))) ? Number(args.distJitter) : (run.distJitter != null ? run.distJitter : 0.02);
  const distKReal = +(distanceK + Math.random() * distJitter).toFixed(4);
  // 智能配速模式（不显式传 --time 时）：按打卡点布局决定距离/用时
  const explicitTime = Number(args.time) > 0 ? Number(args.time) : null;
  const smartPace = !explicitTime;
  const upliftK = smartPace ? 0 : +(0.015 + Math.random() * 0.015).toFixed(4);
  const loopRadius = Number(args.radius) || run.loopRadius || 200;
  // 距离带：无 --dist 时在 [distanceMinKm, distanceMaxKm]（默认 3.00~3.35km）内随机取
  const distMinKm = Number(run.distanceMinKm != null ? run.distanceMinKm : 3.0);
  const distMaxKm = Number(run.distanceMaxKm != null ? run.distanceMaxKm : 3.35);
  let distanceKm = Number(args.dist) || +(distMinKm + Math.random() * (distMaxKm - distMinKm)).toFixed(3);
  // 时间变数：usedTimeS ± Random(0~timeJitterM)%
  const timeJitterM = Number(args.timeJitterM) || (run.timeJitterM != null ? run.timeJitterM : 5);
  const baseTime = explicitTime || run.usedTimeS;
  const jit = (Math.random() * 2 - 1) * (timeJitterM / 100); // [-M%, +M%]
  let usedS = Math.round(baseTime * (1 + jit));
  const minTime = Number(args.minTime) || 10;
  if (usedS < minTime) usedS = minTime;
  const startTsMs = Date.now();

  log('预览模式（不连服务端）：');
  log(`  中心 ${run.centerLat},${run.centerLon} 目标 ${distanceKm}km 用时 ${usedS}s (基准 ${baseTime}s ±${timeJitterM}%)`);
  log(`  速度切换 N=${speedChangeN}±${speedChangeM}s 距离上浮 +${(distanceK*100).toFixed(0)}%~+${((distanceK+distJitter)*100).toFixed(0)}% (实际 +${(distKReal*100).toFixed(1)}%)`);

  // 用寻路算法在跑道区域构建一条路径（基于 Map.png 操场区域）
  let routeNodes = null;
  let trackZones = { water: [], forbidden: [] }; // 禁区（从 roadnet.json 读入）
  // 服务器打卡点（目标点），运行时从服务器拉取
  let venaGoals = null;

  if (args.roadnet) {
    // 用手画道路网文件
    const netPath = path.isAbsolute(args.roadnet) ? args.roadnet : path.join(ROOT, args.roadnet);
    if (!fs.existsSync(netPath)) throw new Error(`道路网文件不存在: ${netPath}`);
    const net = JSON.parse(fs.readFileSync(netPath, 'utf8'));
    trackZones = { water: net.waterZones || [], forbidden: net.forbiddenZones || [] };
    const netNodes = (net.nodes || []).map((ll) => [ll[1], ll[0]]); // [lon,lat] -> [lat,lon]
    const netEdges = net.edges || [];
    log(`  道路网: ${netNodes.length} 节点 / ${netEdges.length} 边（来自 ${path.basename(netPath)}）`);

    // 运行时从服务器拉取打卡点作为目标点
    const fetchVena = args.fetchVena !== false && run.fetchVena !== false;
    if (fetchVena) {
      try {
        const baseUrl = cfg.baseUrl || 'https://tyxyzhpt.tyut.edu.cn';
        const common = {
          school_id: cfg.school_id, term_id: cfg.term_id, course_id: cfg.course_id,
          class_id: cfg.class_id, student_num: cfg.student_num,
          card_id: cfg.card_id || cfg.student_num, uid: cfg.uid, token: cfg.token,
        };
        const client = createClient({ baseUrl, common });
        const vena = await client.post('Run2/getVenaPointInfo', {}, { flag: true });
        const list = vena && Array.isArray(vena.list) ? vena.list : Array.isArray(vena) ? vena : [];
        venaGoals = list
          .map((p) => [Number(p.latitude != null ? p.latitude : p.lat), Number(p.longitude != null ? p.longitude : p.lon)])
          .filter((g) => g[0] && g[1]);
        log(`  服务器打卡点(目标): ${venaGoals.length} 个`);
      } catch (e) {
        log(`  ⚠ 取打卡点失败（忽略，无目标点规划）: ${e.message || e}`);
        venaGoals = [];
      }
    }

    // 本地回退：服务端没取到打卡点时，用路网自带的 venaPoints 随机抽
    // min(3, n) 个当目标，让预览路径也带"随机 3 个打卡点"的绕行形状
    if (!venaGoals || venaGoals.length === 0) {
      const vp = (net.venaPoints || []).map((v) => [v.lat, v.lon]).filter((g) => g[0] && g[1]);
      if (vp.length > 0) {
        const n = Math.min(3, vp.length);
        venaGoals = [...vp].sort(() => Math.random() - 0.5).slice(0, n);
        log(`  本地打卡点(目标): ${venaGoals.length} 个（来自 roadnet.venaPoints）`);
      }
    }

    const targetM = distanceKm * 1000 * (1 + (smartPace ? upliftK : distanceK));
    const meta = {};
    const idxSeq = planRunRouteNet(netNodes, netEdges, venaGoals, targetM, { meta, goalMaxOffM: 85 });
    if (idxSeq && idxSeq.length >= 2) {
      routeNodes = idxSeq.map((i) => netNodes[i]);
      log(`  规划路径: ${idxSeq.length} 节点序列（必到里程 ${((meta.mandatoryM || 0) / 1000).toFixed(2)}km）`);
    } else {
      log(`  ⚠ 道路网规划失败，回退椭圆`);
    }
    if (smartPace) {
      const plan = planPace({
        mandatoryM: Number(meta.mandatoryM) || 0,
        targetKm: distanceKm,
        paceMinS: Number(run.paceMinS) || 195,
        paceMaxS: Number(run.paceMaxS) || 210,
        timeAnchorS: Number(run.timeAnchorS) || 643,
        timeJitterS: Number(run.timeJitterS) || 8,
      });
      distanceKm = plan.finalKm;
      usedS = plan.usedS;
      log(`  智能配速: 最终 ${plan.finalKm}km / ${usedS}s（平均配速 ${fmtPace(plan.paceSPK)}/km）`);
    }
  } else {
    const usePF = args.usePathfinding !== false && run.usePathfinding !== false;
    if (usePF) {
      try {
        const lapLenApprox = 2 * Math.PI * loopRadius * 0.95;
        const laps = Number(args.laps) || run.laps || Math.ceil((distanceKm * 1000 * (1 + distanceK)) / lapLenApprox) + 1;
        const checkpoints = Number(args.checkpoints) || run.checkpoints || 3;
        const pr = planRoute({
          centerLat: run.centerLat, centerLon: run.centerLon,
          loopRadius, laps, checkpoints,
        });
        routeNodes = pr.route.map((n) => [n.lat, n.lon]);
        log(`  寻路: ${routeNodes.length} 节点, ${laps} 圈, ${checkpoints} 打卡点, 单圈≈${pr.lapLength.toFixed(0)}m`);
      } catch (e) {
        log(`  寻路失败，回退椭圆: ${e.message}`);
      }
    }
    if (smartPace) {
      const plan = planPace({
        mandatoryM: 0,
        targetKm: distanceKm,
        paceMinS: Number(run.paceMinS) || 195,
        paceMaxS: Number(run.paceMaxS) || 210,
        timeAnchorS: Number(run.timeAnchorS) || 643,
        timeJitterS: Number(run.timeJitterS) || 8,
      });
      distanceKm = plan.finalKm;
      usedS = plan.usedS;
      log(`  智能配速: 最终 ${plan.finalKm}km / ${usedS}s（平均配速 ${fmtPace(plan.paceSPK)}/km）`);
    }
  }

  const points = genTrack({
    centerLat: run.centerLat,
    centerLon: run.centerLon,
    targetMeters: distanceKm * 1000,
    usedTimeS: usedS,
    startTsMs,
    loopRadius,
    speedChangeN,
    speedChangeM,
    distanceK: smartPace ? 0 : distKReal,
    sampleHz: 1,
    jitterM: (args.jitterM != null && !isNaN(Number(args.jitterM))) ? Number(args.jitterM) : (run.jitterM != null ? run.jitterM : 3),
    smooth: args.smooth != null ? args.smooth !== 'false' : run.smooth !== false,
    zones: trackZones,
    route: routeNodes,
  });
  const { step_info, step_num } = genSteps(usedS, distanceKm);

  // 统计
  const dist = points.length ? points[points.length - 1][4] : 0;
  const speeds = points.map(p => p[2]);
  const minS = Math.min(...speeds);
  const maxS = Math.max(...speeds);
  const changes = countSpeedChanges(points);

  log(`  生成 ${points.length} 点，实际 ${dist.toFixed(1)}m / ${(dist / 1000).toFixed(3)}km`);
  log(`  速度 min=${minS.toFixed(2)} max=${maxS.toFixed(2)} 速度变化次数=${changes}`);

  // 校验
  const ok = points.length >= 30 && minS !== maxS && changes >= 3 && dist >= distanceKm * 1000;
  log(ok ? '✅ 通过基础校验（点数/速度变化/距离达标）' : '⚠️ 未通过基础校验');

  // 写本地 record preview（数组格式，可直接喂给 detail 页模拟渲染）
  const record = buildRecord({
    common: { term_id: cfg.term_id || 1 },
    type: 2,
    game_id: 0,
    start_time_sec: Math.floor(startTsMs / 1000),
    end_time_sec: Math.floor(startTsMs / 1000) + usedS,
    distance: +(dist / 1000).toFixed(3),
    used_time: usedS,
    points,
    step_info,
    step_num,
    point_list: [],
    mobileModel: cfg.mobileModel || 'iPhone14,3',
  });
  // 陀螺仪（明文 JSON 字符串，与真实小程序一致）
  record.gyr = genGyro(usedS, startTsMs, { asString: true });
  const outPath = path.join(ROOT, 'record-preview.json');
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
  log(`  已写入 ${outPath}`);

  // 也写一份加密后的轨迹文件（模拟 OSS 上传内容），便于用 detail 解密逻辑验证
  const fileB64 = encrypt(JSON.stringify(record.file));
  fs.writeFileSync(path.join(ROOT, 'record-preview.file.txt'), fileB64);
  log(`  轨迹文件(密文) record-preview.file.txt，长度 ${fileB64.length}`);
  // 陀螺仪文件（明文 JSON，与真实小程序 createTxt(record.gyr) 一致）
  fs.writeFileSync(path.join(ROOT, 'record-preview.gyro.txt'), record.gyr);
  log(`  陀螺仪文件(明文) record-preview.gyro.txt，长度 ${record.gyr.length}`);
  log('🎉 预览完成。可视化轨迹: node tools/render-track-png.mjs record-preview.json --roadnet=roadnet.json');
}

main();
