// 登录态探活：输出含 "FAILED" 即视为未登录（start.ps1 据此自动拉起抓包窗口）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './lib/client.mjs';

// 以脚本自身位置定位 config.json（与 auto-run.mjs 一致，不依赖当前工作目录）
const ROOT = path.dirname(fileURLToPath(import.meta.url));

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch {
  console.log('config.json FAILED: 缺少 config.json（尚未完成登录抓包）');
  process.exit(1);
}

const common = {
  school_id: cfg.school_id, term_id: null, course_id: null, class_id: cfg.class_id,
  student_num: cfg.student_num, card_id: cfg.card_id || cfg.student_num,
  uid: cfg.uid, token: cfg.token,
};
const client = createClient({ baseUrl: cfg.baseUrl, common });

for (const m of ['WpLogin/UserInfo', 'Run2/beforeRunV260']) {
  try {
    const r = await client.post(m, {});
    console.log(`${m} OK:`, JSON.stringify(r).slice(0, 90));
  } catch (e) {
    console.log(`${m} FAILED: ${e.name}: ${e.message}`);
  }
}
