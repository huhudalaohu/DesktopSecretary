/**
 * 开机自启 IPC Handlers
 */

const { ipcMain, app } = require('electron');

function registerAutolaunchIpcHandlers({ storeManager }) {
  ipcMain.handle('get-auto-launch', () => storeManager.get('autoLaunch', false));

  ipcMain.handle('set-auto-launch', (_event, enabled) => {
    storeManager.set('autoLaunch', !!enabled);
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    console.log(`[AutoLaunch] 开机自启设置为: ${!!enabled}`);
    return { success: true };
  });
}

module.exports = { registerAutolaunchIpcHandlers };
