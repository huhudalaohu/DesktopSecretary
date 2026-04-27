/**
 * 用户 Profile 本地数据隔离管理器
 *
 * 核心机制：
 * - 单 Store 文件，内部使用命名空间隔离
 * - 顶层 key（如 workspaces）：当前活跃身份的数据，业务代码无感知
 * - profiles:{uid}:{key}：账户 uid 的归档数据
 * - profiles:anonymous:{key}：匿名数据（未登录时产生）
 */

const { SYNC_KEYS, DYNC_KEY_PREFIXES } = require('./constants');

class ProfileManager {
  constructor(store) {
    this.store = store;
    this.activeUid = null;
  }

  // ========== 底层归档/加载 ==========

  /**
   * 将当前顶层数据归档到指定 uid
   */
  archiveProfile(uid) {
    if (!uid || uid === 'anonymous') return;

    for (const key of SYNC_KEYS) {
      try {
        const value = this.store.get(key);
        if (value !== undefined) {
          this.store.set(`profiles:${uid}:${key}`, value);
        }
      } catch (err) {
        console.warn(`[Profile] 归档 ${key} 失败:`, err.message);
      }
    }

    // 动态前缀也要归档
    const allKeys = this._getAllStoreKeys();
    for (const prefix of DYNC_KEY_PREFIXES) {
      for (const key of allKeys.filter((k) => k.startsWith(prefix))) {
        try {
          const value = this.store.get(key);
          if (value !== undefined) {
            this.store.set(`profiles:${uid}:${key}`, value);
          }
        } catch (err) {
          console.warn(`[Profile] 归档 ${key} 失败:`, err.message);
        }
      }
    }
  }

  /**
   * 将指定 uid 的归档数据加载到顶层
   */
  loadProfile(uid) {
    this.clearActiveKeys();
    if (!uid || uid === 'anonymous') return;

    for (const key of SYNC_KEYS) {
      try {
        const val = this.store.get(`profiles:${uid}:${key}`);
        if (val !== undefined) this.store.set(key, val);
      } catch (err) {
        console.warn(`[Profile] 加载 ${key} 失败:`, err.message);
      }
    }

    const allKeys = this._getAllStoreKeys();
    for (const prefix of DYNC_KEY_PREFIXES) {
      for (const key of allKeys.filter((k) => k.startsWith(`profiles:${uid}:${prefix}`))) {
        try {
          const shortKey = key.replace(`profiles:${uid}:`, '');
          this.store.set(shortKey, this.store.get(key));
        } catch (err) {
          console.warn(`[Profile] 加载 ${key} 失败:`, err.message);
        }
      }
    }
  }

  /**
   * 清空顶层同步数据（保留 LOCAL_ONLY_KEYS）
   */
  clearActiveKeys() {
    for (const key of SYNC_KEYS) {
      try {
        this.store.delete(key);
      } catch {}
    }

    const allKeys = this._getAllStoreKeys();
    for (const prefix of DYNC_KEY_PREFIXES) {
      for (const key of allKeys.filter((k) => k.startsWith(prefix))) {
        try {
          this.store.delete(key);
        } catch {}
      }
    }
  }

  // ========== ⭐ 匿名数据增量合并 ==========

  /**
   * 将 profiles:anonymous: 中的数据增量合并到当前顶层
   * 合并完成后清空匿名空间
   */
  mergeAnonymousIntoActive() {
    const anonKeys = this._getAllStoreKeys().filter((k) => k.startsWith('profiles:anonymous:'));
    if (anonKeys.length === 0) return { merged: false };

    for (const fullKey of anonKeys) {
      const key = fullKey.replace('profiles:anonymous:', '');
      if (!this._shouldSync(key)) continue;

      try {
        const anonValue = this.store.get(fullKey);
        const currentValue = this.store.get(key);
        const merged = this._mergeValue(currentValue, anonValue, key);
        this.store.set(key, merged);
      } catch (err) {
        console.warn(`[Profile] 合并匿名 ${key} 失败:`, err.message);
      }
    }

    this.clearAnonymousProfile();
    return { merged: true, keys: anonKeys.length };
  }

  clearAnonymousProfile() {
    const keys = this._getAllStoreKeys().filter((k) => k.startsWith('profiles:anonymous:'));
    for (const key of keys) {
      try {
        this.store.delete(key);
      } catch {}
    }
  }

  /**
   * 将当前顶层数据绑定到指定 uid（用于注册时）
   */
  bindCurrentDataToProfile(uid) {
    this.archiveProfile(uid);
  }

  hasAnonymousData() {
    return this._getAllStoreKeys().some((k) => k.startsWith('profiles:anonymous:'));
  }

  hasProfile(uid) {
    if (!uid) return false;
    return this._getAllStoreKeys().some((k) => k.startsWith(`profiles:${uid}:`));
  }

  // ========== 工具方法 ==========

  _getAllStoreKeys() {
    try {
      return Object.keys(this.store.store || {});
    } catch {
      return [];
    }
  }

  _shouldSync(key) {
    if (SYNC_KEYS.includes(key)) return true;
    for (const prefix of DYNC_KEY_PREFIXES) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  // ========== 合并策略分发 ==========

  _mergeValue(current, incoming, key) {
    if (current === undefined) return incoming;
    if (incoming === undefined) return current;

    // 数组型：按 id 去重（pinnedFolders / recentFolders 按 path 去重）
    if (Array.isArray(current) && Array.isArray(incoming)) {
      if (key === 'pinnedFolders' || key === 'recentFolders') {
        return [...new Set([...current, ...incoming])];
      }
      return this._mergeById(current, incoming);
    }

    // tokenStats：数值累加
    if (key === 'tokenStats') {
      return this._mergeTokenStats(current, incoming);
    }

    // 对象型：浅合并，当前值优先
    if (
      typeof current === 'object' &&
      typeof incoming === 'object' &&
      current !== null &&
      incoming !== null
    ) {
      return { ...incoming, ...current };
    }

    return current;
  }

  _mergeById(targetArr, sourceArr) {
    const ids = new Set(targetArr.map((item) => item?.id).filter(Boolean));
    const additions = sourceArr.filter((item) => item?.id && !ids.has(item.id));
    return [...targetArr, ...additions];
  }

  _mergeTokenStats(current, incoming) {
    return {
      totalTokens: (current?.totalTokens || 0) + (incoming?.totalTokens || 0),
      dailyStats: { ...(incoming?.dailyStats || {}), ...(current?.dailyStats || {}) },
    };
  }
}

module.exports = { ProfileManager };
