/**
 * StateManager — 统一状态管理
 *
 * 职责:
 *   1. 包装 electron-store，提供带缓存的 get/set
 *   2. 支持批量读写，减少 IPC round-trip
 *   3. 提供状态变更订阅，渲染进程可监听任意 key 的变化
 *   4. 自动处理 aiSettings 的 safeStorage 加密/解密
 */

const { safeStorage } = require('electron');

class StateManager {
  constructor(store) {
    this.store = store;
    this.cache = new Map();
    this.subscribers = [];
  }

  /** 读取（带内存缓存） */
  get(key, defaultValue) {
    if (this.cache.has(key)) return this.cache.get(key);
    let value = this.store.get(key, defaultValue);
    if (key === 'aiSettings') value = this._decryptAiSettings(value);
    this.cache.set(key, value);
    return value;
  }

  /** 写入（同步缓存 + 磁盘 + 通知） */
  set(key, value) {
    if (key === 'aiSettings') value = this._encryptAiSettings(value);
    this.cache.set(key, value);
    this.store.set(key, value);
    this._notify({ type: 'set', key, value });
  }

  /** 批量读取 */
  getBatch(keysWithDefaults) {
    const result = {};
    for (const item of keysWithDefaults) {
      const key = typeof item === 'string' ? item : item.key;
      const defaultValue = typeof item === 'string' ? undefined : item.default;
      result[key] = this.get(key, defaultValue);
    }
    return result;
  }

  /** 批量写入 */
  setBatch(entries) {
    for (const [key, value] of entries) {
      let v = value;
      if (key === 'aiSettings') v = this._encryptAiSettings(v);
      this.cache.set(key, v);
      this.store.set(key, v);
    }
    this._notify({ type: 'setBatch', entries });
  }

  /** 删除 key */
  delete(key) {
    this.cache.delete(key);
    try { this.store.delete(key); } catch {}
    this._notify({ type: 'delete', key });
  }

  /** 订阅状态变更 */
  subscribe(callback) {
    this.subscribers.push(callback);
    return () => {
      const idx = this.subscribers.indexOf(callback);
      if (idx !== -1) this.subscribers.splice(idx, 1);
    };
  }

  /** 手动触发通知（外部 Manager 修改状态后调用） */
  notifyExternal(key, value) {
    this.cache.set(key, value);
    this._notify({ type: 'set', key, value });
  }

  _notify(payload) {
    for (const cb of this.subscribers) {
      try { cb(payload); } catch {}
    }
  }

  // ===== safeStorage 加密 =====

  _encryptAiSettings(settings) {
    if (!settings || typeof settings !== 'object') return settings;
    if (!settings.apiKey) return settings;
    try {
      if (!safeStorage.isEncryptionAvailable()) return settings;
      const encrypted = safeStorage.encryptString(settings.apiKey);
      return { ...settings, apiKey: '', apiKeyEncrypted: encrypted.toString('base64') };
    } catch (err) {
      console.error('[safeStorage] 加密失败:', err.message);
      return settings;
    }
  }

  _decryptAiSettings(settings) {
    if (!settings || typeof settings !== 'object') return settings;
    if (settings.apiKeyEncrypted) {
      try {
        if (!safeStorage.isEncryptionAvailable()) return settings;
        const encrypted = Buffer.from(settings.apiKeyEncrypted, 'base64');
        const decrypted = safeStorage.decryptString(encrypted);
        const result = { ...settings, apiKey: decrypted };
        delete result.apiKeyEncrypted;
        return result;
      } catch (err) {
        console.error('[safeStorage] 解密失败:', err.message);
        return settings;
      }
    }
    return settings;
  }
}

module.exports = { StateManager };
