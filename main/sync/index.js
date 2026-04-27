/**
 * 同步模块统一入口
 */

const { AuthManager } = require('./auth');
const { CloudStore } = require('./cloud');
const { SyncEngine } = require('./engine');
const { VerifyCodeManager } = require('./verify');

let authManager = null;
let syncEngine = null;
let initialized = false;

function initSync(store, tcbApp) {
  if (initialized) {
    console.warn('[Sync] 已初始化，跳过');
    return { auth: authManager, engine: syncEngine };
  }

  if (!tcbApp) {
    console.warn('[Sync] CloudBase 未初始化，同步功能不可用');
    return null;
  }

  if (!store) {
    console.warn('[Sync] Store 未初始化，同步功能不可用');
    return null;
  }

  try {
    const cloudStore = new CloudStore(tcbApp);
    const verifyManager = new VerifyCodeManager(cloudStore);
    authManager = new AuthManager(cloudStore, store, verifyManager);
    syncEngine = new SyncEngine(store, cloudStore, authManager);
    initialized = true;

    // 启动时如果已登录，处理旧数据迁移 + 自动拉取
    const status = authManager.getStatus();
    if (status.isLoggedIn) {
      // 旧数据迁移：老用户没有 profiles:{uid}: 归档，自动将当前顶层数据绑定
      if (!syncEngine.profile.hasProfile(status.uid)) {
        console.log('[Profile] 检测到旧数据，自动迁移到账户:', status.uid);
        syncEngine.profile.bindCurrentDataToProfile(status.uid);
      }
      syncEngine.profile.activeUid = status.uid;

      setTimeout(() => {
        syncEngine.pull().catch((err) => {
          console.error('[Sync] 启动自动拉取失败:', err.message);
        });
      }, 3000);
    } else {
      // 未登录时，活跃 profile 设为 anonymous
      syncEngine.profile.activeUid = 'anonymous';
    }

    console.log('[Sync] 同步模块初始化完成');
    return { auth: authManager, engine: syncEngine };
  } catch (err) {
    console.error('[Sync] 初始化失败:', err.message);
    return null;
  }
}

function getAuth() {
  return authManager;
}

function getEngine() {
  return syncEngine;
}

module.exports = {
  initSync,
  getAuth,
  getEngine,
  getVerify: () => {
    const { getAuth } = require('./auth');
    const auth = getAuth();
    return auth ? auth.verify : null;
  },
};
