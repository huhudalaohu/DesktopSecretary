/**
 * 用户认证管理
 * 注册 / 登录 / 登出 / 会话保持
 */

const bcrypt = require('bcryptjs');
const { CloudStore } = require('./cloud');
const { VerifyCodeManager } = require('./verify');

const SALT_ROUNDS = 10;

class AuthManager {
  constructor(cloudStore, store, verifyManager) {
    this.cloud = cloudStore;
    this.store = store;
    this.verify = verifyManager;
    this.session = null;
    this._loadSession();
  }

  _loadSession() {
    try {
      const saved = this.store.get('syncSession', null);
      if (saved && saved.uid && saved.username) {
        this.session = saved;
        console.log('[Sync] 已恢复登录会话:', saved.username);
      }
    } catch {
      this.session = null;
    }
  }

  _saveSession() {
    if (this.session) {
      this.store.set('syncSession', this.session);
    } else {
      try { this.store.delete('syncSession'); } catch {}
    }
  }

  getStatus() {
    if (!this.session) return { isLoggedIn: false };
    return {
      isLoggedIn: true,
      uid: this.session.uid,
      username: this.session.username,
      loginAt: this.session.loginAt,
    };
  }

  _validateEmail(email) {
    if (!email || typeof email !== 'string') {
      throw new Error('邮箱不能为空');
    }
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      throw new Error('邮箱格式不正确');
    }
    return trimmed;
  }

  _validatePassword(password) {
    if (!password || typeof password !== 'string') {
      throw new Error('密码不能为空');
    }
    if (password.length < 6) {
      throw new Error('密码长度至少 6 位');
    }
    return password;
  }

  async register(username, password, code) {
    const validEmail = this._validateEmail(username);
    const validPass = this._validatePassword(password);

    if (!code || typeof code !== 'string') {
      throw new Error('请输入验证码');
    }

    // 校验验证码
    if (this.verify) {
      await this.verify.verifyCode(validEmail, code);
    }

    const existing = await this.cloud.findUserByUsername(validEmail);
    if (existing) {
      throw new Error('该邮箱已被注册');
    }

    const passwordHash = await bcrypt.hash(validPass, SALT_ROUNDS);
    const uid = await this.cloud.createUser(validEmail, passwordHash);

    this.session = { uid, username: validEmail, loginAt: Date.now() };
    this._saveSession();

    console.log('[Sync] 注册成功:', validEmail, uid);
    return { success: true, uid, username: validEmail };
  }

  async login(username, password) {
    const validEmail = this._validateEmail(username);
    const validPass = this._validatePassword(password);

    const user = await this.cloud.findUserByUsername(validEmail);
    if (!user) {
      throw new Error('邮箱或密码错误');
    }

    const valid = await bcrypt.compare(validPass, user.passwordHash);
    if (!valid) {
      throw new Error('邮箱或密码错误');
    }

    await this.cloud.updateLoginTime(user._id);

    this.session = { uid: user._id, username: user.username, loginAt: Date.now() };
    this._saveSession();

    console.log('[Sync] 登录成功:', user.username);
    return { success: true, uid: user._id, username: user.username };
  }

  async logout() {
    this.session = null;
    this._saveSession();
    console.log('[Sync] 已登出');
    return { success: true };
  }
}

module.exports = { AuthManager };
