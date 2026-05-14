/**
 * CloudBase 身份认证客户端单例。
 *
 * 渲染进程通过此模块直连 CloudBase 身份认证服务,完成邮箱密码注册/登录、
 * 邮箱验证码登录,并自动维护 AccessToken / RefreshToken(localStorage 持久化)。
 *
 * 鉴权后调用云函数(ai-proxy / get-balance / app-config / ...)只需在 fetch
 * 头里带上 `Authorization: Bearer <accessToken>`,网关层会自动验签。
 *
 * 使用前请确保:
 * 1. CloudBase 控制台 → 身份认证 → 启用「邮箱密码登录」「邮箱验证码登录」
 * 2. .env 文件配置 TCB_ENV_ID(默认 ds-dev-d9g28xlrgd2600837)和 TCB_REGION(默认 ap-shanghai)
 */

import cloudbase from '@cloudbase/js-sdk';

const ENV_ID = typeof __TCB_ENV_ID__ !== 'undefined' ? __TCB_ENV_ID__ : '';
const REGION = typeof __TCB_REGION__ !== 'undefined' ? __TCB_REGION__ : 'ap-shanghai';

if (!ENV_ID) {
  console.error('[cloudbase] 未配置 TCB_ENV_ID,请检查 .env');
}

const app = cloudbase.init({ env: ENV_ID, region: REGION });
export const auth = app.auth({ persistence: 'local' });

/**
 * SDK v2.28.5 bug workaround:
 *
 * 1. LocalCredentials.setCredentials() clears storage when credentials.expires_in
 *    is missing (common with email sign-in). We patch it to default expires_in.
 * 2. _getCredentials() accesses credentials.scope before null-check, causing
 *    "Cannot read properties of null (reading 'scope')". We patch null safety.
 */
try {
  const oauth2client = auth.oauthInstance?.oauth2client;
  const localCreds = oauth2client?.localCredentials;

  // Patch 1: setCredentials – default expires_in so credentials aren't discarded
  if (localCreds && typeof localCreds.setCredentials === 'function') {
    const origSet = localCreds.setCredentials.bind(localCreds);
    localCreds.setCredentials = async function (credentials) {
      if (credentials && !credentials.expires_in && credentials.access_token) {
        console.warn('[cloudbase] setCredentials 缺失 expires_in,自动补为 7200s');
        credentials.expires_in = 7200;
      }
      return origSet(credentials);
    };
    console.log('[cloudbase] setCredentials patched for missing expires_in');
  }

  // Patch 2: _getCredentials – null-check before accessing .scope
  if (oauth2client && typeof oauth2client._getCredentials === 'function') {
    const origGet = oauth2client._getCredentials.bind(oauth2client);
    oauth2client._getCredentials = async function () {
      const credentials = await this.localCredentials.getCredentials();
      if (!credentials) {
        const msg = 'credentials not found';
        this.onCredentialsError?.({ msg });
        return Promise.reject({ error: 'UNAUTHENTICATED', error_description: msg });
      }
      return origGet();
    };
    console.log('[cloudbase] _getCredentials patched for null-safety');
  }
} catch (e) {
  console.warn('[cloudbase] SDK patch failed:', e?.message);
}

/**
 * 诊断当前 session 是否健康。
 * hasLoginState() 返回 user 只说明 localStorage 里有 user 信息，
 * 不代表 credentials(access_token) 存在。
 * 如果检测到"有 user 但无 credentials"，自动清理 session 避免用户卡在
 * "已登录但无法调 API" 的状态。
 */
export async function validateSession() {
  const user = getCurrentUser();
  if (!user) return { valid: false, reason: 'NO_USER' };

  const token = await getAccessToken();
  if (token && token.accessToken) {
    return { valid: true, user };
  }

  console.warn('[cloudbase] session 不健康: hasLoginState 有 user 但 getAccessToken 失败，自动清理...');
  try {
    await signOut();
  } catch (e) {
    // 如果 signOut 也失败，手动清 localStorage
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('tcb-') || k.includes('credential'))
        .forEach(k => localStorage.removeItem(k));
      console.log('[cloudbase] 已手动清理 localStorage 中的 tcb/credential 项');
    } catch (clearErr) {
      console.error('[cloudbase] 手动清理 localStorage 失败:', clearErr);
    }
  }
  return { valid: false, reason: 'TOKEN_MISSING' };
}

/**
 * 监听登录状态变化。回调接收 { user, type? }(参见 SDK 文档)。
 * 返回取消订阅函数。
 *
 * 注:不同版本的 @cloudbase/js-sdk 返回值不一致 — 老版本是 unsubscribe 函数,
 * 新版本可能返回 { unsubscribe } 或 { id } / { remove } 之类的 disposer 对象,
 * 也可能完全没返回值。这里统一适配成函数,避免调用方在 useEffect cleanup
 * 里直接 `cleanup?.()` 时抛 "cleanup is not a function"。
 */
export function onLoginStateChanged(callback) {
  if (!auth || typeof auth.onLoginStateChanged !== 'function') {
    console.warn('[cloudbase] auth.onLoginStateChanged 不可用');
    return () => {};
  }
  let sub;
  try {
    sub = auth.onLoginStateChanged(callback);
  } catch (err) {
    console.warn('[cloudbase] onLoginStateChanged 注册失败:', err?.message);
    return () => {};
  }
  if (typeof sub === 'function') return sub;
  if (sub && typeof sub.unsubscribe === 'function') return () => sub.unsubscribe();
  if (sub && typeof sub.remove === 'function') return () => sub.remove();
  return () => {};
}

/**
 * 拿当前登录态(同步)。SDK 启动后从 localStorage 恢复,所以可同步读。
 * 不存在则返回 null。
 */
export function getCurrentUser() {
  try {
    const state = auth.hasLoginState && auth.hasLoginState();
    if (state && state.user) return state.user;
    if (state && state.uid) return state;
  } catch {}
  return null;
}

/**
 * 拿当前 AccessToken(异步,SDK 自动续期)。返回 null 表示未登录。
 *
 * SDK 怪癖:signIn 成功后,内部 hasLoginState 立即可读,但 accessToken
 * 可能要异步落地(从远端拉 session)。这里加短重试(默认 5 次 × 200ms)
 * 来覆盖这个 race window。已就绪的情况第一次就返回,无额外延迟。
 *
 * 返回值: { accessToken, accessTokenExpire? }
 */
export async function getAccessToken({ maxAttempts = 10, intervalMs = 500 } = {}) {
  if (!auth.getAccessToken) {
    console.error('[cloudbase] auth.getAccessToken 方法不存在');
    return null;
  }

  // SDK bug fallback: try reading from internal sync storage accessor
  function tryReadTokenFromSyncStorage() {
    try {
      const oauth2client = auth.oauthInstance?.oauth2client;
      if (oauth2client && typeof oauth2client.getCredentialsSync === 'function') {
        const creds = oauth2client.getCredentialsSync();
        if (creds && creds.access_token) {
          console.log('[cloudbase] fallback: 从 getCredentialsSync 读到 token');
          return { accessToken: creds.access_token, accessTokenExpire: creds.expires_at };
        }
      }
    } catch (e) {
      console.warn('[cloudbase] getCredentialsSync fallback 失败:', e?.message);
    }
    return null;
  }

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await auth.getAccessToken();
      if (r && r.accessToken) {
        if (i > 0) console.log(`[cloudbase] getAccessToken 第 ${i + 1} 次成功`);
        return r;
      }
      // SDK returned empty but didn't crash – try sync fallback
      const fallback = tryReadTokenFromSyncStorage();
      if (fallback) return fallback;
      console.warn(`[cloudbase] getAccessToken 第 ${i + 1} 次返回空对象:`, r);
    } catch (err) {
      const msg = err && (err.message || err.msg || String(err));
      console.warn(`[cloudbase] getAccessToken 第 ${i + 1} 次异常:`, msg);

      // Detect the known SDK null-credential bug (patched above, but keep fallback)
      if (typeof msg === 'string' && msg.includes('Cannot read properties of null')) {
        console.warn('[cloudbase] 检测到 SDK scope bug,尝试内部 fallback...');
        const fallback = tryReadTokenFromSyncStorage();
        if (fallback) return fallback;
      }

      // 某些版本 SDK 在 token 过期后会抛错,这里尝试触发一次内部刷新
      if (i === 2 && auth.getLoginState) {
        try {
          console.log('[cloudbase] 尝试触发 getLoginState 刷新...');
          await auth.getLoginState();
        } catch (e) {
          console.warn('[cloudbase] getLoginState 刷新失败:', e && e.message);
        }
      }
    }
    if (i < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  // 全部失败:dump 内部状态
  try {
    const state = auth.hasLoginState && auth.hasLoginState();
    console.error('[cloudbase] getAccessToken 全部尝试失败,hasLoginState 快照:', JSON.stringify(state));
    // Also dump localStorage keys for debugging
    try {
      const keys = Object.keys(localStorage).filter(k => k.includes('credential') || k.includes('tcb'));
      console.error('[cloudbase] localStorage 相关 keys:', keys);
    } catch {}
  } catch (e) {
    console.error('[cloudbase] hasLoginState dump 失败:', e && e.message);
  }
  return null;
}

/**
 * 邮箱密码注册(需先通过邮箱验证码验证邮箱所有权)。
 *
 * 流程: 调用方先 sendEmailCode 拿到 verification_id,用户输完 6 位码后,
 * 传入 {email, password, verification_id, code},此函数内部 verify 拿到
 * verification_token,再用 signUp 一次性创建账号:邮箱已验证 + 密码已设置。
 *
 * 后续登录可以走密码 (signInWithPassword) 或验证码 (signInWithEmailCode) 任一路径。
 *
 * @param {{email, password, verification_id, code}} params
 * @returns {Promise<{user, uid, raw}>}
 */
export async function signUpWithEmail({ email, password, verification_id, code }) {
  if (!verification_id) throw new Error('请先获取邮箱验证码');
  if (!code) throw new Error('请输入验证码');
  if (!password) throw new Error('请输入密码');

  // 1. 验证验证码 → 拿到 verification_token
  const verifyResp = await verifyEmailCode({ verification_id, verification_code: code });
  const verification_token = verifyResp && verifyResp.verification_token;
  if (!verification_token) throw new Error('验证码错误或已过期');

  // 2. signUp 同时带 verification_token (证明邮箱所有权) + password (设置密码)
  if (typeof auth.signUp !== 'function') {
    throw new Error('SDK 不支持 auth.signUp,请升级 @cloudbase/js-sdk');
  }
  const raw = await auth.signUp({
    email,
    password,
    verification_token,
    verification_code: code,
  });
  return normalizeAuthResult(raw, email);
}

/**
 * 邮箱密码登录。SDK 多个版本有三种入口,按优先级降级:
 *   - v3 推荐: auth.signInWithPassword({email, password})
 *   - v1 兼容: auth.signInWithEmailAndPassword(email, password)  ← 位置参数!传对象会报 "email must be a string"
 *   - v3 通用: auth.signIn({username, password, ...})
 *
 * 返回值统一 normalize 成 {user, uid, raw} — 不再依赖 SDK 返回值结构:
 * signIn 成功后 SDK 会把 user 写到内部 hasLoginState,直接读这里更稳。
 *
 * @returns {Promise<{user, uid, raw}>}
 */
export async function signInWithPassword({ email, password }) {
  let raw;
  if (typeof auth.signInWithPassword === 'function') {
    raw = await auth.signInWithPassword({ email, password });
  } else if (typeof auth.signInWithEmailAndPassword === 'function') {
    raw = await auth.signInWithEmailAndPassword(email, password);
  } else if (typeof auth.signIn === 'function') {
    raw = await auth.signIn({ username: email, password });
  } else {
    throw new Error('SDK 不支持邮箱密码登录,请检查 @cloudbase/js-sdk 版本');
  }
  const normalized = normalizeAuthResult(raw, email);
  // 主动等 accessToken 落地:SDK 内部 hasLoginState 与 getAccessToken 是
  // 两套状态,fetchBalance 这种 Bearer 请求依赖后者。这里强 verify 一次,
  // 拿不到就报错,避免上层"看着登录成功了实际却没 session"的诡异状态。
  const token = await getAccessToken();
  if (!token || !token.accessToken) {
    throw new Error('登录成功但 SDK session 未就绪,请稍后重试或重新打开应用');
  }
  return normalized;
}

/**
 * 发送邮箱验证码。
 *
 * @param {string} email 邮箱地址
 * @param {'ANY'|'USER'|'NOT_USER'|'CUR_USER'} [target='ANY']
 *   - NOT_USER: 注册场景 — 要求邮箱未注册
 *   - USER:     登录场景 — 要求邮箱已注册
 *   - ANY:      不校验
 * @returns {Promise<{verification_id, is_user?}>}
 */
export async function sendEmailCode(email, target = 'ANY') {
  const fn = auth.getVerification || auth.sendVerificationCode;
  if (!fn) throw new Error('SDK 不支持 getVerification,请检查 @cloudbase/js-sdk 版本');
  return await fn.call(auth, { email, target });
}

/**
 * 验证邮箱验证码,返回 verification_token,后续登录用。
 * @returns {Promise<{verification_token}>}
 */
export async function verifyEmailCode({ verification_id, verification_code }) {
  const fn = auth.verify;
  if (!fn) throw new Error('SDK 不支持 verify,请检查 @cloudbase/js-sdk 版本');
  return await fn.call(auth, { verification_id, verification_code });
}

/**
 * 邮箱验证码登录(完整流程)。
 * 内部组合: getVerification → verify → signIn(verification_token)
 * 调用方只需提供 email 和已收到的 6 位 code(同时需要持有 sendEmailCode 时的 verification_id)。
 *
 * @returns {Promise<{user, uid, raw}>}
 */
export async function signInWithEmailCode({ email, code, verification_id }) {
  if (!verification_id) throw new Error('缺少 verification_id');
  const verifyResp = await verifyEmailCode({ verification_id, verification_code: code });
  const verification_token = verifyResp && verifyResp.verification_token;
  if (!verification_token) throw new Error('验证未通过');

  const signInFn = auth.signIn;
  if (!signInFn) throw new Error('SDK 不支持 signIn,请检查 @cloudbase/js-sdk 版本');
  const raw = await signInFn.call(auth, {
    username: email,
    verification_token,
    verification_code: code,
  });
  const normalized = normalizeAuthResult(raw, email);
  // 见 signInWithPassword 同名兜底:确保 accessToken 已经能拿到
  const token = await getAccessToken();
  if (!token || !token.accessToken) {
    throw new Error('登录成功但 SDK session 未就绪,请稍后重试或重新打开应用');
  }
  return normalized;
}

export async function signOut() {
  if (!auth.signOut) return;
  return await auth.signOut();
}

/**
 * Normalize SDK 各版本 signIn/signUp 返回值,统一吐出 {user, uid, raw}。
 *
 * 已观察到的返回结构(同一份 v3 SDK 在不同 API 上甚至不一致):
 *   - v3 推荐: {data: {user, session}, error}
 *   - v3 通用: {user, accessToken, ...}  (ILoginState)
 *   - v1 兼容: ILoginState (直接 {user})
 *   - 部分版本: 顶层就是 user 对象 (有 uid 字段)
 *
 * 取 user 失败时,fallback 到 auth.hasLoginState() — SDK 内部状态肯定知道
 * 当前登录的是谁,比纠结返回值的字段名靠谱。
 *
 * 拿不到 uid 才抛错,并把 raw 打到 console.error 方便定位。
 */
function normalizeAuthResult(raw, emailHint) {
  // v3 风格的 error
  if (raw && raw.error) {
    const e = raw.error;
    throw new Error(e.message || e.msg || e.error_description || '认证失败');
  }

  // 各种可能的 user 位置
  let user =
    (raw && raw.user) ||
    (raw && raw.data && raw.data.user) ||
    (raw && raw.data && raw.data.session && raw.data.session.user) ||
    null;

  // 顶层就有 uid 的情况(老版本 ILoginState 直接是 user)
  if (!user && raw && raw.uid) user = raw;

  // 兜底: 问 SDK 内部状态
  if (!user || !user.uid) {
    try {
      const state = auth.hasLoginState && auth.hasLoginState();
      if (state) {
        if (state.user && state.user.uid) user = state.user;
        else if (state.uid) user = state;
      }
    } catch (err) {
      console.warn('[cloudbase] hasLoginState 兜底取 user 失败:', err && err.message);
    }
  }

  if (!user || !user.uid) {
    console.error('[cloudbase] normalize 失败,SDK 返回:', raw);
    throw new Error('登录成功但未能从 SDK 拿到 uid,请刷新重试');
  }

  return {
    user: { uid: user.uid, email: user.email || emailHint || '' },
    uid: user.uid,
    raw,
  };
}

export default { auth, onLoginStateChanged, getCurrentUser, getAccessToken, validateSession, signUpWithEmail, signInWithPassword, sendEmailCode, verifyEmailCode, signInWithEmailCode, signOut };
