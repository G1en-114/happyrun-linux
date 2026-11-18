#!/usr/bin/env node
/**
 * happyrun 结果查看器（Linux / macOS / Windows 通用，替代 result.ps1）
 *
 *   ./result.sh                  当前账号：上次运行日志尾部 + 有效次数台账
 *   ./result.sh --account=2025xxxx   指定账号
 *   ./result.sh --tail=50        日志尾部行数（默认 30）
 *   ./result.sh --all            列出所有账号的台账
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const argv = process.argv.slice(2);
function opt(name, def) {
  const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return def;
  const v = a.split('=')[1];
  return v === undefined ? true : v;
}
const TAIL = Math.max(1, Number(opt('tail', 30)) || 30);
const ACCOUNT = opt('account', null);
const ALL = !!opt('all', false);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const BOLD = paint('1'), DIM = paint('2'), CYAN = paint('36'), GREEN = paint('32'), YELLOW = paint('33'), RED = paint('31'), GRAY = paint('90');

const STYLE = {
  success: [GREEN, '✅ 有效'],
  duplicate: [CYAN, '♻ 重复'],
  rejected: [YELLOW, '⚠ 被拒'],
  aborted: [RED, '✖ 中止'],
};

function charW(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
const strW = (s) => [...s].reduce((n, ch) => n + charW(ch), 0);
const padEndW = (s, w) => s + ' '.repeat(Math.max(0, w - strW(s)));

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function currentAccount() {
  const cfg = readJSON(path.join(ROOT, 'config.json'));
  const solid = (v) => (v && !String(v).includes('<') ? String(v) : null);
  const fromCfg = solid(cfg?.student_num) || solid(cfg?.uid);
  if (fromCfg) return fromCfg;
  const st = readJSON(path.join(ROOT, 'formal-run.status.json'));
  if (solid(st?.account)) return String(st.account);
  const accounts = ledgerAccounts();
  return accounts.length === 1 ? accounts[0] : null;
}

function ledgerAccounts() {
  const files = fs.readdirSync(ROOT).filter((f) => /^run-history-.+\.jsonl$/.test(f));
  return files.map((f) => f.replace(/^run-history-/, '').replace(/\.jsonl$/, ''));
}

function showLedger(acc) {
  const f = path.join(ROOT, `run-history-${acc}.jsonl`);
  if (!fs.existsSync(f)) return false;
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
  console.log(YELLOW(`── 有效次数台账（账号 ${acc}）──`));
  let ok = 0;
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { console.log(GRAY(`  (无法解析: ${line.slice(0, 60)}…)`)); continue; }
    const [style, label] = STYLE[r.result] || [GRAY, String(r.result)];
    if (r.result === 'success') ok++;
    const when = String(r.time || '').replace('T', ' ').replace(/\..*$/, '');
    const dist = r.distance_km ? `${Number(r.distance_km).toFixed(3)}km` : '--';
    const pace = r.pace || '--';
    const extra = r.reason ? ` ${r.reason}` : r.record_id ? ` record=${r.record_id}` : '';
    const base = `  #${String(r.n ?? '?').padEnd(3)} ${when}  ${label}  ${padEndW(dist, 9)} ${padEndW(pace, 10)}${extra}`;
    console.log(style(base));
  }
  console.log(GREEN(`  合计: ${ok} 次有效`));
  return true;
}

function main() {
  const acc = ACCOUNT || currentAccount();
  const header = acc || '未知（未完成登录抓包）';
  console.log(CYAN(`════════════ happyrun 结果（账号: ${header}）════════════`));

  const log = path.join(ROOT, 'formal-run.log');
  if (fs.existsSync(log)) {
    console.log('');
    console.log(YELLOW(`── 上次运行日志（尾部 ${TAIL} 行）──`));
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    console.log(lines.slice(-TAIL).join('\n'));
  } else {
    console.log(GRAY('（还没有 formal-run.log）'));
  }

  console.log('');
  if (ALL) {
    const accounts = ledgerAccounts();
    if (!accounts.length) { console.log(GRAY('  （还没有任何账号的记录）')); return 0; }
    for (const a of accounts) { showLedger(a); console.log(''); }
  } else if (acc) {
    if (!showLedger(acc)) console.log(GRAY(`  （账号 ${acc} 还没有记录）`));
  } else {
    const accounts = ledgerAccounts();
    if (!accounts.length) { console.log(GRAY('  （还没有任何账号的记录）')); return 0; }
    for (const a of accounts) { showLedger(a); console.log(''); }
  }
  return 0;
}

process.exit(main());
