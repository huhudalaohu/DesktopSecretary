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

const { app, BrowserWindow, screen, ipcMain, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const platform = require('./main/platform');
const { initSync, getAuth, getEngine } = require('./main/sync');
const { cleanupLinkCache } = require('./main/utils/link-preview');
const { registerStoreIpcHandlers } = require('./main/ipc/store');
const { registerFilesIpcHandlers } = require('./main/ipc/files');
const { registerWindowIpcHandlers } = require('./main/ipc/window');
const { registerLinkPreviewIpcHandlers } = require('./main/ipc/link-preview');
const { registerShortcutsIpcHandlers } = require('./main/ipc/shortcuts');
const { registerDockIpcHandlers } = require('./main/ipc/dock');
const { registerAutolaunchIpcHandlers } = require('./main/ipc/autolaunch');
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
  registerStoreIpcHandlers({ storeManager, getEngine });
  registerFilesIpcHandlers({ storeManager, getMainWindow, platform });
  registerWindowIpcHandlers({ getMainWindow, dockManager, storeManager });
  registerLinkPreviewIpcHandlers({ storeManager });
  registerShortcutsIpcHandlers({ shortcutManager, getMainWindow, platform });
  registerDockIpcHandlers({ dockManager, storeManager });
  registerAutolaunchIpcHandlers({ storeManager });
  registerDataIpcHandlers({
    store: storeManager,
    getMainWindow,
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

    // 4. 注册 IPC（必须在窗口加载前完成，否则渲染进程调用时 handler 还未注册）
    registerIpcHandlers();

    await windowManager.createWindow();

    screenshotManager = new ScreenshotManager({ screen, ipcMain, getMainWindow, platform, getDockManager });

    console.log('createWindow() completed, window count:', BrowserWindow.getAllWindows().length);

    // 5. 自动更新
    const { autoUpdater: updater } = require('electron-updater');
    autoUpdater = updater;
    const platformDir = process.platform === 'darwin' ? 'mac' : 'win';
    const feedUrl = `https://ds-update-1420931574.cos.ap-guangzhou.myqcloud.com/updates/${platformDir}`;
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    console.log(`[AutoUpdate] 平台: ${process.platform}, 更新源: ${feedUrl}`);

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
      let message = err.message;
      let status = 'error';
      // 增强错误分类，给渲染进程更明确的提示
      if (message.includes('404') || message.includes('Not Found')) {
        message = '未找到更新文件（404），请稍后再试或前往官网手动下载。';
        status = 'not-found';
      } else if (message.includes('net::ERR') || message.includes('network')) {
        message = '网络连接失败，请检查网络后重试。';
        status = 'network-error';
      } else if (message.includes('certificate') || message.includes('SSL')) {
        message = '更新服务器证书错误，请检查系统时间或网络环境。';
        status = 'ssl-error';
      }
      console.error('[AutoUpdate] 错误:', err.message);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('update:status', { status, error: message });
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
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        if (!dockManager.dockExpanded && dockManager.dockedEdge !== null) {
          dockManager.expand('activate');
        }
      } else if (BrowserWindow.getAllWindows().length === 0) {
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

app.on('before-quit', () => {
  if (windowManager) windowManager.setQuitting(true);
});

app.on('will-quit', () => {
  if (shortcutManager) shortcutManager.unregisterAll();
  if (screenshotManager) screenshotManager.destroy();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
