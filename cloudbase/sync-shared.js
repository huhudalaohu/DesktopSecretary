/**
 * 同步 _shared/*.js 到每个 functions/<name>/lib/ 目录。
 *
 * 在部署云函数前跑一次,确保每个函数目录都有最新的共享代码副本。
 *
 * 用法: node cloudbase/sync-shared.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SHARED_DIR = path.join(ROOT, '_shared');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dst) {
  const content = fs.readFileSync(src, 'utf8');
  fs.writeFileSync(dst, content);
  return content.length;
}

function main() {
  if (!fs.existsSync(SHARED_DIR)) {
    console.error('[sync-shared] _shared 目录不存在:', SHARED_DIR);
    process.exit(1);
  }
  if (!fs.existsSync(FUNCTIONS_DIR)) {
    console.log('[sync-shared] functions 目录不存在,跳过(还没创建任何云函数)');
    return;
  }

  const sharedFiles = fs.readdirSync(SHARED_DIR).filter(f => f.endsWith('.js'));
  const functions = fs.readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  if (functions.length === 0) {
    console.log('[sync-shared] functions/ 下没有云函数目录,跳过');
    return;
  }

  console.log(`[sync-shared] 发现 ${sharedFiles.length} 个共享文件,${functions.length} 个云函数`);

  let total = 0;
  for (const fn of functions) {
    const libDir = path.join(FUNCTIONS_DIR, fn, 'lib');
    ensureDir(libDir);
    for (const sf of sharedFiles) {
      const src = path.join(SHARED_DIR, sf);
      const dst = path.join(libDir, sf);
      const bytes = copyFile(src, dst);
      total += bytes;
    }
    console.log(`[sync-shared]   → functions/${fn}/lib/  (${sharedFiles.length} files)`);
  }
  console.log(`[sync-shared] 完成,共 ${total} 字节`);
}

main();
