/**
 * CloudBase 数据库封装
 * 操作 users 和 userData 集合
 */

class CloudStore {
  constructor(tcbApp) {
    this.db = tcbApp.database();
    this.users = this.db.collection('users');
    this.userData = this.db.collection('userData');
    this.verifyCodes = this.db.collection('verifyCodes');
  }

  /**
   * 创建用户
   * @returns {Promise<string>} 新用户 uid
   */
  async createUser(username, passwordHash) {
    const doc = {
      username,
      passwordHash,
      createdAt: new Date(),
      lastLoginAt: new Date(),
    };
    const res = await this.users.add(doc);
    return res.id || (res.ids && res.ids[0]);
  }

  /**
   * 根据用户名查找用户
   */
  async findUserByUsername(username) {
    const { data } = await this.users.where({ username }).limit(1).get();
    return data && data.length > 0 ? data[0] : null;
  }

  /**
   * 更新最后登录时间
   */
  async updateLoginTime(uid) {
    await this.users.doc(uid).update({ lastLoginAt: new Date() });
  }

  /**
   * 获取用户云端数据
   */
  async getUserData(uid) {
    try {
      const { data } = await this.userData.doc(uid).get();
      if (!data) return null;
      // 兼容不同 SDK 版本：data 可能是对象或数组
      return Array.isArray(data) ? (data[0] || null) : data;
    } catch (err) {
      // 文档可能不存在
      if (err.message && (err.message.includes('not exist') || err.message.includes('NOT_FOUND'))) {
        return null;
      }
      throw err;
    }
  }

  /**
   * 保存用户云端数据（upsert）
   */
  async setUserData(uid, payload) {
    const data = { ...payload };
    delete data._id; // CloudBase set() 禁止包含 _id
    await this.userData.doc(uid).set(data);
  }
}

module.exports = { CloudStore };
