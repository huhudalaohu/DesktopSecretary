/**
 * 云函数: get-balance(MySQL 版)
 *
 * 查询当前登录用户的:
 *   - balance / totalRecharged / totalConsumed
 *   - 最近 20 条流水
 *
 * 鉴权: 自验 JWT。
 * 存储: app_config 在 doc DB;user_credits + credit_transactions 在 MySQL
 *       (与 ai-proxy 扣分同一套表,避免 doc/MySQL 双写分裂)。
 *
 * 环境变量: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 * 网络: 必须挂载 MySQL 所在 VPC,否则 connect ETIMEDOUT(见 cloudbase/README.md 1.1.1)
 */

const cloudbase = require('@cloudbase/node-sdk');

const { ok, fail, handleOptions } = require('./lib/response');
const { requireAuth, authErrorResponse } = require('./lib/auth-helper');
const { getAppConfig } = require('./lib/config-cache');
const { ensureUserCredits } = require('./lib/credits-init');
const { getConnection } = require('./lib/mysql');

const RECENT_TX_LIMIT = 20;

exports.main = async (event, context) => {
  const corsResp = handleOptions(event);
  if (corsResp) return corsResp;

  let auth;
  try {
    auth = await requireAuth(event, context);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const uid = auth.uid;

  try {
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
    const db = app.database();

    // 1. 读 app_config(doc DB)
    const config = await getAppConfig(db);

    // 2. 懒初始化 + 拿当前积分(MySQL)
    let credits;
    try {
      credits = await ensureUserCredits(uid, config);
    } catch (err) {
      console.error('[get-balance] 懒初始化失败:', err.message);
      return fail(500, '初始化用户积分失败');
    }

    // 3. 读最近 20 条流水 — MySQL
    let recentTransactions = [];
    try {
      const conn = await getConnection();
      // 注意:LIMIT 不能用占位符 —— mysql2 execute 走预处理语句,
      // 腾讯云 MySQL 对 LIMIT ? 报 ER_WRONG_ARGUMENTS。RECENT_TX_LIMIT 是本地常量,直接内联。
      const [rows] = await conn.execute(
        `SELECT type, amount, balance_after, meta, created_at
           FROM credit_transactions
          WHERE uid = ?
          ORDER BY id DESC
          LIMIT ${RECENT_TX_LIMIT}`,
        [uid]
      );
      recentTransactions = rows.map((r) => ({
        type: r.type,
        amount: r.amount,
        balanceAfter: r.balance_after,
        meta: typeof r.meta === 'string' ? JSON.parse(r.meta || '{}') : (r.meta || {}),
        createdAt: r.created_at,
      }));
    } catch (err) {
      console.warn('[get-balance] 读取流水失败:', err.message);
    }

    return ok({
      balance: credits.balance || 0,
      totalRecharged: credits.totalRecharged || 0,
      totalConsumed: credits.totalConsumed || 0,
      recentTransactions,
    });

  } catch (err) {
    console.error('[get-balance] 失败:', err.message);
    return fail(500, err.message || '查询失败');
  }
};
