/**
 * 云函数: direct-recharge (MySQL 版)
 *
 * 一步直达充值:输入金额 → 立即加积分 → 写流水 → 返回新余额。
 * 与 ai-proxy / get-balance 共用 MySQL 的 user_credits / credit_transactions。
 * (历史:曾因函数未挂 VPC 写成 doc DB 版,导致充值进了 doc DB、积分中心看不到。
 *  VPC 修复后统一回 MySQL。)
 *
 * 鉴权: 自验 JWT (从 Authorization header 提取)。
 *
 * 入参: { amount: number }  // 单位:分,如 1000 = ¥10
 * 返回: { balanceAfter, credits }
 *
 * 环境变量: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 * 网络: 必须挂载 MySQL 所在 VPC(见 cloudbase/README.md 1.1.1)
 */

const cloudbase = require('@cloudbase/node-sdk');

const { ok, fail, handleOptions, parseBody } = require('./lib/response');
const { requireAuth, authErrorResponse } = require('./lib/auth-helper');
const { getAppConfig } = require('./lib/config-cache');
const { ensureUserCredits } = require('./lib/credits-init');
const { tx } = require('./lib/mysql');

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

  let body;
  try {
    body = parseBody(event);
  } catch {
    return fail(400, '请求体格式错误');
  }
  const amount = Math.floor(Number(body && body.amount) || 0);

  try {
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
    const db = app.database();
    const config = await getAppConfig(db);
    const rechargeCfg = config.recharge || {};
    const paymentCfg = config.payment || { provider: 'mock', enabled: true };

    if (paymentCfg.enabled === false) {
      return fail(503, '充值暂时关闭,请稍后再试', { code: 'PAYMENT_DISABLED' });
    }

    const minAmount = Number(rechargeCfg.minAmount) || 500;
    const maxAmount = Number(rechargeCfg.maxAmount) || 100000;
    const creditsPerYuan = Number(rechargeCfg.creditsPerYuan) || 100;

    if (!Number.isInteger(amount) || amount < minAmount || amount > maxAmount) {
      return fail(400, `金额必须在 ¥${(minAmount / 100).toFixed(2)}~¥${(maxAmount / 100).toFixed(2)} 之间`, {
        code: 'INVALID_AMOUNT',
        minAmount,
        maxAmount,
      });
    }

    const credits = Math.floor((amount / 100) * creditsPerYuan);
    if (credits <= 0) {
      return fail(400, '充值积分计算异常', { code: 'CREDITS_ZERO' });
    }

    // 1. 懒初始化(独立事务,内部有行锁;不存在则建行并发 welcome)
    await ensureUserCredits(uid, config);

    // 2. 单事务:加积分 + 写流水 + 写审计订单
    const balanceAfter = await tx(async (conn) => {
      const now = new Date();

      await conn.execute(
        `UPDATE user_credits
            SET balance         = balance + ?,
                total_recharged = total_recharged + ?,
                updated_at      = ?
          WHERE uid = ?`,
        [credits, credits, now, uid]
      );
      const [rows] = await conn.execute(
        'SELECT balance FROM user_credits WHERE uid = ?',
        [uid]
      );
      const bal = rows[0] && typeof rows[0].balance === 'number' ? rows[0].balance : credits;

      await conn.execute(
        `INSERT INTO credit_transactions (uid, type, amount, balance_after, meta, created_at)
         VALUES (?, 'recharge_paid', ?, ?, ?, ?)`,
        [uid, credits, bal, JSON.stringify({ amount, channel: 'direct', currency: 'CNY' }), now]
      );

      // 审计订单(channel 枚举没有 direct,归到 mock,交易号前缀 DIRECT 标识来源)
      const orderId = `D${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      await conn.execute(
        `INSERT INTO recharge_orders
           (id, uid, channel, pay_amount, credits, status, qr_code_data, third_trade_no, fail_reason, created_at, expires_at, paid_at)
         VALUES (?, ?, 'mock', ?, ?, 'paid', NULL, ?, NULL, ?, ?, ?)`,
        [orderId, uid, amount, credits, `DIRECT${Date.now()}`, now, now, now]
      );

      return bal;
    });

    return ok({ balanceAfter, credits });
  } catch (err) {
    console.error('[direct-recharge] 失败:', err && err.message);
    return fail(500, err && err.message || '充值失败');
  }
};
