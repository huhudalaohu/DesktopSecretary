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
   *                 accessToken?: string,          // 仅内存使用的 CloudBase access token
   *               }
   */
  ipcMain.handle('auth:setUid', async (_event, uid, opts = {}) => {
    try {
      const auth = getAuth();
      if (!auth) throw new Error('同步模块未初始化');
      if (!uid) throw new Error('uid 不能为空');

      const hadAccessToken = auth.hasAccessToken();
      auth.setSession({
        uid,
        username: opts.username || '',
        accessToken: opts.accessToken || '',
      });

      const engine = getEngine();
      if (engine) {
        const sameProfile = engine.profile.activeUid === uid;
        if (sameProfile && !opts.isNewUser) {
          // 应用重启后 renderer SDK 才能续期 token。令牌首次就绪时再拉取，
          // 后续刷新 token 不重复切换 profile，避免覆盖正在编辑的本地数据。
          if (!hadAccessToken && auth.hasAccessToken()) {
            const hasAnonymousData = engine.profile.hasAnonymousData();
            engine.pull()
              .then(async (pullResult) => {
                if (!pullResult.success || !hasAnonymousData) return;
                const mergeResult = engine.profile.mergeAnonymousIntoActive();
                if (!mergeResult.merged) return;
                const pushResult = await engine.push();
                if (!pushResult.success) {
                  console.error('[Sync] 恢复匿名数据上传失败:', pushResult.error);
                }
              })
              .catch((err) => console.error('[Sync] 登录态恢复 Pull 失败:', err.message));
          }
        } else if (opts.isNewUser) {
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
          // 登录时先拉取云端，再合并匿名数据并回推，避免本地临时数据覆盖云端。
          await engine.switchProfile(uid, { mergeAnonymous: false });
          const hasAnonymousData = engine.profile.hasAnonymousData();
          engine.pull()
            .then(async (pullResult) => {
              if (!pullResult.success || !hasAnonymousData) return;
              const mergeResult = engine.profile.mergeAnonymousIntoActive();
              if (!mergeResult.merged) return;
              const pushResult = await engine.push();
              if (!pushResult.success) {
                console.error('[Sync] 登录后匿名数据合并上传失败:', pushResult.error);
              }
            })
            .catch((err) => console.error('[Sync] 登录后自动 Pull 失败:', err.message));
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
    const engine = getEngine();
    return { ...auth.getStatus(), ...(engine ? engine.getStatus() : {}) };
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
