/**
 * 云函数: mock-pay(MySQL 版,单事务包裹三步操作)
 *
 * MOCK 阶段(无真实商户号)用来模拟"支付成功":
 *   - 把订单 pending → paid(乐观锁,WHERE status='pending' 防并发重复扣)
 *   - 给用户加积分(原子 UPDATE)
 *   - 写 credit_transactions:type=recharge_paid
 *
 * **MySQL 版相对 doc DB 版的最大改进**:
 *   doc DB 版本三步是分开执行(update order → update credits → add transaction),
 *   任一步崩了都会留下半成品(订单 paid 了但积分没加,或加了分但流水没写)。
 *   MySQL 版用 tx() 整体包裹,失败回滚,要么全成要么全无。
 *
 * 生产环境守门:
 *   读 app_config.payment.provider,只在 'mock' 时允许调用,否则 403。
 *   接入真渠道前千万别把这个函数挂到生产 URL。
 *
 * 鉴权:
 *   网关验签后从 event.userInfo 拿 uid。订单 uid 与调用者 uid 不一致 → 404。
 *
 * 入参:
 *   { orderId }
 *
 * 返回:
 *   { success, balanceAfter, credits }
 *
 * 存储:
 *   - app_config              → doc DB(读 provider 守门)
 *   - recharge_orders         → MySQL
 *   - user_credits            → MySQL
 *   - credit_transactions     → MySQL
 *
 * 部署:
 *   - 触发器: HTTP 访问服务,「注册用户」放行
 *   - 环境变量: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 *   - 依赖: @cloudbase/node-sdk + mysql2
 */

const cloudbase = require('@cloudbase/node-sdk');

const { ok, fail, handleOptions, parseBody } = require('./lib/response');
const { requireAuth, authErrorResponse } = require('./lib/auth-helper');
const { getAppConfig } = require('./lib/config-cache');
const { tx, BizError } = require('./lib/mysql');

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

  // 守门:provider 不是 mock 直接拒绝
  try {
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
    const db = app.database();
    const config = await getAppConfig(db);
    const provider = (config.payment && config.payment.provider) || 'mock';
    if (provider !== 'mock') {
      return fail(403, '生产环境禁用 mock-pay', { code: 'MOCK_DISABLED' });
    }
  } catch (err) {
    console.error('[mock-pay] 读取配置失败:', err.message);
    return fail(500, '配置读取失败');
  }

  const now = new Date();
  const mockTradeNo = `MOCK${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

  try {
    const result = await tx(async (conn) => {
      // 1. 行锁 + 读订单(确保订单存在 + 归属当前用户 + 当前是 pending + 未过期)
      const [orderRows] = await conn.execute(
        `SELECT uid, status, pay_amount, credits, expires_at
           FROM recharge_orders
          WHERE id = ?
          FOR UPDATE`,
        [orderId]
      );
      if (orderRows.length === 0 || orderRows[0].uid !== uid) {
        throw new BizError(404, 'NOT_FOUND', '订单不存在');
      }
      const order = orderRows[0];
      if (order.status !== 'pending') {
        throw new BizError(409, 'ORDER_NOT_PENDING', `订单状态为 ${order.status},无法支付`);
      }
      if (new Date(order.expires_at) < now) {
        // 顺手在事务内标记 expired(整体一致)
        await conn.execute(
          `UPDATE recharge_orders SET status = 'expired' WHERE id = ?`,
          [orderId]
        );
        throw new BizError(410, 'ORDER_EXPIRED', '订单已过期');
      }

      // 2. 改订单状态(再次 WHERE status='pending' 兜底,即使有 FOR UPDATE 也加一层防御)
      const [r1] = await conn.execute(
        `UPDATE recharge_orders
            SET status         = 'paid',
                paid_at        = ?,
                third_trade_no = ?
          WHERE id = ? AND status = 'pending'`,
        [now, mockTradeNo, orderId]
      );
      if (r1.affectedRows !== 1) {
        throw new BizError(409, 'ORDER_CONFLICT', '订单状态已变更,无法重复支付');
      }

      // 3. 加积分:INSERT ... ON DUPLICATE KEY UPDATE 同时覆盖"行不存在"与"行已存在"两种情况
      //    新行:balance/total_recharged 初始化为本次 credits,welcomed_at 设为 now(阻止 welcome
      //    重复发,与 doc DB 版本回退逻辑一致 — 走过充值流程的用户不会再拿 welcome bonus)
      //    旧行:balance += credits,total_recharged += credits,其余字段不动
      await conn.execute(
        `INSERT INTO user_credits (uid, balance, total_recharged, total_consumed, welcomed_at, updated_at)
              VALUES (?, ?, ?, 0, ?, ?)
         ON DUPLICATE KEY UPDATE
              balance         = balance + VALUES(balance),
              total_recharged = total_recharged + VALUES(total_recharged),
              updated_at      = VALUES(updated_at)`,
        [uid, order.credits, order.credits, now, now]
      );

      // 4. 读真实 balanceAfter
      const [credRows] = await conn.execute(
        'SELECT balance FROM user_credits WHERE uid = ?',
        [uid]
      );
      const balanceAfter = (credRows[0] && typeof credRows[0].balance === 'number')
        ? credRows[0].balance
        : order.credits;

      // 5. 写流水
      const meta = {
        orderId,
        payAmount: order.pay_amount,
        channel: 'mock',
        thirdTradeNo: mockTradeNo,
      };
      await conn.execute(
        `INSERT INTO credit_transactions (uid, type, amount, balance_after, meta, created_at)
              VALUES (?, 'recharge_paid', ?, ?, ?, ?)`,
        [uid, order.credits, balanceAfter, JSON.stringify(meta), now]
      );

      return { balanceAfter, credits: order.credits };
    });

    return ok({
      success: true,
      balanceAfter: result.balanceAfter,
      credits: result.credits,
    });
  } catch (err) {
    if (err instanceof BizError) {
      return fail(err.statusCode, err.message, { code: err.code });
    }
    console.error('[mock-pay] 失败:', err && err.message);
    return fail(500, err && err.message || '支付失败');
  }
};
