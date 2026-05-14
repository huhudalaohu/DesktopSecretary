/**
 * AI 调用统一收口 — callAI()。
 *
 * 所有客户端 AI 调用必须经此函数,绝不在客户端代码里直接 fetch 上游
 * (Kimi/Qwen/...)的 /chat/completions。
 *
 * 流程:
 *   1. 从 CloudBase Auth 拿 accessToken(SDK 自动续期)
 *   2. POST 到 ai-proxy 云函数
 *   3. 解析 _credits.balanceAfter,广播 'credits-updated' 事件供 UI 刷新
 *   4. 返回上游 AI 的标准 OpenAI 兼容响应(choices/usage 等)
 *
 * 错误码:
 *   - NOT_LOGGED_IN     未登录或 token 过期
 *   - INSUFFICIENT_CREDITS  余额不足(HTTP 402)
 *   - DAILY_LIMIT_EXCEEDED  当日 token 超限(HTTP 429)
 *   - MAINTENANCE       服务维护中(HTTP 503)
 *   - UPSTREAM_ERROR    上游 AI 失败(HTTP 502)
 *   - API_ERROR         其它
 */

import { getAccessToken } from './cloudbase';

const AI_PROXY_URL = typeof __AI_PROXY_URL__ !== 'undefined' ? __AI_PROXY_URL__ : '';
const GET_BALANCE_URL = typeof __GET_BALANCE_URL__ !== 'undefined' ? __GET_BALANCE_URL__ : '';
const APP_CONFIG_URL = typeof __APP_CONFIG_URL__ !== 'undefined' ? __APP_CONFIG_URL__ : '';
const CREATE_RECHARGE_URL = typeof __CREATE_RECHARGE_URL__ !== 'undefined' ? __CREATE_RECHARGE_URL__ : '';
const QUERY_ORDER_URL = typeof __QUERY_ORDER_URL__ !== 'undefined' ? __QUERY_ORDER_URL__ : '';
const MOCK_PAY_URL = typeof __MOCK_PAY_URL__ !== 'undefined' ? __MOCK_PAY_URL__ : '';

class CallAIError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

async function authedFetch(url, body) {
  if (!url) throw new CallAIError('CONFIG_MISSING', '云函数 URL 未配置');

  const token = await getAccessToken();
  if (!token || !token.accessToken) {
    throw new CallAIError('NOT_LOGGED_IN', '请先登录');
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
    });
  } catch (err) {
    throw new CallAIError('NETWORK_ERROR', err.message || '网络错误');
  }

  let data = null;
  const text = await resp.text().catch(() => '');
  if (text) {
    try { data = JSON.parse(text); } catch {}
  }

  if (resp.status === 401) {
    const debugInfo = {
      url,
      body: text,
      headers: Object.fromEntries(resp.headers.entries()),
      tokenPrefix: token.accessToken.slice(0, 40),
      tokenLen: token.accessToken.length,
    };
    console.error('[ai-proxy] 401 详情 JSON:', JSON.stringify(debugInfo, null, 2));
    throw new CallAIError('NOT_LOGGED_IN', (data && data.error) || '登录已过期,请重新登录');
  }
  if (resp.status === 402) {
    throw new CallAIError('INSUFFICIENT_CREDITS', '积分不足', { balance: data && data.balance });
  }
  if (resp.status === 429) {
    throw new CallAIError('DAILY_LIMIT_EXCEEDED', '当日用量已用完', {
      usedToday: data && data.usedToday,
      dailyLimit: data && data.dailyLimit,
    });
  }
  if (resp.status === 503) {
    throw new CallAIError('MAINTENANCE', '服务维护中,请稍后再试');
  }
  if (resp.status === 502) {
    throw new CallAIError('UPSTREAM_ERROR', (data && data.error) || '上游 AI 服务异常', {
      detail: data && data.detail,
      upstreamStatus: data && data.upstreamStatus,
    });
  }
  if (!resp.ok) {
    const serverCode = data && data.code;
    throw new CallAIError(serverCode || 'API_ERROR', (data && data.error) || `HTTP ${resp.status}`, {
      status: resp.status,
      ...(data || {}),
    });
  }
  return data;
}

/**
 * 调 AI(经 ai-proxy 云函数中转,自动扣分)。
 *
 * @param {{ mode?: 'fast'|'precise', messages, temperature?, max_tokens? }} opts
 * @returns OpenAI 兼容响应,额外含 _credits: { used, balanceAfter, mode, totalTokens }
 */
export async function callAI({ mode = 'fast', messages, temperature, max_tokens }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new CallAIError('INVALID_PARAM', 'messages 不能为空');
  }
  const body = { mode, messages };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (typeof max_tokens === 'number') body.max_tokens = max_tokens;

  const data = await authedFetch(AI_PROXY_URL, body);

  // 广播余额更新事件供 UI 刷新
  if (data && data._credits && typeof data._credits.balanceAfter === 'number') {
    try {
      window.dispatchEvent(new CustomEvent('credits-updated', {
        detail: {
          balance: data._credits.balanceAfter,
          used: data._credits.used,
          mode: data._credits.mode,
          totalTokens: data._credits.totalTokens,
        },
      }));
    } catch {}
  }

  return data;
}

/**
 * 拉取当前用户余额 + 最近流水。
 * @returns {{ balance, totalRecharged, totalConsumed, recentTransactions }}
 */
export async function fetchBalance() {
  const data = await authedFetch(GET_BALANCE_URL, {});
  return {
    balance: data.balance || 0,
    totalRecharged: data.totalRecharged || 0,
    totalConsumed: data.totalConsumed || 0,
    recentTransactions: data.recentTransactions || [],
  };
}

/**
 * 拉取脱敏后的全局配置(模式列表/倍率/充值参数等,无 apiKey)。
 */
export async function fetchAppConfig() {
  const data = await authedFetch(APP_CONFIG_URL, {});
  return data && data.config ? data.config : null;
}

/**
 * 创建一笔充值订单。
 *
 * @param {{ amount: number }} opts amount 单位:分,范围由 app_config.recharge 控制
 * @returns {{ orderId, qrCodeData, expiresAt, credits, payAmount, channel }}
 */
export async function createRechargeOrder({ amount }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CallAIError('INVALID_PARAM', '充值金额无效');
  }
  const data = await authedFetch(CREATE_RECHARGE_URL, { amount: Math.floor(amount) });
  return {
    orderId: data.orderId,
    qrCodeData: data.qrCodeData,
    expiresAt: data.expiresAt,
    credits: data.credits,
    payAmount: data.payAmount,
    channel: data.channel,
  };
}

/**
 * 查询订单状态。客户端在 RechargeModal 里每 2s 轮一次。
 *
 * @param {string} orderId
 * @returns {{ status, paidAt, payAmount, credits, expiresAt, channel }}
 */
export async function queryOrder(orderId) {
  if (!orderId) throw new CallAIError('INVALID_PARAM', 'orderId 必填');
  const data = await authedFetch(QUERY_ORDER_URL, { orderId });
  return {
    status: data.status,
    paidAt: data.paidAt || null,
    payAmount: data.payAmount,
    credits: data.credits,
    expiresAt: data.expiresAt,
    channel: data.channel,
  };
}

/**
 * MOCK 阶段:模拟支付成功。生产环境(app_config.payment.provider !== 'mock')
 * 服务端会直接返回 403,客户端不应在这种情况下调用此方法。
 *
 * 成功后会广播 'credits-updated' 事件让 UI 立即刷新余额。
 *
 * @param {string} orderId
 * @returns {{ success, balanceAfter, credits }}
 */
export async function mockPayOrder(orderId) {
  if (!orderId) throw new CallAIError('INVALID_PARAM', 'orderId 必填');
  const data = await authedFetch(MOCK_PAY_URL, { orderId });

  if (data && typeof data.balanceAfter === 'number') {
    try {
      window.dispatchEvent(new CustomEvent('credits-updated', {
        detail: {
          balance: data.balanceAfter,
          credited: data.credits,
          source: 'recharge_paid',
        },
      }));
    } catch {}
  }

  return {
    success: !!data.success,
    balanceAfter: data.balanceAfter,
    credits: data.credits,
  };
}

export { CallAIError };
