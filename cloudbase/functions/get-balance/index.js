/**
 * 云函数: get-balance(doc DB 版)
 *
 * 查询当前登录用户的:
 *   - balance / totalRecharged / totalConsumed
 *   - 最近 20 条流水
 *
 * 鉴权: 自验 JWT。
 * 存储: app_config + user_credits + credit_transactions 全在 doc DB。
 */

const cloudbase = require('@cloudbase/node-sdk');

const { ok, fail, handleOptions } = require('./lib/response');
const { requireAuth, authErrorResponse } = require('./lib/auth-helper');
const { getAppConfig } = require('./lib/config-cache');
const { ensureUserCredits } = require('./lib/credits-init');

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

    // 1. 读 app_config
    const config = await getAppConfig(db);

    // 2. 懒初始化 + 拿当前积分
    let credits;
    try {
      credits = await ensureUserCredits(db, uid, config);
    } catch (err) {
      console.error('[get-balance] 懒初始化失败:', err.message);
      return fail(500, '初始化用户积分失败');
    }

    // 3. 读最近 20 条流水 — doc DB
    let recentTransactions = [];
    try {
      const txRes = await db.collection('credit_transactions')
        .where({ uid })
        .orderBy('createdAt', 'desc')
        .limit(RECENT_TX_LIMIT)
        .get();
      const rows = Array.isArray(txRes.data) ? txRes.data : [];
      recentTransactions = rows.map((r) => ({
        type: r.type,
        amount: r.amount,
        balanceAfter: r.balanceAfter,
        meta: r.meta || {},
        createdAt: r.createdAt,
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
