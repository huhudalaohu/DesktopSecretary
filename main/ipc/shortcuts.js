/**
 * 全局快捷键 IPC Handlers
 */

const { ipcMain } = require('electron');

function registerShortcutsIpcHandlers({ shortcutManager, getMainWindow, platform }) {
  ipcMain.handle('register-shortcut', (_event, accelerator) => {
    const normalized = platform.shortcuts.normalizeShortcut(accelerator);
    return shortcutManager.register(normalized, () => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('shortcut-triggered');
    });
  });

  ipcMain.handle('unregister-shortcut', () => shortcutManager.unregister());

  ipcMain.handle('register-pin-shortcut', (_event, accelerator) => {
    const normalized = platform.shortcuts.normalizeShortcut(accelerator);
    return shortcutManager.registerPin(normalized, () => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('pin-shortcut-triggered');
    });
  });

  ipcMain.handle('unregister-pin-shortcut', () => shortcutManager.unregisterPin());
}

module.exports = { registerShortcutsIpcHandlers };
