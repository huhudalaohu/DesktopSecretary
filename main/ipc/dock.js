/**
 * Dock 控制 IPC Handlers
 */

const { ipcMain } = require('electron');

function registerDockIpcHandlers({ dockManager, storeManager }) {
  ipcMain.handle('dock:pin', () => {
    dockManager.dockPinned = true;
    storeManager.set('dockPinned', true);
    if (!dockManager.dockExpanded) dockManager.expand('pin');
    console.log('[Dock] 已锁定');
    return { success: true };
  });

  ipcMain.handle('dock:unpin', () => {
    dockManager.dockPinned = false;
    storeManager.set('dockPinned', false);
    console.log('[Dock] 已解锁');
    return { success: true };
  });

  ipcMain.handle('dock:toggle-pin', () => {
    dockManager.dockPinned = !dockManager.dockPinned;
    storeManager.set('dockPinned', dockManager.dockPinned);
    if (dockManager.dockPinned && !dockManager.dockExpanded) dockManager.expand('pin');
    console.log(`[Dock] 锁定状态: ${dockManager.dockPinned}`);
    return { pinned: dockManager.dockPinned };
  });

  ipcMain.handle('dock:expand', (_event, delay) => {
    dockManager.expand('外部请求');
    if (delay && delay > 0) {
      setTimeout(() => {
        if (!dockManager.dockPinned && dockManager.dockedEdge !== null) {
          dockManager.collapse(`延时${delay}ms 后收起`);
        }
      }, delay);
    }
    return { success: true };
  });

  ipcMain.handle('dock:set-interacting', () => ({ success: true }));

  ipcMain.handle('dock:get-state', () => dockManager.getState());

  ipcMain.handle('dock:get-edge', () => ({
    dockedEdge: dockManager.dockedEdge,
    dockBounds: dockManager.dockBounds,
  }));
}

module.exports = { registerDockIpcHandlers };
