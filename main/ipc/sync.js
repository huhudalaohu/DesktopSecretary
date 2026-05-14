/**
 * 云端同步 IPC Handlers(v2)
 *
 * v2 改动:
 *   - 注册/登录/验证码由渲染进程通过 @cloudbase/js-sdk 直接对接 CloudBase
 *     身份认证服务,主进程不再做这些事
 *   - 新增 `auth:setUid` / `auth:clearUid`:渲染进程 SDK 登录/登出后通知主进程
 *     同步引擎切换 profile
 *   - 旧的 `sync:register/login/sendCode` 已删除
 */

const { ipcMain } = require('electron');

function registerSyncIpcHandlers({ getAuth, getEngine }) {
  /**
   * auth:setUid — 渲染进程 SDK 登录成功后,通知主进程绑定 uid
   *
   * @param uid    CloudBase 用户 uid
   * @param opts   {
   *                 username?: string,            // 邮箱,仅用于显示
   *                 isNewUser?: boolean,          // true=注册流程,false=登录流程
   *                 importLocalData?: boolean,    // 注册时是否把本地匿名数据带入新账户
   *               }
   */
  ipcMain.handle('auth:setUid', async (_event, uid, opts = {}) => {
    try {
      const auth = getAuth();
      if (!auth) throw new Error('同步模块未初始化');
      if (!uid) throw new Error('uid 不能为空');

      auth.setSession({ uid, username: opts.username || '' });

      const engine = getEngine();
      if (engine) {
        if (opts.isNewUser) {
          if (opts.importLocalData) {
            // 注册时选择「带入本地数据」:把当前顶层数据归档到新 uid,然后 push
            engine.profile.bindCurrentDataToProfile(uid);
            engine.profile.activeUid = uid;
            engine.push().catch((err) => console.error('[Sync] 注册后首次 Push 失败:', err.message));
          } else {
            // 注册时选择「空账户」:把当前顶层数据归档到 anonymous,清空顶层
            engine.profile.archiveProfile('anonymous');
            engine.profile.clearActiveKeys();
            engine.profile.activeUid = uid;
            console.log('[Profile] 空账户注册，已清空本地数据');
          }
        } else {
          // 登录:切换 profile,并把匿名数据合并进来
          await engine.switchProfile(uid, { mergeAnonymous: true });
          engine.pull().catch((err) => console.error('[Sync] 登录后自动 Pull 失败:', err.message));
        }
      }

      return { success: true, uid, username: opts.username || '' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /**
   * auth:clearUid — 渲染进程 SDK 登出后,通知主进程清除会话
   */
  ipcMain.handle('auth:clearUid', async () => {
    try {
      const auth = getAuth();
      const engine = getEngine();
      if (!auth) throw new Error('同步模块未初始化');

      const currentUid = engine?.profile?.activeUid;
      if (engine && currentUid && currentUid !== 'anonymous') {
        engine.profile.archiveProfile(currentUid);
        await engine.switchProfile('anonymous', { mergeAnonymous: false });
      }

      auth.clearSession();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:getStatus — 获取登录状态(由 main session 派生) */
  ipcMain.handle('sync:getStatus', () => {
    const auth = getAuth();
    if (!auth) return { isLoggedIn: false, error: '同步模块未初始化' };
    return auth.getStatus();
  });

  /** sync:syncNow — 手动触发同步 */
  ipcMain.handle('sync:syncNow', async () => {
    try {
      const engine = getEngine();
      if (!engine) throw new Error('同步模块未初始化');
      return await engine.sync();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:push — 手动上传 */
  ipcMain.handle('sync:push', async () => {
    try {
      const engine = getEngine();
      if (!engine) throw new Error('同步模块未初始化');
      return await engine.push();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:pull — 手动下载 */
  ipcMain.handle('sync:pull', async () => {
    try {
      const engine = getEngine();
      if (!engine) throw new Error('同步模块未初始化');
      return await engine.pull();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerSyncIpcHandlers };
