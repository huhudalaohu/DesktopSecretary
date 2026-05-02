/**
 * 窗口尺寸控制 IPC Handlers
 */

const { ipcMain, screen } = require('electron');

function registerWindowIpcHandlers({ getMainWindow, dockManager, storeManager }) {
  ipcMain.handle('resize-window', (_event, newWidth) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    const w = Math.max(280, Math.min(600, newWidth));
    dockManager.dockExpandedWidth = w;
    const screenW = screen.getPrimaryDisplay().size.width;
    storeManager.set('windowWidthPercent', Math.round((w / screenW) * 100));
    if (!dockManager.dockExpanded) dockManager.expand('resize-window');
    else dockManager.positionWindow(true);
    return w;
  });

  ipcMain.handle('get-window-width', () => {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win.getSize()[0] : 350;
  });
}

module.exports = { registerWindowIpcHandlers };
