/**
 * 同步引擎
 * 打包本地数据 / 解包云端数据 / Push / Pull / 自动同步
 */

const { BrowserWindow } = require('electron');
const { SYNC_KEYS, DYNC_KEY_PREFIXES, SYNC_DEBOUNCE_MS } = require('./constants');
const { ProfileManager } = require('./profile');
const { SyncAuditLog } = require('./audit-log');

class SyncEngine {
  constructor(store, cloudStore, authManager) {
    this.store = store;
    this.cloud = cloudStore;
    this.auth = authManager;
    this.profile = new ProfileManager(store);
    this.auditLog = new SyncAuditLog();
    this.pushTimer = null;
    this.isPushing = false;
    this.isPulling = false;
    this.isSwitchingProfile = false;
    this.lastSyncAt = null;
    this.dirty = false;
  }

  /**
   * 获取 store 中所有 key 列表
   */
  _getAllStoreKeys() {
    try {
      const all = this.store.store || {};
      return Object.keys(all);
    } catch {
      return [];
    }
  }

  /**
   * 判断某个 key 是否应该同步
   */
  _shouldSync(key) {
    if (SYNC_KEYS.includes(key)) return true;
    for (const prefix of DYNC_KEY_PREFIXES) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * 打包本地同步数据
   */
  _packData() {
    const data = {};

    // 固定 key
    for (const key of SYNC_KEYS) {
      try {
        const value = this.store.get(key);
        if (value !== undefined) {
          data[key] = value;
        }
      } catch (err) {
        console.warn(`[Sync] 读取 ${key} 失败:`, err.message);
      }
    }

    // 动态 key
    const allKeys = this._getAllStoreKeys();
    for (const prefix of DYNC_KEY_PREFIXES) {
      const matched = allKeys.filter((k) => k.startsWith(prefix));
      for (const key of matched) {
        try {
          const value = this.store.get(key);
          if (value !== undefined) {
            data[key] = value;
          }
        } catch (err) {
          console.warn(`[Sync] 读取 ${key} 失败:`, err.message);
        }
      }
    }

    return {
      payload: data,
      updatedAt: Date.now(),
      deviceId: this._getDeviceId(),
      schemaVersion: 1,
    };
  }

  /**
   * 获取设备标识
   */
  _getDeviceId() {
    const os = require('os');
    return `${os.hostname()}_${os.userInfo().username}`;
  }

  _lastSyncStorageKey(uid) {
    return uid ? `syncLastSyncAt:${uid}` : null;
  }

  restoreLastSync(uid) {
    const key = this._lastSyncStorageKey(uid);
    const timestamp = key ? Number(this.store.get(key, 0)) : 0;
    this.lastSyncAt = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
    return this.lastSyncAt;
  }

  _recordSync(timestamp = Date.now()) {
    this.lastSyncAt = timestamp;
    const key = this._lastSyncStorageKey(this.auth.getStatus().uid);
    if (key) this.store.set(key, timestamp);
  }

  /**
   * 将云端数据应用到本地 store
   */
  _applyData(cloudDoc) {
    if (!cloudDoc || !cloudDoc.payload) return { count: 0 };
    const { payload } = cloudDoc;
    let count = 0;

    for (const [key, value] of Object.entries(payload)) {
      if (!this._shouldSync(key)) continue;
      try {
        this.store.set(key, value);
        count++;
      } catch (err) {
        console.warn(`[Sync] 写入 ${key} 失败:`, err.message);
      }
    }

    return { count };
  }

  /**
   * 切换本地活跃 Profile（归档旧数据 + 加载新数据 + 可选合并匿名）
   */
  async switchProfile(uid, options = {}) {
    this.isSwitchingProfile = true;
    clearTimeout(this.pushTimer);

    const currentUid = this.profile.activeUid;

    // 1. 归档当前数据（匿名数据也必须归档，切换账户时才不会丢失）
    if (currentUid) {
      this.profile.archiveProfile(currentUid);
    }

    // 2. 加载目标账户数据
    this.profile.loadProfile(uid);

    // 3. 登录时合并匿名数据
    if (options.mergeAnonymous && this.profile.hasAnonymousData()) {
      const result = this.profile.mergeAnonymousIntoActive();
      console.log('[Profile] 匿名数据合并:', result);
    }

    this.profile.activeUid = uid || 'anonymous';
    this.restoreLastSync(this.profile.activeUid);
    this.isSwitchingProfile = false;

    // 4. 通知 renderer（使用独立的 IPC 通道）
    this._notifyRenderer({ type: 'profile:switched', uid }, 'profile:switched');
  }

  /**
   * 上传本地数据到云端
   */
  async push() {
    const status = this.auth.getStatus();
    if (!status.isLoggedIn) {
      return { success: false, error: '未登录' };
    }
    if (this.isPushing) {
      return { success: false, error: '正在同步中' };
    }

    // ⭐ 关键校验：session 与本地活跃 profile 必须一致
    if (status.uid !== this.profile.activeUid) {
      console.error(`[Sync] Profile 不一致: session=${status.uid}, active=${this.profile.activeUid}`);
      return { success: false, error: 'Session 与本地 Profile 不一致，拒绝推送' };
    }

    this.isPushing = true;
    this._notifyRenderer({ isSyncing: true, direction: 'push' });
    try {
      const packed = this._packData();
      packed._meta = { ownerUid: status.uid, ownerEmail: status.username };
      await this.cloud.setUserData(status.uid, packed);
      this._recordSync();
      this.dirty = false;
      console.log('[Sync] Push 成功');
      const result = { success: true, direction: 'push', timestamp: this.lastSyncAt };
      this.auditLog.write({ operation: 'push', success: true, timestamp: this.lastSyncAt });
      this._notifyRenderer({ ...result, isSyncing: false });
      return result;
    } catch (err) {
      console.error('[Sync] Push 失败:', err.message);
      const result = { success: false, error: err.message };
      this.auditLog.write({ operation: 'push', success: false, error: err.message });
      this._notifyRenderer({ ...result, isSyncing: false });
      return result;
    } finally {
      this.isPushing = false;
    }
  }

  /**
   * 从云端下载数据到本地
   */
  async pull() {
    const status = this.auth.getStatus();
    if (!status.isLoggedIn) {
      return { success: false, error: '未登录' };
    }
    if (this.isPulling) {
      return { success: false, error: '正在同步中' };
    }

    this.isPulling = true;
    this._notifyRenderer({ isSyncing: true, direction: 'pull' });
    try {
      const doc = await this.cloud.getUserData(status.uid);
      if (!doc) {
        console.log('[Sync] 云端无数据，跳过 Pull');
        this._recordSync();
        const result = { success: true, direction: 'none', message: '云端无数据' };
        this.auditLog.write({ operation: 'pull', success: true, direction: 'none' });
        this._notifyRenderer({ ...result, isSyncing: false });
        return result;
      }

      const result = this._applyData(doc);
      this._recordSync();
      this.dirty = false;
      console.log('[Sync] Pull 成功，写入', result.count, '个 key');
      const ret = { success: true, direction: 'pull', timestamp: this.lastSyncAt, count: result.count };
      this.auditLog.write({ operation: 'pull', success: true, count: result.count, timestamp: this.lastSyncAt });
      this._notifyRenderer({ ...ret, isSyncing: false });
      return ret;
    } catch (err) {
      console.error('[Sync] Pull 失败:', err.message);
      const result = { success: false, error: err.message };
      this.auditLog.write({ operation: 'pull', success: false, error: err.message });
      this._notifyRenderer({ ...result, isSyncing: false });
      return result;
    } finally {
      this.isPulling = false;
    }
  }

  /**
   * 双向同步：根据时间戳决定 push 还是 pull
   */
  async sync() {
    const status = this.auth.getStatus();
    if (!status.isLoggedIn) {
      return { success: false, error: '未登录' };
    }

    const doc = await this.cloud.getUserData(status.uid);
    if (!doc || this.dirty) {
      return await this.push();
    } else {
      // 未检测到本地改动时以云端为准，避免每次手动同步都用当前时间覆盖云端。
      return await this.pull();
    }
  }

  /**
   * 调度自动 Push（防抖）
   */
  schedulePush() {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
    }
    this.dirty = true;
    this.pushTimer = setTimeout(() => {
      this.push().catch((err) => {
        console.error('[Sync] 自动 Push 失败:', err.message);
      });
    }, SYNC_DEBOUNCE_MS);
  }

  /**
   * 当某个 store key 发生变化时调用
   */
  onStoreChanged(key) {
    if (this.isSwitchingProfile) return;
    if (this._shouldSync(key)) {
      this.schedulePush();
    }
  }

  _notifyRenderer(payload, channel = 'sync:status-changed') {
    try {
      const wins = BrowserWindow.getAllWindows();
      for (const win of wins) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    } catch {
      // 忽略通知失败
    }
  }

  getStatus() {
    return {
      isSyncing: this.isPushing || this.isPulling,
      lastSyncAt: this.lastSyncAt,
      dirty: this.dirty,
    };
  }
}

module.exports = { SyncEngine };
