/**
 * 云函数: create-recharge(MySQL 版)
 *
 * 为当前登录用户创建一笔充值订单。
 *
 * 鉴权: 走 CloudBase 网关验签的 AccessToken。
 *
 * 入参:
 *   { amount: number }    // 单位:分,如 1000 = ¥10
 *
 * 校验:
 *   - 金额必须是整数,在 app_config.recharge.minAmount ~ maxAmount 之间
 *   - app_config.payment.enabled 必须为 true,否则 503
 *
 * 流程:
 *   1. 网关验签后读 uid
 *   2. 读 app_config(60s 缓存) — 仍在 doc DB
 *   3. 算 credits = amount/100 * creditsPerYuan(整数化)
 *   4. 生成 orderId = R{ts}{6位随机}
 *   5. 当 provider === 'mock' 时返回占位 SVG 当二维码;真渠道接入时由各 provider 适配器替换
 *   6. INSERT recharge_orders 行 — MySQL
 *
 * 返回:
 *   { orderId, qrCodeData, expiresAt, credits, payAmount, channel }
 *
 * 存储:
 *   - app_config       → doc DB
 *   - recharge_orders  → MySQL
 *
 * 部署:
 *   - 触发器: HTTP 访问服务,要求「注册用户」角色放行
 *   - 环境变量: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 *   - 依赖: @cloudbase/node-sdk + mysql2
 */

const cloudbase = require('@cloudbase/node-sdk');

const { ok, fail, handleOptions, parseBody } = require('./lib/response');
const { requireAuth, authErrorResponse } = require('./lib/auth-helper');
const { getAppConfig } = require('./lib/config-cache');
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
  const amount = Math.floor(Number(body && body.amount) || 0);

  try {
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
    const db = app.database();

    const config = await getAppConfig(db);
    const rechargeCfg = config.recharge || {};
    const paymentCfg = config.payment || { provider: 'mock', enabled: true, orderExpireSeconds: 300 };

    if (paymentCfg.enabled === false) {
      return fail(503, '充值暂时关闭,请稍后再试', { code: 'PAYMENT_DISABLED' });
    }

    const minAmount = Number(rechargeCfg.minAmount) || 500;
    const maxAmount = Number(rechargeCfg.maxAmount) || 100000;
    const creditsPerYuan = Number(rechargeCfg.creditsPerYuan) || 100;

    if (!Number.isInteger(amount) || amount < minAmount || amount > maxAmount) {
      return fail(400, `金额必须为整数分,且在 ¥${(minAmount / 100).toFixed(2)}~¥${(maxAmount / 100).toFixed(2)} 之间`, {
        code: 'INVALID_AMOUNT',
        minAmount,
        maxAmount,
      });
    }

    const credits = Math.floor((amount / 100) * creditsPerYuan);
    if (credits <= 0) {
      return fail(400, '充值积分计算异常', { code: 'CREDITS_ZERO' });
    }

    const orderExpireSeconds = Math.max(60, Number(paymentCfg.orderExpireSeconds) || 300);
    const provider = paymentCfg.provider || 'mock';
    const orderId = generateOrderId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + orderExpireSeconds * 1000);

    let qrCodeData = '';
    if (provider === 'mock') {
      qrCodeData = generateMockQrSvg(orderId, amount);
    } else {
      return fail(501, `provider=${provider} 暂未接入,请联系管理员`, { code: 'PROVIDER_NOT_IMPLEMENTED' });
    }

    const conn = await getConnection();
    await conn.execute(
      `INSERT INTO recharge_orders
         (id, uid, channel, pay_amount, credits, status, qr_code_data, third_trade_no, fail_reason, created_at, expires_at, paid_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, NULL)`,
      [orderId, uid, provider, amount, credits, qrCodeData, now, expiresAt]
    );

    return ok({
      orderId,
      qrCodeData,
      expiresAt,
      credits,
      payAmount: amount,
      channel: provider,
    });
  } catch (err) {
    console.error('[create-recharge] 失败:', err.message);
    return fail(500, err.message || '创建订单失败');
  }
};

function generateOrderId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `R${ts}${rand}`;
}

/**
 * MOCK 阶段生成一个占位 SVG 当作"二维码"。
 * 客户端直接用这串 data URL 当 <img src>,无需真支付流程。
 */
function generateMockQrSvg(orderId, amount) {
  const yuan = (amount / 100).toFixed(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="#fff" stroke="#999" stroke-width="2"/>
  <rect x="20" y="20" width="40" height="40" fill="#000"/>
  <rect x="140" y="20" width="40" height="40" fill="#000"/>
  <rect x="20" y="140" width="40" height="40" fill="#000"/>
  <rect x="70" y="70" width="60" height="10" fill="#000"/>
  <rect x="70" y="90" width="60" height="10" fill="#000"/>
  <rect x="70" y="110" width="60" height="10" fill="#000"/>
  <text x="100" y="170" font-size="10" text-anchor="middle" fill="#666">MOCK ¥${yuan}</text>
  <text x="100" y="185" font-size="8" text-anchor="middle" fill="#999">${orderId.slice(0, 16)}...</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
