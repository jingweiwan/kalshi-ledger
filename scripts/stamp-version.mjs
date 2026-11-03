// 给网页引用的 JS / CSS 加上版本号（?v=...），推送新版本后浏览器马上拿新文件，不用等缓存过期。
// 用法：改完代码、提交前运行  node scripts/stamp-version.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const v = Date.now().toString(36);

const jsDir = path.join(root, 'js');
for (const f of fs.readdirSync(jsDir).filter((x) => x.endsWith('.js'))) {
  const p = path.join(jsDir, f);
  const s = fs.readFileSync(p, 'utf8');
  const out = s.replace(/(from '\.\/[a-z-]+\.js)(\?v=[a-z0-9]+)?'/g, `$1?v=${v}'`);
  if (out !== s) fs.writeFileSync(p, out);
}

const html = path.join(root, 'index.html');
const s = fs.readFileSync(html, 'utf8');
fs.writeFileSync(html, s.replace(/((?:href|src)="(?:styles\.css|vendor\/supabase\.js|js\/app\.js))(\?v=[a-z0-9]+)?"/g, `$1?v=${v}"`));
console.log('版本号', v);
