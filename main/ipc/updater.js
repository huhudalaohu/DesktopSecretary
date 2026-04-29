/**
 * 自动更新 IPC Handlers（基于 electron-updater）
 */

const { ipcMain } = require('electron');

function registerUpdaterIpcHandlers({ getAutoUpdater }) {
  ipcMain.handle('updater:check', async () => {
    console.log('[AutoUpdate] 用户手动检查更新');
    const autoUpdater = getAutoUpdater();
    if (!autoUpdater) {
      return { success: false, error: '自动更新模块未初始化' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
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
