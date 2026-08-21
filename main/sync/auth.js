/**
 * 用户会话管理(v2)
 *
 * 注册/登录/验证码现在由渲染进程通过 @cloudbase/js-sdk 直接对接 CloudBase
 * 身份认证服务完成,主进程不再做密码哈希、验证码核对等。
 *
 * 本模块只负责把 uid 维系到 electron-store(用于同步引擎切换 profile),
 * 以及提供 getStatus 给 UI 查询。
 *
 * 渲染进程登录成功后通过 IPC `auth:setUid` 通知主进程,登出后通过
 * `auth:clearUid` 通知。
 */

const SESSION_KEY = 'syncSession';

class AuthManager {
  constructor(store) {
    this.store = store;
    this.session = null;
    this.accessToken = null;
    this._loadSession();
  }

  _loadSession() {
    try {
      const saved = this.store.get(SESSION_KEY, null);
      if (saved && saved.uid) {
        this.session = saved;
        console.log('[Sync] 已恢复登录会话:', saved.username || saved.uid);
      }
    } catch {
      this.session = null;
    }
  }

  _saveSession() {
    if (this.session) {
      this.store.set(SESSION_KEY, this.session);
    } else {
      try { this.store.delete(SESSION_KEY); } catch {}
    }
  }

  /**
   * 渲染进程登录后调用,把 uid 持久化。
   */
  setSession({ uid, username, accessToken }) {
    if (!uid) throw new Error('uid 不能为空');
    this.session = {
      uid,
      username: username || '',
      loginAt: Date.now(),
    };
    // AccessToken 只留在内存中。它由渲染进程的 CloudBase SDK 自动续期，
    // 不应该写入 electron-store 或随用户数据同步。
    if (accessToken) this.accessToken = accessToken;
    this._saveSession();
    console.log('[Sync] 已绑定用户:', this.session.username || uid);
    return { success: true, uid, username: this.session.username };
  }

  clearSession() {
    this.session = null;
    this.accessToken = null;
    this._saveSession();
    console.log('[Sync] 已清除会话');
    return { success: true };
  }

  getStatus() {
    if (!this.session) return { isLoggedIn: false };
    return {
      isLoggedIn: true,
      uid: this.session.uid,
      username: this.session.username || '',
      loginAt: this.session.loginAt,
    };
  }

  hasAccessToken() {
    return Boolean(this.accessToken);
  }

  getAccessToken() {
    return this.accessToken;
  }
}

module.exports = { AuthManager };
