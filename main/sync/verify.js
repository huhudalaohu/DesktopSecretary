/**
 * 验证码管理
 * 生成、存储、校验、防刷保护
 */

const { sendVerifyCode, isConfigured } = require('./mailer');

const CODE_LENGTH = 6;
const CODE_EXPIRE_MS = 5 * 60 * 1000; // 5分钟过期
const SEND_COOLDOWN_MS = 60 * 1000;   // 发送间隔 60秒
const MAX_RETRY_COUNT = 5;            // 最多允许输错 5 次

class VerifyCodeManager {
  constructor(cloudStore) {
    this.cloud = cloudStore;
    this.codes = cloudStore.db.collection('verifyCodes');
  }

  _generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * 发送验证码到指定邮箱
   */
  async sendCode(email) {
    if (!isConfigured()) {
      throw new Error('邮件服务未配置');
    }

    // 检查发送冷却
    const existing = await this._getCodeDoc(email);
    if (existing && existing.createdAt) {
      const elapsed = Date.now() - existing.createdAt;
      if (elapsed < SEND_COOLDOWN_MS && !existing.used) {
        const waitSeconds = Math.ceil((SEND_COOLDOWN_MS - elapsed) / 1000);
        throw new Error(`请 ${waitSeconds} 秒后再试`);
      }
    }

    const code = this._generateCode();

    // 写入/覆盖验证码记录
    await this.codes.doc(email).set({
      code,
      expireAt: Date.now() + CODE_EXPIRE_MS,
      retryCount: 0,
      used: false,
      createdAt: Date.now(),
    });

    // 发送邮件
    await sendVerifyCode(email, code);

    console.log('[Verify] 验证码已发送:', email);
    return { success: true, message: '验证码已发送，请查收邮件' };
  }

  /**
   * 校验验证码是否正确
   */
  async verifyCode(email, code) {
    const doc = await this._getCodeDoc(email);
    if (!doc) {
      throw new Error('验证码不存在，请先获取');
    }
    if (doc.used) {
      throw new Error('验证码已使用，请重新获取');
    }
    if (Date.now() > doc.expireAt) {
      throw new Error('验证码已过期，请重新获取');
    }
    if (doc.retryCount >= MAX_RETRY_COUNT) {
      throw new Error('错误次数过多，请重新获取验证码');
    }

    if (doc.code !== code) {
      // 增加错误次数
      await this.codes.doc(email).update({
        retryCount: (doc.retryCount || 0) + 1,
      });
      throw new Error('验证码错误');
    }

    // 标记为已使用
    await this.codes.doc(email).update({ used: true });
    return true;
  }

  async _getCodeDoc(email) {
    try {
      const { data } = await this.codes.doc(email).get();
      return Array.isArray(data) ? data[0] : data;
    } catch {
      return null;
    }
  }
}

module.exports = { VerifyCodeManager };
