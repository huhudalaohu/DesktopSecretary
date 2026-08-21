/**
 * 云函数: sync-user-data
 *
 * userData 只能由已登录用户读取或覆盖自己的那一条文档。uid 永远来自
 * CloudBase AccessToken，不接受客户端传入的 uid，避免越权读写。
 */

const cloudbase = require('@cloudbase/node-sdk');

const { ok, fail, handleOptions, parseBody } = require('./lib/response');
const { requireAuth, authErrorResponse } = require('./lib/sync-auth');

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function getDocument(collection, uid) {
  try {
    const { data } = await collection.doc(uid).get();
    return Array.isArray(data) ? (data[0] || null) : (data || null);
  } catch (err) {
    const message = err && err.message ? err.message : '';
    if (message.includes('not exist') || message.includes('NOT_FOUND')) return null;
    throw err;
  }
}

exports.main = async (event, context) => {
  const corsResp = handleOptions(event);
  if (corsResp) return corsResp;

  let auth;
  try {
    auth = await requireAuth(event, context);
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    throw err;
  }

  const body = parseBody(event);
  const action = body.action;
  if (action !== 'pull' && action !== 'push') {
    return fail(400, 'action 必须是 pull 或 push');
  }

  try {
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
    const userData = app.database().collection('userData');

    if (action === 'pull') {
      return ok({ document: await getDocument(userData, auth.uid) });
    }

    const input = body.document;
    if (!isPlainObject(input) || !isPlainObject(input.payload)) {
      return fail(400, '同步数据格式无效');
    }
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_DOCUMENT_BYTES) {
      return fail(413, '同步数据超过 5MB 限制');
    }

    const document = {
      payload: input.payload,
      updatedAt: Date.now(),
      deviceId: typeof input.deviceId === 'string' ? input.deviceId.slice(0, 128) : '',
      schemaVersion: Number.isInteger(input.schemaVersion) ? input.schemaVersion : 1,
    };
    await userData.doc(auth.uid).set(document);
    return ok({ updatedAt: document.updatedAt });
  } catch (err) {
    console.error('[sync-user-data] 失败:', err.message);
    return fail(500, err.message || '同步服务失败');
  }
};
