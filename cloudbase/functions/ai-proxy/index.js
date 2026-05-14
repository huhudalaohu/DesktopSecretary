/**
 * 云函数: ai-proxy(MySQL 版)
 *
 * 把客户端的 AI 调用转发给上游 (Kimi/通义/...) 并按 token 用量扣积分。
 *
 * 鉴权:
 *   走 CloudBase 网关验签的 AccessToken,uid 从 event.userInfo / context.extendedContext 拿。
 *   本函数自身不做 JWT 校验,密钥不暴露。
 *
 * 入参:
 *   {
 *     mode: 'fast' | 'precise',          // 必填,选择 app_config.aiModes 里哪一组配置
 *     messages: [{ role, content }, ...], // OpenAI 兼容格式
 *     temperature?: number,
 *     max_tokens?: number,
 *   }
 *
 * 流程:
 *   1. 网关验签后读 uid
 *   2. 读 app_config(60s 缓存) → 维护模式拦截     (doc DB)
 *   3. 懒初始化 user_credits:不存在 → 送 welcomeBonus  (MySQL)
 *   4. 余额 ≤0 → 402 INSUFFICIENT_CREDITS
 *   5. 当日 token 累计 ≥dailyUidConsumeLimit → 429    (MySQL JSON aggregate)
 *   6. fetch 上游 OpenAI 兼容 /chat/completions
 *   7. 取 usage.total_tokens(或 prompt+completion,再无则估算)
 *   8. **事务**:UPDATE user_credits 扣分 + INSERT credit_transactions 流水
 *   9. 返回 { ...上游响应, _credits: {used, balanceAfter, mode, totalTokens} }
 *
 * 上游错误(4xx/5xx)不扣分,直接透传。
 *
 * 存储:
 *   - app_config              → doc DB
 *   - user_credits            → MySQL
 *   - credit_transactions     → MySQL(append-only + JSON meta)
 *
 * 部署:
 *   - 运行环境: Node.js 16+
 *   - 触发器: HTTP 访问服务,要求「注册用户」角色放行(默认放行)
 *   - 环境变量: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 *   - 依赖: @cloudbase/node-sdk + mysql2
 */

const cloudbase = require('@cloudbase/node-sdk');

const { ok, fail, handleOptions, parseBody } = require('./lib/response');
const { requireAuth, authErrorResponse } = require('./lib/auth-helper');
const { getAppConfig } = require('./lib/config-cache');
const { ensureUserCredits } = require('./lib/credits-init');
const { getConnection, tx } = require('./lib/mysql');

const VALID_MODES = ['fast', 'precise'];
const UPSTREAM_TIMEOUT_MS = 60 * 1000;

exports.main = async (event, context) => {
  const corsResp = handleOptions(event);
  if (corsResp) return corsResp;

  // 1. 鉴权(云函数自验 JWT — 详见 lib/auth-helper.js)
  let auth;
  try {
    auth = await requireAuth(event, context);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const uid = auth.uid;

  // 2. 解析入参
  let body;
  try {
    body = parseBody(event);
  } catch {
    return fail(400, '请求体格式错误');
  }
  const { mode, messages, temperature, max_tokens } = body || {};

  if (!VALID_MODES.includes(mode)) {
    return fail(400, `mode 必须是 ${VALID_MODES.join(' 或 ')}`);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return fail(400, 'messages 不能为空');
  }

  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
  const db = app.database();

  // 3. 读配置(doc DB)
  let config;
  try {
    config = await getAppConfig(db);
  } catch (err) {
    console.error('[ai-proxy] 读取配置失败:', err.message);
    return fail(500, '配置读取失败');
  }
  if (config.maintenance) {
    return fail(503, '服务维护中,请稍后重试');
  }

  const modeConfig = config.aiModes && config.aiModes[mode];
  const candidateModels = resolveModelCandidates(modeConfig);
  if (!modeConfig || !modeConfig.apiKey || !modeConfig.baseUrl || candidateModels.length === 0) {
    console.error('[ai-proxy] 模式配置缺失:', mode);
    return fail(500, `${mode} 模式未配置,请联系管理员`);
  }

  // 4. 懒初始化 + 余额检查(MySQL)
  let balanceBefore;
  try {
    const doc = await ensureUserCredits(uid, config);
    balanceBefore = doc.balance || 0;
  } catch (err) {
    console.error('[ai-proxy] 初始化用户积分失败:', err.message);
    return fail(500, '初始化用户积分失败');
  }
  if (balanceBefore <= 0) {
    return fail(402, 'INSUFFICIENT_CREDITS', { balance: balanceBefore });
  }

  // 5. 当日用量限制(MySQL JSON aggregate)
  const dailyLimit = Number(config.dailyUidConsumeLimit) || 0;
  if (dailyLimit > 0) {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const conn = await getConnection();
      // CAST(JSON_UNQUOTE(JSON_EXTRACT(...))) — 比 JSON_VALUE 兼容性好(不依赖 MySQL 8.0.4+)
      const [rows] = await conn.execute(
        `SELECT COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.totalTokens')) AS UNSIGNED)), 0) AS used_today
           FROM credit_transactions
          WHERE uid = ? AND type = 'consume' AND created_at >= ?`,
        [uid, startOfDay]
      );
      const usedToday = Number(rows[0] && rows[0].used_today) || 0;
      if (usedToday >= dailyLimit) {
        return fail(429, 'DAILY_LIMIT_EXCEEDED', { usedToday, dailyLimit });
      }
    } catch (err) {
      console.warn('[ai-proxy] 日用量聚合失败:', err.message);
    }
  }

  // 6. 调上游(按 candidateModels 顺序尝试,retryable 失败自动降级)
  const upstreamUrl = joinUrl(modeConfig.baseUrl, '/chat/completions');
  const attemptLog = [];
  let upstreamData = null;
  let usedModel = null;
  let lastError = null;

  for (const m of candidateModels) {
    const upstreamPayload = {
      model: m,
      messages,
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(typeof max_tokens === 'number' ? { max_tokens } : {}),
      stream: false,
    };

    let resp;
    try {
      resp = await fetchWithTimeout(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${modeConfig.apiKey}`,
        },
        body: JSON.stringify(upstreamPayload),
      }, UPSTREAM_TIMEOUT_MS);
    } catch (err) {
      lastError = { model: m, kind: 'network', message: err.message };
      attemptLog.push(lastError);
      console.warn(`[ai-proxy] 模型 ${m} 网络错误,尝试下一个:`, err.message);
      continue;
    }

    if (resp.ok) {
      try {
        upstreamData = await resp.json();
        usedModel = m;
      } catch (err) {
        lastError = { model: m, kind: 'parse', message: err.message };
        attemptLog.push(lastError);
        console.warn(`[ai-proxy] 模型 ${m} 响应解析失败,尝试下一个:`, err.message);
        continue;
      }
      break;
    }

    let detailText = '';
    try { detailText = await resp.text(); } catch {}

    if (isRetryableUpstream(resp.status, detailText)) {
      lastError = {
        model: m,
        kind: 'upstream_retryable',
        status: resp.status,
        body: safeTruncate(detailText, 500),
      };
      attemptLog.push(lastError);
      console.warn(`[ai-proxy] 模型 ${m} 失败(${resp.status}),尝试下一个:`, safeTruncate(detailText, 200));
      continue;
    }

    console.error(`[ai-proxy] 模型 ${m} 不可重试错(${resp.status}):`, safeTruncate(detailText, 500));
    return fail(502, `上游 AI 返回 ${resp.status}`, {
      upstreamStatus: resp.status,
      upstreamBody: safeTruncate(detailText, 1000),
      model: m,
      attempts: attemptLog,
    });
  }

  if (!upstreamData) {
    console.error('[ai-proxy] 全部候选模型均失败:', JSON.stringify(attemptLog));
    return fail(502, '上游 AI 服务不可用', { attempts: attemptLog });
  }

  // 7. 计算 token 用量 + 扣分
  const totalTokens = extractTotalTokens(upstreamData, messages);
  const tokensPerCredit = Math.max(1, Number(config.tokensPerCredit) || 1000);
  const credits = Math.max(1, Math.ceil(totalTokens / tokensPerCredit));

  // 8. 事务:扣余额 + 写流水(任一步失败整体回滚,避免余额扣了流水没写或反之)
  let balanceAfter;
  try {
    balanceAfter = await tx(async (conn) => {
      const now = new Date();
      // 单语句原子扣减,SET 表达式里使用旧值,MySQL InnoDB 隐式行锁
      await conn.execute(
        `UPDATE user_credits
            SET balance        = balance - ?,
                total_consumed = total_consumed + ?,
                updated_at     = ?
          WHERE uid = ?`,
        [credits, credits, now, uid]
      );
      const [rows] = await conn.execute(
        'SELECT balance FROM user_credits WHERE uid = ?',
        [uid]
      );
      const bal = rows[0] && typeof rows[0].balance === 'number' ? rows[0].balance : balanceBefore - credits;

      const meta = {
        mode,
        provider: modeConfig.provider || '',
        model: usedModel,
        modelFallbacks: attemptLog.length,
        totalTokens,
        promptTokens: (upstreamData && upstreamData.usage && upstreamData.usage.prompt_tokens) || 0,
        completionTokens: (upstreamData && upstreamData.usage && upstreamData.usage.completion_tokens) || 0,
      };
      await conn.execute(
        `INSERT INTO credit_transactions (uid, type, amount, balance_after, meta, created_at)
         VALUES (?, 'consume', ?, ?, ?, ?)`,
        [uid, -credits, bal, JSON.stringify(meta), now]
      );
      return bal;
    });
  } catch (err) {
    // 事务失败 → 上游已扣到 token 但我们没扣分。打日志,把响应仍然返回给用户
    // (与 doc DB 版"扣减失败 fail(500)"行为不同:这里更宽松,先把 AI 结果返回,
    // 否则用户既不能用结果也已经被 OpenAI 计费,体验更差。监控异常告警另说。)
    console.error('[ai-proxy] 扣减事务失败:', err && err.message);
    balanceAfter = balanceBefore;  // 占位,告知前端余额未变
  }

  return ok({
    ...upstreamData,
    _credits: {
      used: credits,
      balanceAfter,
      mode,
      totalTokens,
      model: usedModel,
      fallbacks: attemptLog.length,
    },
  });
};

// ---------- 工具函数 ----------

function resolveModelCandidates(modeConfig) {
  if (!modeConfig) return [];
  const list = [];
  if (Array.isArray(modeConfig.models)) {
    for (const m of modeConfig.models) {
      if (typeof m === 'string' && m && !list.includes(m)) list.push(m);
    }
  }
  if (list.length === 0 && typeof modeConfig.model === 'string' && modeConfig.model) {
    list.push(modeConfig.model);
  }
  return list;
}

function isRetryableUpstream(status, body) {
  if (status === 404 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status >= 400 && status < 500 && status !== 401 && status !== 403) {
    const s = (body || '').toLowerCase();
    if (s.includes('model_not_found')) return true;
    if (s.includes('modelnotfound')) return true;
    if (s.includes('invalidparameter.model')) return true;
    if (s.includes('does not exist') && s.includes('model')) return true;
    if (s.includes('model') && s.includes('not found')) return true;
    if (s.includes('unsupported model')) return true;
  }
  return false;
}

function joinUrl(base, path) {
  if (!base) return path;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return b + p;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractTotalTokens(upstreamData, messages) {
  const usage = upstreamData && upstreamData.usage;
  if (usage) {
    if (typeof usage.total_tokens === 'number') return usage.total_tokens;
    const p = Number(usage.prompt_tokens) || 0;
    const c = Number(usage.completion_tokens) || 0;
    if (p || c) return p + c;
  }
  let approx = 0;
  for (const m of messages || []) {
    approx += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
  }
  const reply = upstreamData && upstreamData.choices && upstreamData.choices[0]
    && upstreamData.choices[0].message && upstreamData.choices[0].message.content;
  if (typeof reply === 'string') approx += estimateTokens(reply);
  return Math.max(1, approx);
}

function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0, ascii = 0;
  for (const ch of text) {
    if (/[一-鿿　-〿＀-￯]/.test(ch)) cjk++;
    else ascii++;
  }
  return cjk * 2 + Math.ceil(ascii / 4);
}

function safeTruncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '...' : s;
}
