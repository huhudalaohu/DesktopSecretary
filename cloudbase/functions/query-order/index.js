/**
 * 云函数: query-order(MySQL 版)
 *
 * 查询指定订单的状态。客户端在 RechargeModal 里每 2s 轮一次,
 * 直到看到 status 不再是 'pending'。
 *
 * 鉴权: 网关验签后从 event.userInfo / context.extendedContext 拿 uid。
 *       不允许跨用户查询(订单 uid 与调用者 uid 不一致返回 404)。
 *
 * 入参:
 *   { orderId }
 *
 * 副作用:
 *   - 状态仍 pending 且已过 expires_at → 顺手更新为 'expired'
 *
 * 返回:
 *   { status, paidAt, payAmount, credits, expiresAt, channel }
 *
 * 部署:
 *   - 触发器: HTTP 访问服务,「注册用户」放行
 *   - 环境变量: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 *   - 依赖: @cloudbase/node-sdk + mysql2
 */

const { ok, fail, handleOptions, parseBody } = require('./lib/response');
const { requireAuth, authErrorResponse } = require('./lib/auth-helper');
const { getConnection } = require('./lib/mysql');

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
  const orderId = body && body.orderId;
  if (!orderId || typeof orderId !== 'string') {
    return fail(400, 'orderId 必填');
  }

  try {
    const conn = await getConnection();

    // 1. 先尝试懒过期(只影响 pending 且已过期的行,幂等)
    await conn.execute(
      `UPDATE recharge_orders
          SET status = 'expired'
        WHERE id = ? AND uid = ? AND status = 'pending' AND expires_at < NOW()`,
      [orderId, uid]
    );

    // 2. 再读最新状态
    const [rows] = await conn.execute(
      `SELECT uid, status, paid_at, pay_amount, credits, expires_at, channel
         FROM recharge_orders
        WHERE id = ?`,
      [orderId]
    );
    if (rows.length === 0 || rows[0].uid !== uid) {
      return fail(404, '订单不存在', { code: 'NOT_FOUND' });
    }
    const order = rows[0];

    return ok({
      status: order.status,
      paidAt: order.paid_at || null,
      payAmount: order.pay_amount,
      credits: order.credits,
      expiresAt: order.expires_at,
      channel: order.channel,
    });
  } catch (err) {
    console.error('[query-order] 失败:', err.message);
    return fail(500, err.message || '查询订单失败');
  }
};
