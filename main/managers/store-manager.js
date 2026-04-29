/**
 * StoreManager — electron-store 包装 + safeStorage 加密
 *
 * 封装 electron-store 实例，添加：
 *   - API Key 自动加密/解密
 *   - 批量操作
 *   - 对 IPC 模块的兼容层
 */

const { safeStorage } = require('electron');

class StoreManager {
  constructor(electronStore) {
    this._store = electronStore;
    this._migrateLegacyAiSettings();
  }

  _migrateLegacyAiSettings() {
    const raw = this._store.get('aiSettings', {});
    if (!raw.apiKey || raw.apiKeyEncrypted) return;
    if (!safeStorage.isEncryptionAvailable()) return;
    try {
      const encrypted = safeStorage.encryptString(raw.apiKey);
      this._store.set('aiSettings', {
        ...raw,
        apiKey: '',
        apiKeyEncrypted: encrypted.toString('base64'),
      });
      console.log('[Store] 已迁移旧版明文 API Key');
    } catch (err) {
      console.error('[Store] 迁移加密失败:', err.message);
    }
  }

  get(key, defaultValue = undefined) {
    return this._store.get(key, defaultValue);
  }

  set(key, value) {
    this._store.set(key, value);
  }

  delete(key) {
    this._store.delete(key);
  }

  getAll() {
    return this._store.store;
  }

  getAiSettings() {
    const raw = this.get('aiSettings', {});
    if (raw.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(raw.apiKeyEncrypted, 'base64'));
        return { ...raw, apiKey: decrypted };
      } catch (err) {
        console.error('[Store] 解密失败:', err.message);
        return raw;
      }
    }
    return raw;
  }

  setAiSettings(settings) {
    let s = settings;
    if (settings.apiKey && safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = safeStorage.encryptString(settings.apiKey);
        s = { ...settings, apiKey: '', apiKeyEncrypted: encrypted.toString('base64') };
      } catch (err) {
        console.error('[Store] 加密失败:', err.message);
      }
    }
    this.set('aiSettings', s);
  }

  // 兼容 IPC 数据模块需要的接口
  decryptAiSettings(settings) {
    if (!settings || typeof settings !== 'object') return settings;
    if (settings.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = Buffer.from(settings.apiKeyEncrypted, 'base64');
        const decrypted = safeStorage.decryptString(encrypted);
        const result = { ...settings, apiKey: decrypted };
        delete result.apiKeyEncrypted;
        return result;
      } catch (err) {
        console.error('[Store] 解密失败:', err.message);
        return settings;
      }
    }
    return settings;
  }

  safeStoreSet(key, value) {
    if (key === 'aiSettings') {
      this.setAiSettings(value);
    } else {
      this.set(key, value);
    }
  }
}

module.exports = { StoreManager };
