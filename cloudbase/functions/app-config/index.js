/**
 * 云函数: app-config
 *
 * 返回客户端可见的全局配置(剥离 apiKey 等敏感字段):
 *   - tokensPerCredit
 *   - aiModes.{fast,precise}.{provider, model, baseUrl}  (无 apiKey)
 *   - recharge.{minAmount, maxAmount, creditsPerYuan}
 *   - maintenance
 *
 * 鉴权: CloudBase 网关验签(防止未登录用户爬配置)。
 *
 * 部署:
 *   - 触发器: HTTP 访问服务,要求「注册用户」角色放行
 *   - 依赖: @cloudbase/node-sdk
 */

const cloudbase = require('@cloudbase/node-sdk');

const { ok, fail, handleOptions } = require('./lib/response');
const { requireAuth, authErrorResponse } = require('./lib/auth-helper');
const { getAppConfig, sanitizeForClient } = require('./lib/config-cache');

exports.main = async (event, context) => {
  const corsResp = handleOptions(event);
  if (corsResp) return corsResp;

  try {
    await requireAuth(event, context);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  try {
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
    const db = app.database();
    const config = await getAppConfig(db);
    const sanitized = sanitizeForClient(config);
    return ok({ config: sanitized });
  } catch (err) {
    console.error('[app-config] 失败:', err.message);
    return fail(500, err.message || '配置读取失败');
  }
};
