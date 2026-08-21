/**
 * 同步模块统一入口(v2)
 *
 * v2 改动:
 *   - 删除 VerifyCodeManager(验证码由 CloudBase 内置邮件服务接管)
 *   - AuthManager 仅维护 uid session,不再做注册登录
 */

const { AuthManager } = require('./auth');
const { CloudStore } = require('./cloud');
const { SyncEngine } = require('./engine');

let authManager = null;
let syncEngine = null;
let initialized = false;

function initSync(store) {
  if (initialized) {
    console.warn('[Sync] 已初始化，跳过');
    return { auth: authManager, engine: syncEngine };
  }

  if (!store) {
    console.warn('[Sync] Store 未初始化，同步功能不可用');
    return null;
  }

  try {
    authManager = new AuthManager(store);
    const cloudStore = new CloudStore(authManager);
    syncEngine = new SyncEngine(store, cloudStore, authManager);
    initialized = true;

    // 启动时如果已有会话(渲染进程登录后会持久化),恢复 profile + 自动 pull
    const status = authManager.getStatus();
    if (status.isLoggedIn) {
      // 旧数据迁移:老用户没有 profiles:{uid}: 归档时,自动绑定当前顶层数据
      if (!syncEngine.profile.hasProfile(status.uid)) {
        console.log('[Profile] 检测到旧数据，自动迁移到账户:', status.uid);
        syncEngine.profile.bindCurrentDataToProfile(status.uid);
      }
      syncEngine.profile.activeUid = status.uid;
      syncEngine.restoreLastSync(status.uid);

      // 重启后的 AccessToken 只由渲染进程 SDK 续期，令牌就绪时会经
      // auth:setUid 触发首次拉取，避免启动阶段产生无意义的失败日志。
    } else {
      // 未登录时,活跃 profile 设为 anonymous
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
};
