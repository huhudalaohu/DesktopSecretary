/**
 * DesktopSecretary - 主进程 (main.js)
 *
 * 职责：
 *   1. 应用生命周期管理（单实例、自动更新、退出清理）
 *   2. Manager 初始化与组装（Store/Dock/Window/Screenshot/Shortcut）
 *   3. IPC 注册（委托给各 Manager 和专用模块）
 *
 * 架构：
 *   main.js (~180 行) → Managers → IPC 模块 → 平台抽象层
 */

const { app, BrowserWindow, screen, ipcMain, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const platform = require('./main/platform');
const { initSync, getAuth, getEngine } = require('./main/sync');
const { cleanupLinkCache, fetchPage, fetchRenderedTitle } = require('./main/utils/link-preview');
const { registerDataIpcHandlers } = require('./main/ipc/data');
const { registerSyncIpcHandlers } = require('./main/ipc/sync');
const { registerUpdaterIpcHandlers } = require('./main/ipc/updater');
const { StoreManager, ShortcutManager, DockManager, ScreenshotManager, WindowManager } = require('./main/managers');

// 开发模式加载 .env
try { require('dotenv').config(); } catch { /* 生产环境静默跳过 */ }

// ========== 全局状态 ==========
let storeManager = null;
let dockManager = null;
let windowManager = null;
let screenshotManager = null;
let shortcutManager = null;
let autoUpdater = null;

// ========== 腾讯云 CloudBase ==========
let tcbApp = null;
let tcbAuth = null;
const TCB_ENV_ID = process.env.TCB_ENV_ID || 'ds-dev-d9g28xlrgd2600837';
let TCB_SECRET_ID = process.env.TCB_SECRET_ID;
let TCB_SECRET_KEY = process.env.TCB_SECRET_KEY;

if (!TCB_SECRET_ID || !TCB_SECRET_KEY) {
  try {
    const configPath = path.join(__dirname, 'config', 'publish-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      TCB_SECRET_ID = config.secretId;
      TCB_SECRET_KEY = config.secretKey;
    }
  } catch (err) {
    console.warn('[CloudBase] 读取配置文件失败:', err.message);
  }
}

if (TCB_SECRET_ID && TCB_SECRET_KEY) {
  try {
    const cloudbase = require('@cloudbase/node-sdk');
    tcbApp = cloudbase.init({ env: TCB_ENV_ID, secretId: TCB_SECRET_ID, secretKey: TCB_SECRET_KEY });
    tcbAuth = tcbApp.auth();
    console.log('[CloudBase] 初始化成功');
  } catch (err) {
    console.error('[CloudBase] 初始化失败:', err.message);
    tcbApp = null;
    tcbAuth = null;
  }
} else {
  console.warn('[CloudBase] 未配置 TCB_SECRET_ID / TCB_SECRET_KEY，同步功能已禁用');
}

// ========== 辅助函数 ==========
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173';

function getEnv() {
  return app.isPackaged ? 'production' : 'development';
}

function getMainWindow() {
  return windowManager ? windowManager.getMainWindow() : null;
}

function getDockManager() {
  return dockManager;
}

// ========== IPC 处理器注册 ==========
function registerIpcHandlers() {
  // store:get / store:set — 使用 StoreManager
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

  // resize-window
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

  // get-window-width
  ipcMain.handle('get-window-width', () => {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win.getSize()[0] : 350;
  });

  // open-external
  ipcMain.handle('open-external', async (_event, url) => {
    try { await shell.openExternal(url); } catch (err) { console.error('[OpenExternal] 失败:', err); }
  });

  // fetch-link-preview
  ipcMain.handle('fetch-link-preview', async (_event, url) => {
    const cacheKey = require('crypto').createHash('md5').update(url).digest('hex');
    const cached = storeManager.get(`linkCache.${cacheKey}`, null);
    if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
      return { ...cached, cached: true };
    }
    const timeoutResult = { title: null, favicon: null, description: null, source: 'timeout', error: 'TIMEOUT' };
    try {
      const result = await Promise.race([
        fetchPage(url),
        new Promise(resolve => setTimeout(() => resolve(timeoutResult), 3000)),
      ]);
      if (result.title && !result.error) {
        storeManager.set(`linkCache.${cacheKey}`, { ...result, timestamp: Date.now() });
      }
      if (Math.random() < 0.1) cleanupLinkCache(storeManager);
      return result;
    } catch {
      return timeoutResult;
    }
  });

  // fetch-rendered-title
  ipcMain.handle('fetch-rendered-title', async (_event, url) => {
    const cacheKey = require('crypto').createHash('md5').update(`render:${url}`).digest('hex');
    const cached = storeManager.get(`linkCache.${cacheKey}`, null);
    if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
      return { ...cached, cached: true };
    }
    const result = await fetchRenderedTitle(url);
    if (result.title) {
      storeManager.set(`linkCache.${cacheKey}`, { ...result, timestamp: Date.now() });
    }
    return result;
  });

  // shortcut — 委托给 ShortcutManager
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

  // Dock 控制 — 委托给 DockManager
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
  ipcMain.handle('dock:get-edge', () => ({ dockedEdge: dockManager.dockedEdge, dockBounds: dockManager.dockBounds }));

  // auto-launch
  ipcMain.handle('get-auto-launch', () => storeManager.get('autoLaunch', false));
  ipcMain.handle('set-auto-launch', (_event, enabled) => {
    storeManager.set('autoLaunch', !!enabled);
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    console.log(`[AutoLaunch] 开机自启设置为: ${!!enabled}`);
    return { success: true };
  });

  // 数据/同步/更新 IPC
  registerDataIpcHandlers({
    store: storeManager,
    mainWindow: getMainWindow(),
    dialog,
    decryptAiSettings: (s) => storeManager.decryptAiSettings(s),
    safeStoreSet: (k, v) => storeManager.safeStoreSet(k, v),
  });
  registerUpdaterIpcHandlers({ getAutoUpdater: () => autoUpdater });
  registerSyncIpcHandlers({ getAuth, getEngine });
}

// ========== 单实例锁定 ==========
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[App] 已有实例在运行，退出当前实例');
  app.quit();
  return;
}

app.on('second-instance', () => {
  console.log('[App] 检测到第二次启动，聚焦已有窗口');
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (!dockManager.dockExpanded && dockManager.dockedEdge !== null) {
      dockManager.expand('second-instance');
    }
  }
});

// ========== 应用启动 ==========
app.whenReady().then(async () => {
  try {
    platform.windowOptions.applyAppLevelPlatformSetup(app);

    // 1. 初始化 Store（兼容 electron-store 的 defaults）
    const Store = (await import('electron-store')).default;
    const electronStore = new Store({
      name: 'desktop-secretary-data',
      defaults: {
        workspaces: [
          { id: 'project-a', name: '项目A' },
          { id: 'project-b', name: '项目B' },
          { id: 'daily', name: '日常' },
        ],
        pinnedFolders: [],
        recentFolders: [],
        todos: {},
        quickLinks: {},
        linkCache: {},
        aiSettings: { provider: 'kimi', apiKey: '', customBaseUrl: '', customModel: 'mimo-chat', shortcutKey: 'CmdOrCtrl+Shift+A' },
      },
    });
    storeManager = new StoreManager(electronStore);

    // 2. 初始化同步引擎
    initSync(electronStore, tcbApp);

    // 3. 创建 Managers
    dockManager = new DockManager({ screen, getMainWindow, stateManager: storeManager });
    dockManager.initFromStore();

    shortcutManager = new ShortcutManager({ globalShortcut, getMainWindow });

    windowManager = new WindowManager({ screen, getEnv, getDockManager, platform });
    await windowManager.createWindow();

    screenshotManager = new ScreenshotManager({ screen, ipcMain, getMainWindow, platform, getDockManager });

    // 4. 注册 IPC
    registerIpcHandlers();

    console.log('createWindow() completed, window count:', BrowserWindow.getAllWindows().length);

    // 5. 自动更新
    const { autoUpdater: updater } = require('electron-updater');
    autoUpdater = updater;
    const platformDir = process.platform === 'darwin' ? 'mac' : 'win';
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `https://ds-update-1420931574.cos.ap-guangzhou.myqcloud.com/updates/${platformDir}`,
    });
    console.log(`[AutoUpdate] 更新源已设置: /updates/${platformDir}/`);

    autoUpdater.on('checking-for-update', () => {
      console.log('[AutoUpdate] 正在检查更新...');
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('update:status', { status: 'checking' });
    });
    autoUpdater.on('update-available', (info) => {
      console.log('[AutoUpdate] 发现新版本:', info.version);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:status', { status: 'available', latestVersion: info.version, releaseNotes: info.releaseNotes });
      }
    });
    autoUpdater.on('update-not-available', () => {
      console.log('[AutoUpdate] 当前已是最新版本');
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('update:status', { status: 'latest' });
    });
    autoUpdater.on('download-progress', (progress) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:status', { status: 'downloading', progress: Math.round(progress.percent), receivedBytes: progress.transferred, totalBytes: progress.total });
      }
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log('[AutoUpdate] 更新已下载:', info.version);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('update:status', { status: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', (err) => {
      console.error('[AutoUpdate] 错误:', err.message);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('update:status', { status: 'error', error: err.message });
    });

    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => console.error('[AutoUpdate] 启动时检查更新失败:', err.message));
    }, 10000);

    // 6. 预创建截图 overlay
    screenshotManager.ensureOverlayReady().catch(err => {
      console.error('[Screenshot] overlay 预创建失败（首次截图时会重试）:', err);
    });
    screenshotManager.attachDisplayChangeListeners();

    // 7. 启动时恢复 dock 状态
    dockManager.dockPinned = storeManager.get('dockPinned', true);
    dockManager.expand('startup');

    // 8. 开机自启
    app.setLoginItemSettings({ openAtLogin: !!storeManager.get('autoLaunch', false) });

    // 9. 清理过期缓存
    cleanupLinkCache(storeManager);

    // 10. 清理临时更新安装包
    try {
      const tmpDir = os.tmpdir();
      let cleaned = 0;
      for (const f of fs.readdirSync(tmpDir)) {
        if (f.startsWith('DesktopSecretary-Update-') && f.endsWith('.exe')) {
          try { fs.unlinkSync(path.join(tmpDir, f)); cleaned++; } catch {}
        }
      }
      if (cleaned > 0) console.log(`[Update] 启动时清理了 ${cleaned} 个过期临时安装包`);
    } catch (err) {
      console.warn('[Update] 清理临时安装包失败:', err.message);
    }

    // 11. 启动时自动注册保存的快捷键
    const savedSettings = storeManager.getAiSettings();
    if (savedSettings.shortcutKey) {
      const accelerator = platform.shortcuts.normalizeShortcut(savedSettings.shortcutKey);
      shortcutManager.register(accelerator, () => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send('shortcut-triggered');
      });
    }
    const savedPinShortcut = storeManager.get('pinShortcutKey', '');
    if (savedPinShortcut) {
      const accelerator = platform.shortcuts.normalizeShortcut(savedPinShortcut);
      shortcutManager.registerPin(accelerator, () => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send('pin-shortcut-triggered');
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        windowManager.createWindow();
      }
    });
  } catch (err) {
    console.error('App startup error:', err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (shortcutManager) shortcutManager.unregisterAll();
  if (screenshotManager) screenshotManager.destroy();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
