/**
 * 文件操作 / 屏幕信息 / 系统交互 IPC Handlers
 */

const { ipcMain, shell, screen, dialog, app } = require('electron');
const path = require('path');
const fs = require('fs');

function registerFilesIpcHandlers({ storeManager, getMainWindow, platform }) {
  // open-folder
  ipcMain.handle('open-folder', async (_event, folderPath, storeKey) => {
    try {
      await shell.openPath(folderPath);
      const key = storeKey || 'recentFolders';
      const recent = storeManager.get(key, []);
      const filtered = recent.filter(r => r.path !== folderPath);
      filtered.unshift({ path: folderPath, timestamp: Date.now() });
      storeManager.set(key, filtered.slice(0, 15));
    } catch (err) {
      dialog.showErrorBox('打开文件夹失败', err.message);
    }
  });

  // list-dir:列出指定目录内容(文件导航多级级联浏览用)
  // 隐藏文件过滤;文件夹排前、文件在后,各自按名称排序;截断 200 条防卡顿
  // 失败返回 error 字段而不弹系统对话框(目录无权限是常态)
  ipcMain.handle('list-dir', async (_event, dirPath) => {
    try {
      if (!dirPath || typeof dirPath !== 'string') return { entries: [], error: 'invalid path' };
      const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const dirs = [];
      const files = [];
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue;
        const entry = { name: d.name, path: path.join(dirPath, d.name), isDirectory: d.isDirectory() };
        (d.isDirectory() ? dirs : files).push(entry);
      }
      const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      dirs.sort(byName);
      files.sort(byName);
      return { entries: dirs.concat(files).slice(0, 200) };
    } catch (err) {
      return { entries: [], error: err.message };
    }
  });

  // get-screen-info
  ipcMain.handle('get-screen-info', () => {
    return screen.getAllDisplays().map(d => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      size: d.size,
      scaleFactor: d.scaleFactor,
    }));
  });

  // get-front-windows
  ipcMain.handle('get-front-windows', async () => {
    try {
      const winInfo = await platform.windowInfo.getForegroundWindow();
      if (!winInfo) return [];
      const chatApps = ['WeChat', 'QQ', 'Feishu', 'Lark', 'DingTalk', 'WeCom', 'TIM', 'Telegram'];
      const isChatApp = chatApps.some(a => winInfo.processName?.toLowerCase().includes(a.toLowerCase()));
      return [{ title: winInfo.title, processName: winInfo.processName, rect: winInfo.rect, isChatApp }];
    } catch (err) {
      console.log('[FrontWindow] 获取失败:', err.message);
      return [];
    }
  });

  // get-desktop-files
  ipcMain.handle('get-desktop-files', async () => {
    try {
      const desktopPath = app.getPath('desktop');
      const entries = await fs.promises.readdir(desktopPath, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        const fullPath = path.join(desktopPath, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          files.push({ name: entry.name, path: fullPath, isDirectory: entry.isDirectory(), mtime: stat.mtimeMs });
        } catch { /* 跳过无法访问的文件 */ }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      return files.slice(0, 20);
    } catch (err) {
      dialog.showErrorBox('扫描桌面失败', err.message);
      return [];
    }
  });

  // move-files
  ipcMain.handle('move-files', async (event, fromPaths, toDir) => {
    const { response } = await dialog.showMessageBox(getMainWindow(), {
      type: 'question',
      buttons: ['确认移动', '取消'],
      defaultId: 1,
      title: '确认文件移动',
      message: `即将移动 ${fromPaths.length} 个文件到:\n${toDir}\n\n请确认操作。`,
    });
    if (response !== 0) return { success: false, cancelled: true };

    const results = [];
    for (const src of fromPaths) {
      try {
        const dest = path.join(toDir, path.basename(src));
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src);
        results.push({ file: src, success: true });
      } catch (err) {
        results.push({ file: src, success: false, error: err.message });
      }
    }
    return { success: true, results };
  });

  // show-error / close-app
  ipcMain.handle('show-error', (_event, title, content) => dialog.showErrorBox(title, content));
  ipcMain.handle('close-app', () => app.quit());

  // open-external
  ipcMain.handle('open-external', async (_event, url) => {
    try { await shell.openExternal(url); } catch (err) { console.error('[OpenExternal] 失败:', err); }
  });
}

module.exports = { registerFilesIpcHandlers };
