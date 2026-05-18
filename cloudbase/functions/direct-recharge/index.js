/**
 * 云函数: direct-recharge (doc DB 版)
 *
 * 一步直达充值:输入金额 → 立即加积分 → 写流水 → 返回新余额。
 * 使用 doc DB 操作 user_credits / credit_transactions / recharge_orders,
 * 避免 MySQL VPC 网络不通问题。
 *
 * 鉴权: 自验 JWT (从 Authorization header 提取)。
 *
 * 入参: { amount: number }  // 单位:分,如 1000 = ¥10
 * 返回: { balanceAfter, credits }
 */

const cloudbase = require('@cloudbase/node-sdk');

const { ok, fail, handleOptions, parseBody } = require('./lib/response');
const { requireAuth, authErrorResponse } = require('./lib/auth-helper');
const { getAppConfig } = require('./lib/config-cache');

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
    const _ = db.command;
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

    const now = new Date();

    // 1. 确保 user_credits 文档存在(懒初始化),同时原子加积分
    const creditsDoc = await db.collection('user_credits').doc(uid).get();
    const exists = creditsDoc.data && (Array.isArray(creditsDoc.data) ? creditsDoc.data.length > 0 : !!creditsDoc.data);

    if (!exists) {
      const welcomeBonus = Number(config.welcomeBonus) || 500;
      await db.collection('user_credits').add({
        _id: uid,
        balance: welcomeBonus + credits,
        totalRecharged: welcomeBonus + credits,
        totalConsumed: 0,
        welcomedAt: now,
        updatedAt: now,
      });
      // 写欢迎流水
      await db.collection('credit_transactions').add({
        uid,
        type: 'recharge_gift',
        amount: welcomeBonus,
        balanceAfter: welcomeBonus + credits,
        meta: { reason: 'welcome' },
        createdAt: now,
      });
    } else {
      // 原子加积分
      await db.collection('user_credits').doc(uid).update({
        balance: _.inc(credits),
        totalRecharged: _.inc(credits),
        updatedAt: now,
      });
    }

    // 2. 读 balanceAfter
    const updatedDoc = await db.collection('user_credits').doc(uid).get();
    const updatedData = Array.isArray(updatedDoc.data) ? updatedDoc.data[0] : updatedDoc.data;
    const balanceAfter = (updatedData && typeof updatedData.balance === 'number')
      ? updatedData.balance
      : credits;

    // 3. 写消费流水(recharge_paid)
    await db.collection('credit_transactions').add({
      uid,
      type: 'recharge_paid',
      amount: credits,
      balanceAfter,
      meta: { amount, channel: 'direct', currency: 'CNY' },
      createdAt: now,
    });

    // 4. 写审计订单记录
    const orderId = `D${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    await db.collection('recharge_orders').add({
      _id: orderId,
      uid,
      channel: 'direct',
      payAmount: amount,
      credits,
      status: 'paid',
      qrCodeData: null,
      thirdTradeNo: `DIRECT${Date.now()}`,
      failReason: null,
      createdAt: now,
      expiresAt: now,
      paidAt: now,
    });

    return ok({ balanceAfter, credits });
  } catch (err) {
    console.error('[direct-recharge] 失败:', err && err.message);
    return fail(500, err && err.message || '充值失败');
  }
};
