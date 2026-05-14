/**
 * 统一的 HTTP 响应包装,包含 CORS 头。
 * CloudBase HTTP 触发器要求 statusCode + headers + body 这种格式。
 */

const CORS_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

function ok(body) {
  return jsonResponse(200, { success: true, ...body });
}

function fail(statusCode, error, extra = {}) {
  return jsonResponse(statusCode, { success: false, error, ...extra });
}

function handleOptions(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  return null;
}

/**
 * 解析 event.body 为 JSON 对象,兼容已经是对象的情况(直接调用云函数 vs HTTP)
 */
function parseBody(event) {
  if (!event.body) return {};
  if (typeof event.body === 'object') return event.body;
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

module.exports = { jsonResponse, ok, fail, handleOptions, parseBody, CORS_HEADERS };
