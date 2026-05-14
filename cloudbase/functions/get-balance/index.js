/**
 * 云函数: get-balance(MySQL 版)
 *
 * 查询当前登录用户的:
 *   - balance / totalRecharged / totalConsumed
 *   - 最近 20 条流水
 *
 * 鉴权: CloudBase 网关验签后从 event.userInfo / context.extendedContext 拿 uid。
 *
 * 关键行为: **首次调用会懒初始化 user_credits + 发 500 welcome 积分**。
 * 这样无论用户从注册、登录、还是直接调 ai-proxy 进来,都能拿到正确余额。
 * 已发放过(welcomed_at IS NOT NULL)的账号不会重复发,详见 _shared/credits-init.js。
 *
 * 存储:
 *   - app_config       → doc DB(由 config-cache 读)
 *   - user_credits     → MySQL(由 credits-init / 本函数读)
 *   - credit_transactions → MySQL(本函数读最近 20 条)
 *
 * 部署:
 *   - 触发器: HTTP 访问服务,要求「注册用户」角色放行
 *   - 依赖: @cloudbase/node-sdk + mysql2
 *   - 环境变量: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
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

    // 1. 读 app_config(只为拿 welcomeBonus)— 仍在 doc DB
    const config = await getAppConfig(db);

    // 2. 懒初始化 + 拿当前积分(已存在则直接 SELECT 返回)— MySQL
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
      const [rows] = await conn.execute(
        `SELECT type, amount, balance_after, meta, created_at
           FROM credit_transactions
          WHERE uid = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ${RECENT_TX_LIMIT}`,
        [uid]
      );
      recentTransactions = rows.map((r) => ({
        type: r.type,
        amount: r.amount,
        balanceAfter: r.balance_after,
        meta: parseMeta(r.meta),
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

/**
 * mysql2 默认会把 JSON 列解析成 object,但驱动版本/连接参数不一致时
 * 也可能返回字符串。这里兜一下,确保客户端拿到的 meta 总是 object。
 */
function parseMeta(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}
