/**
 * CloudBase 数据库封装(v2)
 *
 * v2 之后用户身份由 CloudBase 身份认证管理,本模块不再操作 users 集合,
 * 只负责 userData 的读写(同步引擎使用)。
 */

class CloudStore {
  constructor(tcbApp) {
    this.db = tcbApp.database();
    this.userData = this.db.collection('userData');
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
