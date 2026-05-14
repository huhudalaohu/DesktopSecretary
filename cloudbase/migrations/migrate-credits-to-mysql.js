/**
 * 迁移脚本: doc DB → MySQL(一次性,把 user_credits / credit_transactions / recharge_orders 三个集合拷到 MySQL)
 *
 * 前置:
 *   1. CloudBase 控制台已开通 MySQL 8.0 实例,临时开放公网访问 + 加白名单 IP
 *   2. .env 里配置好两套凭证(doc DB + MySQL):
 *        TCB_ENV_ID, TCB_SECRET_ID, TCB_SECRET_KEY
 *        DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 *   3. schema.sql 已经在 MySQL 实例里跑过(3 张表已创建)
 *   4. ⚠️ 此脚本应该在云函数 redeploy *之前* 跑,确保 MySQL 已经有数据再切流量,
 *      否则新部署的函数会读到空表 → ensureUserCredits 给老用户重发 welcome bonus。
 *
 * 用法:
 *   node cloudbase/migrations/migrate-credits-to-mysql.js              # 干跑(只读,统计行数)
 *   node cloudbase/migrations/migrate-credits-to-mysql.js --apply      # 真正写入 MySQL(幂等,ON DUPLICATE KEY UPDATE)
 *   node cloudbase/migrations/migrate-credits-to-mysql.js --apply --truncate
 *                                                                      # 写入前先 TRUNCATE 3 张表(危险,只在重跑时用)
 *
 * 幂等性:
 *   - user_credits: ON DUPLICATE KEY UPDATE,uid 已存在则按 doc DB 最新值覆盖
 *   - recharge_orders: ON DUPLICATE KEY UPDATE,id 已存在则按 doc DB 最新值覆盖
 *   - credit_transactions: 没有自然主键,id BIGINT AUTO_INCREMENT — 重跑会重复写入!
 *     重跑前请手动 TRUNCATE credit_transactions 或加 --truncate(注意会清掉迁移期间产生的新流水)
 */

try { require('dotenv').config(); } catch {}

const path = require('path');
const fs = require('fs');

const ENV_ID = process.env.TCB_ENV_ID || 'ds-dev-d9g28xlrgd2600837';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const TRUNCATE = argv.includes('--truncate');

const BATCH_SIZE = 100;        // doc DB 每页拉 100 条
const MAX_RECORDS = 100000;    // 单集合硬上限,防漏拉/死循环

function loadTcbCredentials() {
  let secretId = process.env.TCB_SECRET_ID;
  let secretKey = process.env.TCB_SECRET_KEY;
  if (secretId && secretKey) return { secretId, secretKey };

  const configPath = path.join(__dirname, '..', '..', 'config', 'publish-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { secretId: c.secretId, secretKey: c.secretKey };
    } catch {}
  }
  return { secretId: null, secretKey: null };
}

function loadMysqlConfig() {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;
  const port = Number(process.env.DB_PORT) || 3306;
  if (!host || !user || !password || !database) return null;
  return { host, user, password, database, port, timezone: '+00:00', charset: 'utf8mb4' };
}

async function fetchAll(coll, label) {
  const all = [];
  let offset = 0;
  while (true) {
    const { data } = await coll.skip(offset).limit(BATCH_SIZE).get();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    offset += data.length;
    if (all.length >= MAX_RECORDS) {
      console.warn(`[migrate] ${label} 已读 ${all.length} 条,触及硬上限 ${MAX_RECORDS},终止拉取`);
      break;
    }
    if (data.length < BATCH_SIZE) break;
  }
  return all;
}

async function main() {
  const { secretId, secretKey } = loadTcbCredentials();
  if (!secretId || !secretKey) {
    console.error('[migrate] 缺少 TCB_SECRET_ID / TCB_SECRET_KEY,无法连接 doc DB');
    process.exit(1);
  }
  const sqlCfg = loadMysqlConfig();
  if (!sqlCfg) {
    console.error('[migrate] 缺少 DB_HOST / DB_USER / DB_PASSWORD / DB_NAME,无法连接 MySQL');
    process.exit(1);
  }

  const cloudbase = require('@cloudbase/node-sdk');
  const mysql = require('mysql2/promise');

  const app = cloudbase.init({ env: ENV_ID, secretId, secretKey });
  const db = app.database();

  console.log(`[migrate] doc DB env=${ENV_ID}`);
  console.log(`[migrate] MySQL ${sqlCfg.user}@${sqlCfg.host}:${sqlCfg.port}/${sqlCfg.database}`);
  console.log(`[migrate] 模式: ${APPLY ? '✏️  写入' : '🔍 干跑(只读统计)'}`);
  if (TRUNCATE) console.log('[migrate] ⚠️  --truncate 已启用,写入前会清空 3 张表');

  // 1. 拉 doc DB 三个集合
  const credits = await fetchAll(db.collection('user_credits'), 'user_credits');
  const txs = await fetchAll(db.collection('credit_transactions').orderBy('createdAt', 'asc'), 'credit_transactions');
  const orders = await fetchAll(db.collection('recharge_orders'), 'recharge_orders');

  console.log(`[migrate] doc DB 读到:`);
  console.log(`  user_credits          ${credits.length} 条`);
  console.log(`  credit_transactions   ${txs.length} 条`);
  console.log(`  recharge_orders       ${orders.length} 条`);

  if (!APPLY) {
    console.log('\n[migrate] 干跑结束。如确认数据正确,加 --apply 再跑一次真正写入。');
    return;
  }

  // 2. 连 MySQL
  const conn = await mysql.createConnection(sqlCfg);
  console.log('[migrate] MySQL 已连接');

  if (TRUNCATE) {
    console.log('[migrate] TRUNCATE 3 张表...');
    await conn.execute('TRUNCATE TABLE credit_transactions');
    await conn.execute('TRUNCATE TABLE user_credits');
    await conn.execute('TRUNCATE TABLE recharge_orders');
  }

  // 3. 写 user_credits
  let n = 0;
  for (const c of credits) {
    await conn.execute(
      `INSERT INTO user_credits (uid, balance, total_recharged, total_consumed, welcomed_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
            balance         = VALUES(balance),
            total_recharged = VALUES(total_recharged),
            total_consumed  = VALUES(total_consumed),
            welcomed_at     = VALUES(welcomed_at),
            updated_at      = VALUES(updated_at)`,
      [
        String(c._id),
        Number(c.balance) || 0,
        Number(c.totalRecharged) || 0,
        Number(c.totalConsumed) || 0,
        toDate(c.welcomedAt),
        toDate(c.updatedAt) || new Date(),
      ]
    );
    n++;
  }
  console.log(`[migrate] ✓ user_credits 写入 ${n} 条`);

  // 4. 写 credit_transactions(append-only,无幂等 — 重跑会重复)
  n = 0;
  for (const t of txs) {
    await conn.execute(
      `INSERT INTO credit_transactions (uid, type, amount, balance_after, meta, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(t.uid),
        String(t.type),
        Number(t.amount) || 0,
        Number(t.balanceAfter) || 0,
        JSON.stringify(t.meta || {}),
        toDate(t.createdAt) || new Date(),
      ]
    );
    n++;
  }
  console.log(`[migrate] ✓ credit_transactions 写入 ${n} 条`);

  // 5. 写 recharge_orders
  n = 0;
  for (const o of orders) {
    await conn.execute(
      `INSERT INTO recharge_orders (id, uid, channel, pay_amount, credits, status, qr_code_data, third_trade_no, fail_reason, created_at, expires_at, paid_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
            status          = VALUES(status),
            paid_at         = VALUES(paid_at),
            third_trade_no  = VALUES(third_trade_no),
            fail_reason     = VALUES(fail_reason)`,
      [
        String(o._id),
        String(o.uid),
        String(o.channel || 'mock'),
        Number(o.payAmount) || 0,
        Number(o.credits) || 0,
        String(o.status || 'pending'),
        o.qrCodeData || null,
        o.thirdTradeNo || null,    // '' 也写 NULL 才符合 UNIQUE 索引语义
        o.failReason || null,
        toDate(o.createdAt) || new Date(),
        toDate(o.expiresAt) || new Date(Date.now() + 5 * 60 * 1000),
        toDate(o.paidAt),
      ]
    );
    n++;
  }
  console.log(`[migrate] ✓ recharge_orders 写入 ${n} 条`);

  // 6. 验证行数
  const [[uc]] = await conn.query('SELECT COUNT(*) AS cnt FROM user_credits');
  const [[ct]] = await conn.query('SELECT COUNT(*) AS cnt FROM credit_transactions');
  const [[ro]] = await conn.query('SELECT COUNT(*) AS cnt FROM recharge_orders');
  console.log(`\n[migrate] MySQL 当前行数:`);
  console.log(`  user_credits          ${uc.cnt}`);
  console.log(`  credit_transactions   ${ct.cnt}`);
  console.log(`  recharge_orders       ${ro.cnt}`);

  if (uc.cnt < credits.length || ro.cnt < orders.length) {
    console.warn('[migrate] ⚠️  user_credits 或 recharge_orders 行数小于 doc DB,可能有写入失败,请检查日志');
  }
  if (!TRUNCATE && ct.cnt < txs.length) {
    console.warn('[migrate] ⚠️  credit_transactions 行数小于 doc DB,可能有写入失败');
  }

  await conn.end();
  console.log('\n[migrate] 完成。建议:');
  console.log('  1. 抽样对比 3-5 个用户的 balance / totalRecharged / totalConsumed,确保两边一致');
  console.log('  2. 然后再 cloudbase fn deploy 把 5 个函数推到生产');
  console.log('  3. doc DB 的 user_credits / credit_transactions / recharge_orders 保留 14 天后再清理');
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  // CloudBase doc DB 序列化可能返回 {$date: '...'} 或 ISO 字符串
  if (typeof v === 'object' && v.$date) v = v.$date;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

main().catch((err) => {
  console.error('[migrate] 失败:', err);
  process.exit(1);
});
