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

  // 历史上 _shared 的 credits-init.js 曾是 doc DB 版、ai-proxy 自带 MySQL 版,
  // 需要按函数排除;2026-07 起 _shared 统一为 MySQL 版,全员共用,不再排除。
  // sync-user-data 运行在体验版仅支持的 Node.js 8.9 上，使用自己的
  // Node 8 兼容响应与 JWT 验证实现，不能被通用库覆盖。
  const EXCLUDE_BY_FUNCTION = {
    'sync-user-data': [
      'auth-helper.js',
      'config-cache.js',
      'credits-init.js',
      'mysql.js',
      'response.js',
    ],
  };

  let total = 0;
  for (const fn of functions) {
    const libDir = path.join(FUNCTIONS_DIR, fn, 'lib');
    ensureDir(libDir);
    const excludes = EXCLUDE_BY_FUNCTION[fn] || [];
    const files = sharedFiles.filter(f => !excludes.includes(f));
    for (const sf of files) {
      const src = path.join(SHARED_DIR, sf);
      const dst = path.join(libDir, sf);
      const bytes = copyFile(src, dst);
      total += bytes;
    }
    if (excludes.length > 0) {
      console.log(`[sync-shared]   → functions/${fn}/lib/  (${files.length} files, 排除: ${excludes.join(', ')})`);
    } else {
      console.log(`[sync-shared]   → functions/${fn}/lib/  (${files.length} files)`);
    }
  }
  console.log(`[sync-shared] 完成,共 ${total} 字节`);
}

main();
