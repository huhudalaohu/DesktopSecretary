/* Node.js 8 compatible JWT verifier for the HTTP service. */
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const jwkToPem = require('jwk-to-pem');
const { fail } = require('./response');

const cache = {};
const CACHE_TTL = 60 * 60 * 1000;
const ENV_ID = 'ds-dev-d9g28xlrgd2600837';
const EXPECTED_ISSUER = `https://${ENV_ID}.ap-shanghai.tcb-api.tencentcloudapi.com`;

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.code = 'UNAUTHORIZED';
  }
}

function decode(value) {
  value = value.replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  return Buffer.from(value, 'base64');
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: 3000,
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`JWKS HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('JWKS timeout')));
    request.end();
  });
}

async function getKeys(issuer) {
  const existing = cache[issuer];
  if (existing && Date.now() - existing.at < CACHE_TTL) return existing.keys;

  let discovery;
  try {
    discovery = await requestJson(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  } catch (err) {
    throw new AuthError('登录凭证验证服务暂不可用');
  }
  if (!discovery.jwks_uri) throw new AuthError('登录凭证验证服务配置无效');

  let jwks;
  try {
    jwks = await requestJson(discovery.jwks_uri);
  } catch (err) {
    throw new AuthError('登录凭证验证服务暂不可用');
  }
  const keys = {};
  (jwks.keys || []).forEach((jwk) => {
    if (!jwk || !jwk.kid) return;
    try {
      keys[jwk.kid] = jwkToPem(jwk);
    } catch (err) {
      throw new AuthError(`登录凭证公钥转换失败: ${err.message}`);
    }
  });
  cache[issuer] = { at: Date.now(), keys };
  return keys;
}

async function requireAuth(event) {
  const headers = (event && event.headers) || {};
  const value = headers.Authorization || headers.authorization || '';
  if (typeof value !== 'string' || !/^Bearer\s+/i.test(value)) {
    throw new AuthError('缺少登录凭证');
  }

  const token = value.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('登录凭证格式错误');

  let header;
  let payload;
  try {
    header = JSON.parse(decode(parts[0]).toString('utf8'));
    payload = JSON.parse(decode(parts[1]).toString('utf8'));
  } catch (err) {
    throw new AuthError('登录凭证格式错误');
  }
  if (header.alg !== 'RS256' || !header.kid || !payload.iss || !payload.sub) {
    throw new AuthError('登录凭证无效');
  }
  if (payload.iss !== EXPECTED_ISSUER || payload.aud !== ENV_ID || payload.project_id !== ENV_ID) {
    throw new AuthError('登录凭证签发方无效');
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new AuthError('登录状态已过期，请重新登录');
  }

  const keys = await getKeys(payload.iss);
  const pem = keys[header.kid];
  if (!pem) throw new AuthError('登录凭证签名密钥无效');
  let verified;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`, 'utf8');
    verifier.end();
    verified = verifier.verify(pem, decode(parts[2]));
  } catch (err) {
    throw new AuthError(`登录凭证验签失败: ${err.message}`);
  }
  if (!verified) throw new AuthError('登录凭证签名无效');
  return { uid: payload.sub };
}

function authErrorResponse(err) {
  return err && err.code === 'UNAUTHORIZED' ? fail(401, err.message, { code: err.code }) : null;
}

module.exports = { requireAuth, authErrorResponse };
