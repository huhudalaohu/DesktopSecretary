/**
 * DesktopSecretary - 主进程 (main.js)
 *
 * 职责:
 *   1. 创建并管理固定在屏幕右侧的无边框窗口
 *   2. 注册所有 IPC 通道供渲染进程调用
 *   3. 通过 electron-store 持久化数据
 *   4. 全局快捷键注册
 *
 * IPC 通道一览:
 *   - store:get            — 读取 electron-store 中指定 key 的值
 *   - store:set            — 写入 electron-store 中指定 key 的值
 *   - open-folder          — 用系统默认方式打开文件夹，并记录到 recentFolders
 *   - capture-screenshot   — 截取所有屏幕截图，返回 base64 数组
 *   - get-desktop-files    — 扫描桌面目录，返回最近修改的文件列表
 *   - move-files           — 将文件从源路径移动到目标文件夹（含确认对话框）
 *   - show-error           — 弹出系统错误提示框
 *   - get-screen-info      — 返回所有屏幕的尺寸和位置信息
 *   - get-front-windows    — 获取前台窗口信息（Windows）
 *   - register-shortcut    — 注册全局快捷键
 *   - unregister-shortcut  — 注销全局快捷键
 */

const { app, BrowserWindow, screen, ipcMain, shell, desktopCapturer, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// electron-store 使用 dynamic import（v8+ 为 ESM-only）
let Store;
let store;

// 主窗口引用
let mainWindow = null;

// 当前注册的快捷键
let registeredShortcut = null;

/**
 * 初始化 electron-store
 * 存储键说明:
 *   - workspaces:     工作区列表 [{id, name}]
 *   - pinnedFolders:  置顶文件夹 [{path, alias, id}]
 *   - recentFolders:  最近访问 [{path, timestamp}]
 *   - todos:          待办事项按工作区分组 { workspaceId: [{id, text, done, priority}] }
 *   - aiSettings:     AI 设置 { provider, apiKey, customBaseUrl, customModel, shortcutKey }
 */
async function initStore() {
  Store = (await import('electron-store')).default;
  store = new Store({
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
      aiSettings: {
        provider: 'kimi',
        apiKey: '',
        customBaseUrl: '',
        customModel: 'mimo-chat',
        shortcutKey: 'Ctrl+Shift+A',
      },
    },
  });
}

/**
 * 将窗口定位到主屏幕右侧，高度占满工作区
 */
function positionWindow(win) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primaryDisplay.workAreaSize;
  const { x: sx, y: sy } = primaryDisplay.workArea;

  const winWidth = 350;
  win.setSize(winWidth, sh);
  win.setPosition(sx + sw - winWidth, sy);
}

/**
 * 创建主窗口
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 350,
    height: 800,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html')).catch((err) => {
    console.error('Failed to load index.html:', err);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Window loaded successfully');
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('Window failed to load:', code, desc);
  });
  mainWindow.on('closed', () => {
    console.log('Window closed');
    mainWindow = null;
  });

  positionWindow(mainWindow);

  screen.on('display-metrics-changed', () => positionWindow(mainWindow));
  screen.on('display-added', () => positionWindow(mainWindow));
  screen.on('display-removed', () => positionWindow(mainWindow));
}

// ========== IPC 处理器 ==========

function registerIpcHandlers() {
  /** store:get — 读取 electron-store 数据 */
  ipcMain.handle('store:get', (_event, key, defaultValue) => {
    return store.get(key, defaultValue);
  });

  /** store:set — 写入 electron-store 数据 */
  ipcMain.handle('store:set', (_event, key, value) => {
    store.set(key, value);
  });

  /** open-folder — 打开系统文件夹并记录到最近访问 */
  ipcMain.handle('open-folder', async (_event, folderPath) => {
    try {
      await shell.openPath(folderPath);
      const recent = store.get('recentFolders', []);
      const filtered = recent.filter((r) => r.path !== folderPath);
      filtered.unshift({ path: folderPath, timestamp: Date.now() });
      store.set('recentFolders', filtered.slice(0, 15));
    } catch (err) {
      dialog.showErrorBox('打开文件夹失败', err.message);
    }
  });

  /**
   * capture-screenshot — 截取所有屏幕的截图
   * 获取所有显示器的分辨率，使用最大分辨率作为 thumbnailSize 确保完整截取
   * 返回 { sources: [{id, name, dataUrl, displayId}], totalDisplays }
   */
  ipcMain.handle('capture-screenshot', async () => {
    try {
      // 获取所有显示器信息，用于调试日志
      const displays = screen.getAllDisplays();
      console.log('[Screenshot] 检测到显示器数量:', displays.length);
      displays.forEach((d, i) => {
        console.log(`[Screenshot] 显示器${i}: id=${d.id}, bounds=${JSON.stringify(d.bounds)}, size=${d.size.width}x${d.size.height}, scaleFactor=${d.scaleFactor}`);
      });

      // 计算所有显示器中最大分辨率，确保截图覆盖完整
      let maxWidth = 0;
      let maxHeight = 0;
      for (const d of displays) {
        const w = d.size.width * d.scaleFactor;
        const h = d.size.height * d.scaleFactor;
        if (w > maxWidth) maxWidth = w;
        if (h > maxHeight) maxHeight = h;
      }
      // 至少 1920x1080，避免太小
      maxWidth = Math.max(maxWidth, 1920);
      maxHeight = Math.max(maxHeight, 1080);
      console.log(`[Screenshot] thumbnailSize: ${maxWidth}x${maxHeight}`);

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxWidth, height: maxHeight },
      });

      console.log('[Screenshot] 捕获源数量:', sources.length);
      sources.forEach((s, i) => {
        const sz = s.thumbnail.getSize();
        console.log(`[Screenshot] 源${i}: id=${s.display_id}, name="${s.name}", thumbnail=${sz.width}x${sz.height}`);
      });

      // 返回所有屏幕的截图
      return {
        sources: sources.map((s) => ({
          id: s.id,
          displayId: s.display_id,
          name: s.name,
          dataUrl: s.thumbnail.toDataURL(),
          thumbnailSize: s.thumbnail.getSize(),
        })),
        totalDisplays: displays.length,
      };
    } catch (err) {
      console.error('[Screenshot] 截图失败:', err);
      return { error: err.message };
    }
  });

  /**
   * get-screen-info — 返回所有屏幕的尺寸和位置
   * 用于渲染进程绘制截图遮罩层覆盖全部屏幕
   */
  ipcMain.handle('get-screen-info', () => {
    const displays = screen.getAllDisplays();
    return displays.map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      size: d.size,
      scaleFactor: d.scaleFactor,
    }));
  });

  /**
   * get-front-windows — 获取前台窗口信息（Windows 专用）
   * 使用 PowerShell 调用 Win32 API 获取当前前台窗口的进程名和位置
   * 用于检测微信/QQ/飞书等聊天窗口
   */
  ipcMain.handle('get-front-windows', () => {
    if (process.platform !== 'win32') return [];

    try {
      // PowerShell 脚本：获取前台窗口信息
      const psScript = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          using System.Text;
          public class Win32 {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll", CharSet = CharSet.Auto)]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
            [DllImport("user32.dll")]
            public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
            [StructLayout(LayoutKind.Sequential)]
            public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
          }
"@
        $hwnd = [Win32]::GetForegroundWindow()
        $title = New-Object System.Text.StringBuilder 256
        [Win32]::GetWindowText($hwnd, $title, 256) | Out-Null
        $rect = New-Object Win32+RECT
        [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
        $pidVal = [uint32]0
        [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pidVal) | Out-Null
        $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
        $result = @{
          title = $title.ToString()
          processName = if ($proc) { $proc.ProcessName } else { "" }
          rect = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
        }
        $result | ConvertTo-Json -Compress
      `;

      const output = execSync(`powershell -Command "${psScript.replace(/"/g, '\\"')}"`, {
        timeout: 5000,
        encoding: 'utf8',
      });

      const winInfo = JSON.parse(output.trim());

      // 已知聊天应用列表
      const chatApps = ['WeChat', 'QQ', 'Feishu', 'Lark', 'DingTalk', 'WeCom', 'TIM', 'Telegram'];
      const isChatApp = chatApps.some((app) =>
        winInfo.processName?.toLowerCase().includes(app.toLowerCase())
      );

      return [{
        title: winInfo.title,
        processName: winInfo.processName,
        rect: winInfo.rect,
        isChatApp,
      }];
    } catch (err) {
      console.log('[FrontWindow] 获取前台窗口信息失败:', err.message);
      return [];
    }
  });

  /** get-desktop-files — 扫描桌面文件 */
  ipcMain.handle('get-desktop-files', async () => {
    try {
      const desktopPath = app.getPath('desktop');
      const entries = await fs.promises.readdir(desktopPath, { withFileTypes: true });
      const files = [];

      for (const entry of entries) {
        const fullPath = path.join(desktopPath, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          files.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            mtime: stat.mtimeMs,
          });
        } catch {
          // 跳过无法访问的文件
        }
      }

      files.sort((a, b) => b.mtime - a.mtime);
      return files.slice(0, 20);
    } catch (err) {
      dialog.showErrorBox('扫描桌面失败', err.message);
      return [];
    }
  });

  /** move-files — 移动文件（含确认对话框） */
  ipcMain.handle('move-files', async (event, fromPaths, toDir) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
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
        const fileName = path.basename(src);
        const dest = path.join(toDir, fileName);
        await fs.promises.rename(src, dest);
        results.push({ file: src, success: true });
      } catch (err) {
        results.push({ file: src, success: false, error: err.message });
      }
    }
    return { success: true, results };
  });

  /** show-error — 弹出系统错误提示框 */
  ipcMain.handle('show-error', (_event, title, content) => {
    dialog.showErrorBox(title, content);
  });

  /** close-app — 关闭应用 */
  ipcMain.handle('close-app', () => {
    app.quit();
  });

  /**
   * register-shortcut — 注册全局快捷键
   * @param {string} accelerator — 快捷键字符串，如 "Ctrl+Shift+A"
   * 先注销旧快捷键，再注册新的
   */
  ipcMain.handle('register-shortcut', (_event, accelerator) => {
    // 先注销旧的
    if (registeredShortcut) {
      try { globalShortcut.unregister(registeredShortcut); } catch {}
      registeredShortcut = null;
    }

    if (!accelerator) return { success: true };

    try {
      const registered = globalShortcut.register(accelerator, () => {
        // 快捷键触发时通知渲染进程
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('shortcut-triggered');
        }
      });
      if (registered) {
        registeredShortcut = accelerator;
        console.log(`[Shortcut] 已注册: ${accelerator}`);
        return { success: true };
      } else {
        return { success: false, error: '快捷键注册失败，可能已被其他程序占用' };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** unregister-shortcut — 注销当前全局快捷键 */
  ipcMain.handle('unregister-shortcut', () => {
    if (registeredShortcut) {
      try { globalShortcut.unregister(registeredShortcut); } catch {}
      console.log(`[Shortcut] 已注销: ${registeredShortcut}`);
      registeredShortcut = null;
    }
    return { success: true };
  });
}

// ========== 应用生命周期 ==========

app.whenReady().then(async () => {
  try {
    await initStore();
    registerIpcHandlers();
    createWindow();
    console.log('createWindow() completed, window count:', BrowserWindow.getAllWindows().length);

    // 启动时自动注册保存的快捷键
    const savedSettings = store.get('aiSettings', {});
    if (savedSettings.shortcutKey) {
      const result = await new Promise((resolve) => {
        if (registeredShortcut) {
          try { globalShortcut.unregister(registeredShortcut); } catch {}
          registeredShortcut = null;
        }
        try {
          const ok = globalShortcut.register(savedSettings.shortcutKey, () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('shortcut-triggered');
            }
          });
          if (ok) {
            registeredShortcut = savedSettings.shortcutKey;
            console.log(`[Shortcut] 启动时自动注册: ${savedSettings.shortcutKey}`);
          }
          resolve(ok);
        } catch (err) {
          resolve(false);
        }
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (err) {
    console.error('App startup error:', err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出时注销快捷键
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
