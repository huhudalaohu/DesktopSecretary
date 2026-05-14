/**
 * app_config 文档读取器,带 60s 内存缓存。
 * 云函数实例在不同请求间共享内存,所以这个缓存能跨请求复用。
 *
 * 用法:
 *   const config = await getAppConfig(db);
 *   config.tokensPerCredit; config.aiModes.fast.apiKey;
 */

const CACHE_TTL_MS = 60 * 1000;
let _cache = null;
let _cacheAt = 0;

const DEFAULT_CONFIG = {
  _id: 'global',
  tokensPerCredit: 1000,
  welcomeBonus: 500,
  aiModes: {
    // models 为有序数组,ai-proxy 顺序尝试,model_not_found / 404 / 5xx / 超时
    // 自动降级到下一个。model 字段为向后兼容,新部署只用 models。
    fast: { provider: '', model: '', models: [], baseUrl: '', apiKey: '' },
    precise: { provider: '', model: '', models: [], baseUrl: '', apiKey: '' },
  },
  recharge: { minAmount: 500, maxAmount: 100000, creditsPerYuan: 100 },
  payment: {
    provider: 'mock',
    enabled: true,
    orderExpireSeconds: 300,
    wechat: { mchid: '', certSerial: '', privateKey: '', apiV3Key: '', notifyUrl: '' },
    alipay: { appId: '', privateKey: '', alipayPublicKey: '', notifyUrl: '' },
  },
  dailyUidConsumeLimit: 500000,
  maintenance: false,
};

async function getAppConfig(db, { force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && (now - _cacheAt) < CACHE_TTL_MS) {
    return _cache;
  }
  try {
    const { data } = await db.collection('app_config').doc('global').get();
    const doc = Array.isArray(data) ? data[0] : data;
    if (doc) {
      _cache = { ...DEFAULT_CONFIG, ...doc };
      _cacheAt = now;
      return _cache;
    }
  } catch {
    // 文档不存在或读取失败,降级到默认值(仍然缓存,避免每次重试)
  }
  _cache = { ...DEFAULT_CONFIG };
  _cacheAt = now;
  return _cache;
}

/**
 * 返回给客户端的脱敏版本(剥掉所有 apiKey 与支付渠道私钥)
 */
function sanitizeForClient(config) {
  const c = JSON.parse(JSON.stringify(config));
  if (c.aiModes) {
    for (const mode of Object.keys(c.aiModes)) {
      if (c.aiModes[mode]) {
        delete c.aiModes[mode].apiKey;
      }
    }
  }
  if (c.payment) {
    if (c.payment.wechat) {
      delete c.payment.wechat.privateKey;
      delete c.payment.wechat.apiV3Key;
    }
    if (c.payment.alipay) {
      delete c.payment.alipay.privateKey;
    }
  }
  return c;
}

function clearCache() {
  _cache = null;
  _cacheAt = 0;
}

module.exports = { getAppConfig, sanitizeForClient, clearCache, DEFAULT_CONFIG };
