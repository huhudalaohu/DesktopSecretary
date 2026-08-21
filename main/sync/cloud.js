/**
 * CloudBase 数据库封装(v2)
 *
 * 通过受 JWT 鉴权的 sync-user-data 云函数读写 userData。
 *
 * 不在桌面安装包中携带 CloudBase SecretId/SecretKey：它们具有管理员权限，
 * 一旦打包便等于公开。访问令牌仅存在 AuthManager 内存，云函数从令牌派生 uid。
 */

const https = require('https');

const DEFAULT_SYNC_DATA_URL = 'https://ds-dev-d9g28xlrgd2600837.service.tcloudbase.com/sync-user-data';

class CloudStore {
  constructor(authManager, options = {}) {
    this.auth = authManager;
    this.endpoint = options.endpoint || process.env.SYNC_DATA_URL || DEFAULT_SYNC_DATA_URL;
  }

  _request(body) {
    const token = this.auth.getAccessToken();
    if (!token) {
      return Promise.reject(new Error('登录凭证尚未准备好，请稍后重试'));
    }

    const url = new URL(this.endpoint);
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = https.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        timeout: 15000,
      }, (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', () => {
          let data = null;
          try { data = responseBody ? JSON.parse(responseBody) : null; } catch {}
          if (response.statusCode === 401) {
            reject(new Error((data && data.error) || '登录状态已过期，请重新登录'));
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300 || !data || data.success === false) {
            reject(new Error((data && data.error) || `同步服务请求失败 (HTTP ${response.statusCode})`));
            return;
          }
          resolve(data);
        });
      });
      request.on('error', (err) => reject(new Error(`同步服务网络错误: ${err.message}`)));
      request.on('timeout', () => request.destroy(new Error('同步服务请求超时')));
      request.write(payload);
      request.end();
    });
  }

  /**
   * 获取用户云端数据
   */
  async getUserData(uid) {
    const result = await this._request({ action: 'pull' });
    return result.document || null;
  }

  /**
   * 保存用户云端数据（upsert）
   */
  async setUserData(uid, payload) {
    await this._request({ action: 'push', document: payload });
  }
}

module.exports = { CloudStore };
