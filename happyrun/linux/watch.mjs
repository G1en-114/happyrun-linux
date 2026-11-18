#!/usr/bin/env node
/**
 * happyrun 实时进度查看器（Linux / macOS / Windows 通用，替代 watch.ps1）
 *
 * 读取 auto-run.mjs 每秒写入的：
 *   happyrun/formal-run.status.json  实时阶段/进度/配速/ETA
 *   happyrun/formal-run.log          后台日志（增量滚动）
 *   happyrun/run-history-<账号>.jsonl 台账（结束后取最后一条）
 *
 * 用法：
 *   ./watch.sh                 实时刷新（Ctrl+C / q 退出，不影响后台跑步）
 *   ./watch.sh --once          只显示一帧就退出
 *   ./watch.sh --no-live       不启动实时轨迹图服务（默认 127.0.0.1:8947）
 *   ./watch.sh --refresh=3     刷新间隔秒（默认 2）
 *
 * 快捷键：o = 浏览器打开实时轨迹图，q / Ctrl+C = 退出本界面
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // happyrun/linux
const ROOT = path.dirname(HERE); // happyrun/
const LOG_PATH = path.join(ROOT, 'formal-run.log');
const STATUS_PATH = path.join(ROOT, 'formal-run.status.json');
const LIVE_URL = 'http://127.0.0.1:8947/';

const argv = process.argv.slice(2);
function opt(name, def) {
  const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return def;
  const v = a.split('=')[1];
  return v === undefined ? true : v;
}
const ONCE = !!opt('once', false);
const NO_LIVE = !!opt('no-live', false);
const NO_LOG = !!opt('no-log', false);
const REFRESH_SEC = Math.max(1, Number(opt('refresh', 2)) || 2);

// ── 颜色 / 终端 ──
const TTY = process.stdout.isTTY === true;
const COLOR = TTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const BOLD = paint('1');
const DIM = paint('2');
const CYAN = paint('36');
const GREEN = paint('32');
const YELLOW = paint('33');
const RED = paint('31');
const MAGENTA = paint('35');
const GRAY = paint('90');

const out = (s = '') => process.stdout.write(s + '\n');

// ── 等宽处理（中文/emoji 占 2 列） ──
function charW(ch) {
  const cp = ch.codePointAt(0);
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}
const strW = (s) => [...s].reduce((n, ch) => n + charW(ch), 0);
const padTo = (s, w) => s + ' '.repeat(Math.max(0, w - strW(s)));

// ── 小工具 ──
function fmtPace(sec) {
  const s = Math.round(Number(sec) || 0);
  if (s <= 0) return "--'--\"";
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`;
}
function fmtMMSS(sec) {
  let s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function fmtClock(epochSec) {
  const d = new Date(Number(epochSec) * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function bar(pct, width = 30) {
  const p = Math.max(0, Math.min(100, pct));
  const n = Math.round((p / 100) * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}
function phaseLabel(p) {
  return ({ starting: '准备中', running: '跑步中', uploading: '上传中', finishing: '收尾中', done: '已结束', aborted: '已中止' })[p] || String(p || '未知');
}

// ── 日志增量读取 ──
let logOffset = 0;
let logBuf = [];
function readNewLog() {
  if (NO_LOG || !fs.existsSync(LOG_PATH)) return [];
  let size = 0;
  try { size = fs.statSync(LOG_PATH).size; } catch { return []; }
  if (size < logOffset) { logOffset = 0; logBuf = []; } // 日志被清空
  if (size === logOffset) return [];
  try {
    const fd = fs.openSync(LOG_PATH, 'r');
    const len = size - logOffset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, logOffset);
    fs.closeSync(fd);
    logOffset = size;
    const lines = buf.toString('utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length);
    logBuf.push(...lines);
    if (logBuf.length > 200) logBuf = logBuf.slice(-200);
    return lines;
  } catch { return []; }
}
function primeLog() {
  if (NO_LOG || !fs.existsSync(LOG_PATH)) return;
  try {
    const all = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
    logBuf = all.slice(-8);
    logOffset = fs.statSync(LOG_PATH).size;
  } catch {}
}

// ── 实时轨迹图服务 ──
async function portOpen(port) {
  return await new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(400);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
async function ensureLiveServer() {
  if (NO_LIVE) return false;
  if (await portOpen(8947)) return true;
  try {
    const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'live-serve.mjs')], { detached: true, stdio: 'ignore' });
    p.unref();
  } catch { return false; }
  for (let i = 0; i < 10; i++) {
    if (await portOpen(8947)) return true;
    await sleep(150);
  }
  return false;
}
function openLive() {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', LIVE_URL] : [LIVE_URL];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 台账最后一条 ──
function lastLedger(account, status) {
  const acc = status?.account || account || 'default';
  for (const name of [acc, 'default']) {
    const f = path.join(ROOT, `run-history-${name}.jsonl`);
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    try { return { file: name, rec: JSON.parse(lines[lines.length - 1]) }; } catch {}
  }
  return null;
}
function accountFromConfig() {
  const cfg = readJSON(path.join(ROOT, 'config.json'));
  return cfg?.student_num || cfg?.uid || null;
}

// ── 画面 ──
const RESULT_STYLE = {
  success: [GREEN, '✅ 有效'],
  duplicate: [CYAN, '♻ 重复'],
  rejected: [YELLOW, '⚠ 被拒'],
  aborted: [RED, '✖ 中止'],
};

let liveReady = false;
let altScreen = false;
function enterAlt() {
  if (!TTY || altScreen) return;
  process.stdout.write('\x1b[?1049h');
  altScreen = true;
}
function leaveAlt() {
  if (!altScreen) return;
  process.stdout.write('\x1b[?1049l');
  altScreen = false;
}

function statusBlock(st, alive, acc) {
  const lines = [];
  lines.push(BOLD(CYAN('═══ happyrun 实时进度 ═══')) + '  ' + GRAY(`账号 ${acc || '未知'}`));
  if (!st) return lines;

  const phase = String(st.phase || '');
  const pct = phase === 'running'
    ? Math.min(98, Math.round((100 * Number(st.elapsedS || 0)) / Math.max(1, Number(st.totalS || 0))))
    : phase === 'done' ? 100 : phase === 'uploading' || phase === 'finishing' ? 99 : 5;
  const simKm = Number(st.simKm || 0).toFixed(3);
  const targetKm = Number(st.targetKm || st.distance_km || 0);

  lines.push(
    `${padTo('阶段', 6)}${phaseLabel(phase)}` +
    `    ${padTo('已跑', 6)}${simKm} / ${targetKm ? targetKm.toFixed(3) : '--'} km` +
    `    ${padTo('用时', 6)}${fmtMMSS(st.elapsedS)} / ${fmtMMSS(st.totalS || st.usedS)}`,
  );
  lines.push(`  [${COLOR ? CYAN(bar(pct)) : bar(pct)}] ${String(pct).padStart(3)}%`);

  const cur = Number(st.curPaceS || 0);
  const planned = st.plannedPace || (st.usedS && st.targetKm ? fmtPace(Number(st.usedS) / Number(st.targetKm)) : "--'--\"");
  const rem = st.runEtaEpoch ? Math.max(0, Number(st.runEtaEpoch) - Math.floor(Date.now() / 1000)) : null;
  lines.push(
    `${padTo('当前配速', 10)}${fmtPace(cur)}/km   ` +
    `${padTo('计划均配', 10)}${planned}/km   ` +
    `${padTo('距跑完', 8)}${rem == null ? '--:--' : fmtMMSS(rem)}` +
    `${st.runEtaEpoch ? `   预计 ${fmtClock(st.runEtaEpoch)} 完成` : ''}`,
  );
  if (st.mandatoryKm != null || st.pointNum != null) {
    lines.push(GRAY(`打卡点 ${st.pointNum ?? '--'} 个 · 必到里程 ${st.mandatoryKm != null ? `${st.mandatoryKm} km` : '--'}`));
  }
  if (!alive && phase !== 'done' && phase !== 'aborted') {
    lines.push(YELLOW('⚠ 跑步进程已退出（状态文件未标记结束，可能被 Ctrl+C / kill 中断）'));
  }
  if (st.reason) lines.push(YELLOW(`原因：${st.reason}`));
  return lines;
}

function renderScreen(lines) {
  if (!TTY || ONCE) { out(lines.join('\n')); return; }
  const logLines = logBuf.slice(-8).map((l) => GRAY(l.length > 110 ? l.slice(0, 110) + '…' : l));
  const body = [
    ...lines,
    '',
    GRAY('── 后台日志（最近 8 行）──'),
    ...logLines,
    '',
    GRAY(liveReady ? `实时轨迹图: ${LIVE_URL}  按 o 打开 · q 退出` : '实时轨迹图未启动（--no-live）· q 退出'),
  ];
  process.stdout.write('\x1b[H' + body.map((l) => l + '\x1b[K').join('\n') + '\n\x1b[0J');
}

function finalBlock(st, ledger) {
  const lines = [];
  lines.push('');
  lines.push(GREEN('════════════ 跑步已结束 · 最终结果 ════════════'));
  if (st?.result) {
    const [style, label] = RESULT_STYLE[st.result] || [GRAY, st.result];
    lines.push(`  ${style(label)}` + (st.reason ? `  ${st.reason}` : ''));
    if (st.distance_km) {
      lines.push(`  距离 ${Number(st.distance_km).toFixed(3)} km · 用时 ${fmtMMSS(st.used_time_s)} · 配速 ${st.pace || fmtPace(Number(st.used_time_s) / Number(st.distance_km)) + '/km'}`);
    }
  } else {
    lines.push(YELLOW('  未读到状态文件的最终结果，见下方日志。'));
  }
  if (ledger) {
    const r = ledger.rec || {};
    const [style, label] = RESULT_STYLE[r.result] || [GRAY, r.result];
    lines.push(GRAY(`台账（账号 ${ledger.file}）第 ${r.n} 次: `) + style(label) +
      (r.distance_km ? `  ${Number(r.distance_km).toFixed(3)}km · ${r.pace || ''}` : '') +
      (r.record_id ? ` · record=${r.record_id}` : ''));
  }
  if (logBuf.length) {
    lines.push(GRAY('── 日志尾部 ──'));
    lines.push(...logBuf.slice(-12));
  }
  return lines;
}

function noRunBlock() {
  const acc = accountFromConfig();
  const shown = acc && !String(acc).includes('<') ? acc : null;
  const lines = [BOLD(CYAN('═══ happyrun 实时进度 ═══'))];
  lines.push(YELLOW('当前没有进行中的跑步。'));
  lines.push(`启动：${BOLD('./start.sh')}   只读校验：${BOLD('./dryrun.sh')}`);
  if (shown) lines.push(GRAY(`当前账号 ${shown}`));
  if (fs.existsSync(LOG_PATH)) {
    lines.push(GRAY('（显示上一次运行的日志尾部）'));
    try {
      const tail = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).slice(-12);
      lines.push(...tail);
    } catch {}
  }
  return lines;
}

// ── 主循环 ──
async function main() {
  const acc0 = accountFromConfig();
  primeLog();
  liveReady = await ensureLiveServer();
  enterAlt();

  let lastStatus = null;
  let doneTicks = 0;

  if (TTY && !ONCE) {
    process.stdout.write('\x1b[?25l'); // 隐藏光标
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', (b) => {
      const k = b.toString();
      if (k === 'q' || k === '\u0003') cleanupAndExit(0);
      if (k === 'o') openLive();
    });
  }

  const cleanupAndExit = (code) => {
    try { if (TTY && !ONCE) process.stdout.write('\x1b[?25h'); } catch {}
    leaveAlt();
    if (TTY && !ONCE) { try { process.stdin.setRawMode(false); } catch {} }
    process.exit(code);
  };
  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));

  while (true) {
    const st = readJSON(STATUS_PATH);
    readNewLog();

    if (st) {
      lastStatus = st;
      const alive = isAlive(st.pid);
      if (st.phase === 'done' || st.phase === 'aborted') {
        if (!alive) {
          doneTicks++;
          if (doneTicks >= 1) break;
        }
      }
      renderScreen(statusBlock(st, alive, st.account || acc0));
    } else {
      // 无状态文件：看日志是否刚刚更新（进程启动后几秒才会写状态）
      let recent = false;
      try { recent = Date.now() - fs.statSync(LOG_PATH).mtimeMs < 20000; } catch {}
      if (!recent) {
        renderScreen(noRunBlock());
        if (ONCE) break;
        await sleep(1200);
        if (!fs.existsSync(STATUS_PATH)) break;
        continue;
      }
      renderScreen([BOLD(CYAN('═══ happyrun 实时进度 ═══')), YELLOW('跑步进程已启动，等待状态文件生成…')]);
    }

    if (ONCE) break;
    await sleep(REFRESH_SEC * 1000);
  }

  // 结束：还原终端后打印最终结果
  leaveAlt();
  if (TTY && !ONCE) process.stdout.write('\x1b[?25h');
  if (TTY && !ONCE) { try { process.stdin.setRawMode(false); } catch {} }
  out('');
  out(finalBlock(lastStatus, lastLedger(acc0, lastStatus)).join('\n'));
  if (TTY && !ONCE) out(GRAY(`查看完整过程: ./result.sh`));
  process.exit(0);
}

main().catch((e) => {
  leaveAlt();
  console.error('watch 出错:', e);
  process.exit(1);
});
