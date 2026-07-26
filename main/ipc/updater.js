/**
 * 自动更新 IPC Handlers（基于 electron-updater）
 */

const { ipcMain, app } = require('electron');

function registerUpdaterIpcHandlers({ getAutoUpdater }) {
  ipcMain.handle('updater:check', async () => {
    console.log('[AutoUpdate] 用户手动检查更新');
    const autoUpdater = getAutoUpdater();
    if (!autoUpdater) {
      return { success: false, error: '自动更新模块未初始化' };
    }
    // 未打包时 electron-updater 直接跳过检查且不发任何事件，
    // 渲染端会一直停在「检查中」，必须在这里明确返回
    if (!app.isPackaged && !autoUpdater.forceDevUpdateConfig) {
      return { success: false, error: '开发预览环境不支持检查更新，请在安装版中测试' };
    }
    try {
      // 超时兜底：网络挂死时 checkForUpdates 永不返回，UI 会永远「检查中」
      const result = await Promise.race([
        autoUpdater.checkForUpdates(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('检查更新超时，请检查网络后重试')), 30000)),
      ]);
      return { success: true, updateInfo: result?.updateInfo || null };
    } catch (err) {
      console.error('[AutoUpdate] 检查更新失败:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('updater:download', async () => {
    console.log('[AutoUpdate] 用户确认下载更新');
    const autoUpdater = getAutoUpdater();
    if (!autoUpdater) {
      return { success: false, error: '自动更新模块未初始化' };
    }
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      console.error('[AutoUpdate] 下载更新失败:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('updater:quit-and-install', async () => {
    console.log('[AutoUpdate] 用户确认退出并安装');
    const autoUpdater = getAutoUpdater();
    if (!autoUpdater) {
      return { success: false, error: '自动更新模块未初始化' };
    }
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  });
}

module.exports = { registerUpdaterIpcHandlers };
