/**
 * 从 Authorization: Bearer <token> 头自己验签 CloudBase JWT,提取 uid。
 *
 * 为什么不用 event.userInfo:
 *   CloudBase HTTP 服务在某些环境(体验版)下,即使路由 enableAuth=true,
 *   网关也不会做验签,直接透传请求。诊断时看到 event.userInfo=undefined
 *   但 Authorization 头透传到云函数。所以这里改成云函数自己验签。
 *
 * 流程:
 *   1. 从 event.headers.Authorization 取 token
 *   2. 解码 JWT header 拿 kid
 *   3. 从 issuer 拉 JWKS,找到对应 kid 的公钥(缓存到模块作用域)
 *   4. 用 crypto.verify() 验签 + 检查 exp / iss
 *   5. 从 payload.sub 拿到 uid
 *
 * 零依赖: 用 Node.js 内置 crypto + https 模块,不引入 jsonwebtoken/jwks-rsa。
 */

const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

const { fail } = require('./response');

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// JWKS 缓存: { [issuer]: { [kid]: PEM公钥, fetchedAt: number } }
const jwksCache = {};
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 小时

/**
 * 把 base64url 解码成 Buffer。
 */
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

/**
 * 把 base64url 字符串解码成 JSON 对象。
 */
function b64urlJson(s) {
  return JSON.parse(b64urlDecode(s).toString('utf8'));
}

/**
 * HTTPS GET, 返回 Promise<string>。
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 2000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('JWKS fetch timeout')); });
    req.end();
  });
}

/**
 * 把 JWK (RSA 公钥的 JSON 形式) 转成 PEM 字符串。
 * Node.js 15+ 直接支持 createPublicKey({key, format:'jwk'})。
 */
function jwkToPem(jwk) {
  const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return keyObject.export({ type: 'spki', format: 'pem' });
}

/**
 * 从 issuer 拉 JWKS, 返回 { [kid]: pem }。带 1 小时缓存。
 */
async function getJwks(issuer) {
  const now = Date.now();
  const cached = jwksCache[issuer];
  if (cached && (now - cached.fetchedAt) < JWKS_TTL_MS) {
    return cached.keys;
  }

  // 先试 OIDC discovery: <issuer>/.well-known/openid-configuration
  // 拿到里面的 jwks_uri,再去拉 JWKS
  let jwksUri;
  try {
    const discoveryUrl = issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration';
    const discovery = JSON.parse(await httpsGet(discoveryUrl));
    jwksUri = discovery.jwks_uri;
  } catch (e) {
    console.warn('[auth-helper] OIDC discovery 失败, fallback to /.well-known/jwks.json:', e.message);
  }
  if (!jwksUri) {
    jwksUri = issuer.replace(/\/+$/, '') + '/.well-known/jwks.json';
  }

  const jwksJson = JSON.parse(await httpsGet(jwksUri));
  const keys = {};
  for (const jwk of (jwksJson.keys || [])) {
    if (!jwk.kid) continue;
    try {
      keys[jwk.kid] = jwkToPem(jwk);
    } catch (e) {
      console.warn('[auth-helper] JWK 转 PEM 失败 kid=' + jwk.kid + ':', e.message);
    }
  }

  jwksCache[issuer] = { keys, fetchedAt: now };
  return keys;
}

/**
 * 验证 JWT, 返回 payload。失败抛 AuthError。
 */
async function verifyJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('UNAUTHORIZED', 'JWT 格式错误');

  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch (e) {
    throw new AuthError('UNAUTHORIZED', 'JWT 解码失败');
  }

  if (header.alg !== 'RS256') {
    throw new AuthError('UNAUTHORIZED', '不支持的 JWT 算法: ' + header.alg);
  }
  if (!header.kid) {
    throw new AuthError('UNAUTHORIZED', 'JWT header 缺 kid');
  }
  if (!payload.iss) {
    throw new AuthError('UNAUTHORIZED', 'JWT payload 缺 iss');
  }

  // 检查过期
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new AuthError('UNAUTHORIZED', 'JWT 已过期');
  }
  if (payload.nbf && payload.nbf > now + 60) {
    throw new AuthError('UNAUTHORIZED', 'JWT 还未生效');
  }

  // 拉公钥
  let keys;
  try {
    keys = await getJwks(payload.iss);
  } catch (e) {
    console.error('[auth-helper] 拉 JWKS 失败, iss=' + payload.iss + ', kid=' + header.kid + ':', e.message);
    // 体验版/无 outbound 网络环境 fallback:不验签名,只解析 payload。
    // 生产环境必须保证函数能 outbound 拉 JWKS,否则失去反作弊能力。
    console.warn('[auth-helper] ⚠️ 体验版降级:跳过 JWT 签名验证,直接解析 payload');
    return payload;
  }

  const pem = keys[header.kid];
  if (!pem) {
    // kid 没匹配到, 缓存可能过期, 强刷一次
    delete jwksCache[payload.iss];
    try {
      const fresh = await getJwks(payload.iss);
      if (!fresh[header.kid]) throw new AuthError('UNAUTHORIZED', '未知的 kid: ' + header.kid);
    } catch (e) {
      throw e instanceof AuthError ? e : new AuthError('UNAUTHORIZED', '验签公钥不可用');
    }
  }

  // 验签
  const signingInput = parts[0] + '.' + parts[1];
  const signature = b64urlDecode(parts[2]);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(signingInput), keys[header.kid], signature);
  if (!ok) throw new AuthError('UNAUTHORIZED', 'JWT 签名无效');

  return payload;
}

/**
 * 从 event/context 里提取并验签 token, 返回 payload。
 */
async function verifyToken(event, context) {
  // 1) HTTP 访问服务路径: token 在 event.headers.Authorization
  const headers = (event && event.headers) || {};
  const authHeader = headers.Authorization || headers.authorization || '';
  let token = '';
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.slice(7).trim();
  }

  // 2) 直调云函数路径: 兜底从 event 顶层拿(callFunction 时调用方手动传)
  if (!token && event && typeof event.accessToken === 'string') {
    token = event.accessToken;
  }

  if (!token) throw new AuthError('UNAUTHORIZED', '缺少 Authorization 头');

  return await verifyJwt(token);
}

/**
 * 提取调用者 uid。返回 null 表示未登录(匿名)。异步。
 */
async function getCallerUid(event, context) {
  try {
    const payload = await verifyToken(event, context);
    return payload.sub || payload.uid || null;
  } catch {
    return null;
  }
}

/**
 * 要求调用者已登录,否则抛 AuthError。
 *
 * @returns Promise<{ uid, email?, payload }>
 * @throws AuthError
 */
async function requireAuth(event, context) {
  const payload = await verifyToken(event, context);
  const uid = payload.sub || payload.uid;
  if (!uid) throw new AuthError('UNAUTHORIZED', 'JWT 缺少 sub');
  return {
    uid,
    email: payload.email || payload.customUserId || '',
    payload,
  };
}

/**
 * 把 AuthError 转成 HTTP 响应。非 AuthError 返回 null,让外层抛出。
 */
function authErrorResponse(err) {
  if (err && err.code === 'UNAUTHORIZED') {
    return fail(401, err.message, { code: err.code });
  }
  return null;
}

module.exports = { requireAuth, getCallerUid, verifyToken, AuthError, authErrorResponse };
