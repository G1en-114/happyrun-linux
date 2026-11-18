import fs from 'node:fs';
import crypto from 'node:crypto';
const S = 'C:/Users/吴佳庆/Desktop/HappyRun-portable-最新版/happyrun/';
const D = 'D:/HappyRun-portable/happyrun/';
const h = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const files = ['watch.ps1', 'auto-run.mjs', 'tools/live-serve.mjs', 'tools/live.html', 'tools/make-live-testdata.mjs', 'tools/set-progress.mjs', 'tools/check-watch.ps1'];
let ok = 0, miss = 0;
for (const f of files) {
  const sOk = fs.existsSync(S + f), dOk = fs.existsSync(D + f);
  if (!sOk) { console.log('源缺失:', f); continue; }
  if (!dOk) { console.log('D盘缺失:', f); miss++; continue; }
  const same = h(S + f) === h(D + f);
  console.log(`${f}: ${same ? '一致' : '不同!'}  ${same ? '' : ''}`);
  if (same) ok++; else miss++;
}
console.log(`同步一致 ${ok}/${files.length}，问题 ${miss}`);
// 测试数据应已删除
console.log('formal-run.track.json 存在:', fs.existsSync(S + 'formal-run.track.json'));
console.log('formal-run.status.json 存在:', fs.existsSync(S + 'formal-run.status.json'));
