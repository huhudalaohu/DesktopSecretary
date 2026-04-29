/**
 * 云端同步 IPC Handlers
 */

const { ipcMain } = require('electron');

function registerSyncIpcHandlers({ getAuth, getEngine }) {
  /** sync:sendCode — 发送注册验证码 */
  ipcMain.handle('sync:sendCode', async (_event, email) => {
    try {
      const auth = getAuth();
      if (!auth) throw new Error('同步模块未初始化');
      if (!auth.verify) throw new Error('验证码模块未初始化');
      return await auth.verify.sendCode(email.trim().toLowerCase());
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:register — 用户注册（需验证码） */
  ipcMain.handle('sync:register', async (_event, username, password, code, importLocalData = true) => {
    try {
      const auth = getAuth();
      if (!auth) throw new Error('同步模块未初始化');
      const result = await auth.register(username, password, code);
      const uid = result.uid;
      const engine = getEngine();
      if (engine) {
        if (importLocalData) {
          // 将当前顶层数据绑定到新账户并推送
          engine.profile.bindCurrentDataToProfile(uid);
          engine.profile.activeUid = uid;
          engine.push().catch((err) => console.error('[Sync] 注册后首次 Push 失败:', err.message));
        } else {
          // 空账户注册：将当前数据归档到匿名空间，清空顶层，不推送
          engine.profile.archiveProfile('anonymous');
          engine.profile.clearActiveKeys();
          engine.profile.activeUid = uid;
          console.log('[Profile] 空账户注册，已清空本地数据');
        }
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:login — 用户登录 */
  ipcMain.handle('sync:login', async (_event, username, password) => {
    try {
      const auth = getAuth();
      if (!auth) throw new Error('同步模块未初始化');
      const result = await auth.login(username, password);
      const uid = result.uid;
      const engine = getEngine();
      if (engine) {
        // ⭐ 关键：切换 profile 时合并匿名数据
        await engine.switchProfile(uid, { mergeAnonymous: true });
        engine.pull().catch((err) => console.error('[Sync] 登录后自动 Pull 失败:', err.message));
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:logout — 退出登录 */
  ipcMain.handle('sync:logout', async () => {
    try {
      const auth = getAuth();
      const engine = getEngine();
      if (!auth) throw new Error('同步模块未初始化');

      // 先归档当前账户数据，再切回匿名
      const currentUid = engine?.profile?.activeUid;
      if (engine && currentUid && currentUid !== 'anonymous') {
        engine.profile.archiveProfile(currentUid);
        await engine.switchProfile('anonymous', { mergeAnonymous: false });
      }

      return await auth.logout();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:getStatus — 获取登录状态 */
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
