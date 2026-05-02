/**
 * Store 读写 IPC Handlers
 */

const { ipcMain } = require('electron');

function registerStoreIpcHandlers({ storeManager, getEngine }) {
  ipcMain.handle('store:get', (_event, key, defaultValue) => {
    if (key === 'aiSettings') {
      return storeManager.getAiSettings();
    }
    return storeManager.get(key, defaultValue);
  });

  ipcMain.handle('store:set', (_event, key, value) => {
    if (key === 'aiSettings') {
      storeManager.setAiSettings(value);
    } else {
      storeManager.set(key, value);
    }
    const engine = getEngine();
    if (engine) engine.onStoreChanged(key);
  });
}

module.exports = { registerStoreIpcHandlers };
