/**
 * 一次性脚本: 在 CloudBase MySQL 实例里建好 3 张积分系统用的表
 *
 * 前置:
 *   1. CloudBase 控制台 → SQL 型数据库 → 数据库设置 → 已开启外网访问 + 加白名单 IP
 *   2. 已新建一个有 DDL 权限的账号(如 ds_admin,主机 %,权限"全部")
 *   3. 本地 .env 配好 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME 五个变量
 *      注意:DB_HOST/DB_PORT 用控制台显示的「外网地址」与外网端口,不是 3306
 *
 * 用法:
 *   node cloudbase/migrations/init-schema.js
 *
 * 幂等:
 *   schema.sql 用 CREATE TABLE IF NOT EXISTS,重跑安全。
 *   但表已存在时不会修改结构,如需改表请手动 DROP TABLE 或 ALTER。
 */

try { require('dotenv').config(); } catch {}

const path = require('path');
const fs = require('fs');

function loadConfig() {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;
  const port = Number(process.env.DB_PORT) || 3306;
  if (!host || !user || !password || !database) {
    console.error('[init-schema] 缺少 DB_HOST / DB_USER / DB_PASSWORD / DB_NAME,请检查 .env');
    process.exit(1);
  }
  return { host, user, password, database, port, multipleStatements: true, charset: 'utf8mb4' };
}

function splitStatements(sql) {
  // 简易切分:按 ; 分割,过滤纯注释行与空行
  const cleaned = sql
    .split('\n')
    .filter(line => !/^\s*--/.test(line))
    .join('\n');
  return cleaned
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

async function main() {
  const cfg = loadConfig();
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error('[init-schema] schema.sql 不存在:', schemaPath);
    process.exit(1);
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    console.error('[init-schema] schema.sql 解析后没有可执行 SQL');
    process.exit(1);
  }

  const mysql = require('mysql2/promise');
  console.log(`[init-schema] 连接 ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
  const conn = await mysql.createConnection(cfg);
  console.log('[init-schema] ✓ 已连接');

  for (const stmt of statements) {
    const head = stmt.replace(/\s+/g, ' ').slice(0, 80);
    process.stdout.write(`[init-schema] 执行: ${head}... `);
    try {
      await conn.query(stmt);
      console.log('OK');
    } catch (err) {
      console.log('FAIL');
      console.error(err.message);
      await conn.end();
      process.exit(1);
    }
  }

  // 验证 3 张表
  console.log('\n[init-schema] 验证表结构:');
  for (const t of ['user_credits', 'credit_transactions', 'recharge_orders']) {
    try {
      const [rows] = await conn.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables
         WHERE table_schema = ? AND table_name = ?`,
        [cfg.database, t]
      );
      const exists = rows[0] && rows[0].cnt > 0;
      const [cntRows] = exists
        ? await conn.query(`SELECT COUNT(*) AS cnt FROM \`${t}\``)
        : [[{ cnt: '-' }]];
      console.log(`  ${exists ? '✓' : '✗'} ${t.padEnd(22)} 行数: ${cntRows[0].cnt}`);
    } catch (err) {
      console.log(`  ✗ ${t.padEnd(22)} 查询失败:`, err.message);
    }
  }

  await conn.end();
  console.log('\n[init-schema] 完成。接下来:');
  console.log('  1. 给 5 个云函数加 DB_HOST/PORT/USER/PASSWORD/NAME 环境变量(用内网 172.17.0.7:3306)');
  console.log('  2. cloudbase fn deploy ai-proxy --force (其余 4 个同理)');
  console.log('  3. 部署完后关闭 MySQL 外网访问');
}

main().catch((err) => {
  console.error('[init-schema] 失败:', err);
  process.exit(1);
});
