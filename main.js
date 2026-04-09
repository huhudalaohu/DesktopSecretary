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
const https = require('https');
const http = require('http');

// electron-store 使用 dynamic import（v8+ 为 ESM-only）
let Store;
let store;

// 主窗口引用
let mainWindow = null;

// 截图 overlay 窗口
let overlayWindow = null;
let screenshotResolve = null;  // Promise resolve 函数，等待用户操作后回调
let capturedScreenshot = null; // desktopCapturer 返回的 NativeImage 源，用于裁剪

// ========== QQ 式 Dock 自动隐藏 ==========
const DOCK_EDGE_WIDTH = 6;       // 贴边时露出的细边宽度(px)
const DOCK_EXPANDED_WIDTH = 350; // 展开时的宽度(px)
const DOCK_HEIGHT_RATIO = 0.85;  // 高度占屏幕比例
const DOCK_HOT_ZONE_WIDTH = 20;  // 触发热区宽度(px)，鼠标进入此区域触发展开
const DOCK_HIDE_DELAY = 1500;    // 缩回延迟(ms)
const DOCK_GRACE_PERIOD = 500;   // 展开后的宽限期(ms)，期间不检测离开

let dockExpanded = false;        // 当前是否展开
let dockPinned = false;          // 是否锁定展开
let dockHideTimer = null;        // 缩回定时器
let dockGraceTimer = null;       // 宽限期定时器
let dockMouseTimer = null;       // 鼠标检测定时器
let dockInteracting = false;     // 用户是否正在窗口内交互（滚动/输入/点击）

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
      quickLinks: {},
      linkCache: {},
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
/**
 * 将窗口定位到 Dock 位置（贴边或展开）
 */
function positionDockWindow(expanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primaryDisplay.size;
  const { x: bx, y: by } = primaryDisplay.bounds;

  const w = expanded ? DOCK_EXPANDED_WIDTH : DOCK_EDGE_WIDTH;
  const h = Math.round(sh * DOCK_HEIGHT_RATIO);

  mainWindow.setBounds({
    x: bx + sw - w,
    y: by + Math.round((sh - h) / 2),
    width: w,
    height: h,
  }, true); // animate = true for smooth transition on some platforms
}

/**
 * 展开 Dock
 */
function expandDock(reason) {
  if (dockExpanded) return;
  console.log(`[Dock] 展开 (${reason})`);
  dockExpanded = true;
  clearTimeout(dockHideTimer);
  clearTimeout(dockGraceTimer);

  // 启用窗口交互
  mainWindow.setIgnoreMouseEvents(false);
  positionDockWindow(true);
  mainWindow.show();
  mainWindow.focus();

  // 宽限期：展开后一段时间内不检测离开
  dockGraceTimer = setTimeout(() => {
    dockGraceTimer = null;
  }, DOCK_GRACE_PERIOD);

  // 通知渲染进程切换样式
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dock:state-changed', { expanded: true });
  }
}

/**
 * 收起 Dock
 */
function collapseDock(reason) {
  if (!dockExpanded || dockPinned || dockInteracting) return;
  console.log(`[Dock] 收起 (${reason})`);
  dockExpanded = false;
  clearTimeout(dockHideTimer);

  // 通知渲染进程
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dock:state-changed', { expanded: false });
  }

  // 延迟缩小窗口（等动画结束后再 resize）
  setTimeout(() => {
    if (!dockExpanded && mainWindow && !mainWindow.isDestroyed()) {
      positionDockWindow(false);
    }
  }, 250);
}

/**
 * 安排延迟收起（幂等：如果已经在计时，不重复启动）
 */
function scheduleCollapse(reason) {
  if (dockPinned || dockInteracting) return;
  if (dockHideTimer) return; // 已经在倒计时中，不重置
  dockHideTimer = setTimeout(() => {
    dockHideTimer = null;
    if (!dockPinned && !dockInteracting) {
      collapseDock(reason);
    }
  }, DOCK_HIDE_DELAY);
}

/**
 * 鼠标位置检测循环（主进程轮询）
 */
function startDockMouseTracking() {
  let lastInZone = false;
  dockMouseTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = primaryDisplay.size;
    const { x: bx, y: by } = primaryDisplay.bounds;
    const sf = primaryDisplay.scaleFactor;
    const screenRightEdge = bx + sw;

    // 鼠标在屏幕右边缘热区
    const inHotZone = (
      cursor.x >= screenRightEdge - DOCK_HOT_ZONE_WIDTH &&
      cursor.x <= screenRightEdge &&
      cursor.y >= bounds.y &&
      cursor.y <= bounds.y + bounds.height
    );

    // 展开态：只在窗口右边缘 50px 内保持展开
    const inExpandedKeepZone = dockExpanded && (
      cursor.x >= bounds.x + bounds.width - 50 &&
      cursor.x <= bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y <= bounds.y + bounds.height
    );

    const inZone = inHotZone || inExpandedKeepZone;

    if (inZone) {
      if (!dockExpanded) {
        expandDock('鼠标进入热区');
      }
      clearTimeout(dockHideTimer);
      dockHideTimer = null;
    } else if (dockExpanded && !dockPinned) {
      if (!dockGraceTimer) {
        scheduleCollapse('鼠标离开窗口');
      }
    }

    // 每 2 秒输出一次调试信息（不管状态有没有变）
    if (Date.now() % 2000 < 100) {
      console.log(`[Dock Debug] cursor=(${cursor.x},${cursor.y}) rightEdge=${screenRightEdge} sw=${sw} sf=${sf} bounds=(${bounds.x},${bounds.y},${bounds.width}x${bounds.height}) inHotZone=${inHotZone} inExpandedKeepZone=${inExpandedKeepZone} inZone=${inZone} expanded=${dockExpanded} pinned=${dockPinned} grace=${!!dockGraceTimer} hideTimer=${!!dockHideTimer}`);
    }

    if (inZone !== lastInZone) {
      console.log(`[Dock] ${inZone ? '进入' : '离开'}热区, cursor=(${cursor.x},${cursor.y}), rightEdge=${screenRightEdge}, bounds=(${bounds.x},${bounds.y},${bounds.width}x${bounds.height})`);
      lastInZone = inZone;
    }
  }, 80);
}

/**
 * 创建主窗口（Dock 模式）
 */
function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primaryDisplay.size;
  const { x: bx, y: by } = primaryDisplay.bounds;
  const h = Math.round(sh * DOCK_HEIGHT_RATIO);

  mainWindow = new BrowserWindow({
    x: bx + sw - DOCK_EDGE_WIDTH,
    y: by + Math.round((sh - h) / 2),
    width: DOCK_EDGE_WIDTH,
    height: h,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#0f172a',
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
    clearInterval(dockMouseTimer);
    clearTimeout(dockHideTimer);
    clearTimeout(dockGraceTimer);
    console.log('Window closed');
    mainWindow = null;
  });

  // 启动鼠标位置检测
  startDockMouseTracking();
}

/**
 * 计算所有显示器合并后的虚拟屏幕边界
 */
function calculateVirtualBounds(displays) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 隐藏截图 overlay 窗口并恢复主窗口（不销毁，复用）
 */
function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

/**
 * 销毁截图 overlay 窗口（仅应用退出时调用）
 */
function destroyOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.removeAllListeners('closed');
    overlayWindow.destroy();
    overlayWindow = null;
  }
}

/**
 * 预创建截图 overlay 窗口（隐藏状态），点击时直接 show()
 */
function precreateOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

  const displays = screen.getAllDisplays();
  const virtualBounds = calculateVirtualBounds(displays);

  overlayWindow = new BrowserWindow({
    x: virtualBounds.x,
    y: virtualBounds.y,
    width: virtualBounds.width,
    height: virtualBounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'dist', 'screenshot-overlay.html'));

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    if (screenshotResolve) {
      screenshotResolve(null);
      screenshotResolve = null;
    }
    capturedScreenshot = null;
    // 窗口关闭后延迟重建，确保下次可用
    setTimeout(() => precreateOverlayWindow(), 500);
  });

  console.log('[Screenshot] Overlay 窗口预创建完成');
}

/**
 * 启动截图 overlay 流程
 * 返回 Promise<dataUrl | null>，null 表示用户取消
 */
function startScreenshotOverlay() {
  return new Promise(async (resolve) => {
    const t0 = Date.now();
    screenshotResolve = resolve;

    // 10 秒超时保护
    const timeout = setTimeout(() => {
      console.log('[Screenshot] overlay 超时，自动取消');
      hideOverlay();
      capturedScreenshot = null;
      if (screenshotResolve) {
        screenshotResolve(null);
        screenshotResolve = null;
      }
    }, 10000);

    // 1. 隐藏主窗口
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }

    // 2. 截取全屏（无延迟，主窗口隐藏后立即截取）
    const displays = screen.getAllDisplays();
    let maxWidth = 0, maxHeight = 0;
    for (const d of displays) {
      const w = d.size.width * d.scaleFactor;
      const h = d.size.height * d.scaleFactor;
      if (w > maxWidth) maxWidth = w;
      if (h > maxHeight) maxHeight = h;
    }
    maxWidth = Math.max(maxWidth, 1920);
    maxHeight = Math.max(maxHeight, 1080);

    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxWidth, height: maxHeight },
      });
    } catch (err) {
      console.error('[Screenshot] 截屏失败:', err);
      clearTimeout(timeout);
      hideOverlay();
      if (screenshotResolve) { screenshotResolve(null); screenshotResolve = null; }
      return;
    }
    capturedScreenshot = sources;

    const t1 = Date.now();
    console.log(`[Screenshot] 截屏完成: ${t1 - t0}ms`);

    // 3. 获取前台窗口信息（异步，不阻塞显示）
    let windowRect = null;

    // 4. 确保 overlay 窗口存在
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      precreateOverlayWindow();
      // 等待窗口加载完成
      await new Promise((r) => {
        if (overlayWindow.webContents.isLoading()) {
          overlayWindow.webContents.once('did-finish-load', r);
        } else {
          r();
        }
      });
    }

    // 5. 找到主屏幕对应的 source
    const primaryDisplay = screen.getPrimaryDisplay();
    let primarySource = sources[0];
    for (const s of sources) {
      if (String(s.display_id) === String(primaryDisplay.id)) {
        primarySource = s;
        break;
      }
    }

    // 6. 显示 overlay 并发送截图数据
    overlayWindow.show();
    overlayWindow.focus();

    // 发送截图数据到 overlay
    overlayWindow.webContents.send('screenshot:start', {
      dataUrl: primarySource.thumbnail.toDataURL(),
      windowRect,
      virtualBounds: calculateVirtualBounds(displays),
      primaryDisplay: {
        bounds: primaryDisplay.bounds,
        scaleFactor: primaryDisplay.scaleFactor,
      },
    });

    const t2 = Date.now();
    console.log(`[Screenshot] Overlay 显示完成: ${t2 - t0}ms (截屏${t1 - t0}ms + 显示${t2 - t1}ms)`);

    // 异步获取前台窗口（不阻塞截图流程）
    if (process.platform === 'win32') {
      try {
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
"@;
          $hwnd = [Win32]::GetForegroundWindow();
          $title = New-Object System.Text.StringBuilder 256;
          [Win32]::GetWindowText($hwnd, $title, 256) | Out-Null;
          $rect = New-Object Win32+RECT;
          [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null;
          $pidVal = [uint32]0;
          [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pidVal) | Out-Null;
          $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue;
          @{ title = $title.ToString(); processName = if ($proc) { $proc.ProcessName } else { "" }; rect = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom } } | ConvertTo-Json -Compress
        `;
        const output = execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
          timeout: 3000, encoding: 'utf8', windowsHide: true,
        });
        const winInfo = JSON.parse(output.trim());
        if (winInfo.processName && !winInfo.processName.toLowerCase().includes('electron')) {
          windowRect = winInfo.rect;
          // 异步更新 overlay 的高亮框
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('screenshot:update-window-rect', windowRect);
          }
          console.log(`[Screenshot] 前台窗口检测: ${Date.now() - t0}ms`);
        }
      } catch (err) {
        console.log('[Screenshot] 前台窗口检测失败（非关键）:', err.message);
      }
    }
  });
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
  ipcMain.handle('open-folder', async (_event, folderPath, storeKey) => {
    try {
      await shell.openPath(folderPath);
      const key = storeKey || 'recentFolders';
      const recent = store.get(key, []);
      const filtered = recent.filter((r) => r.path !== folderPath);
      filtered.unshift({ path: folderPath, timestamp: Date.now() });
      store.set(key, filtered.slice(0, 15));
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

  /** resize-window — 调整窗口宽度（右边缘固定，左边缘扩展） */
  ipcMain.handle('resize-window', (_event, newWidth) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const minW = 280;
    const maxW = 600;
    const w = Math.max(minW, Math.min(maxW, newWidth));
    // Dock 模式下：展开窗口并调整宽度
    if (!dockExpanded) expandDock('resize-window');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = primaryDisplay.size;
    const { x: bx, y: by } = primaryDisplay.bounds;
    const h = Math.round(sh * DOCK_HEIGHT_RATIO);
    mainWindow.setBounds({
      x: bx + sw - w,
      y: by + Math.round((sh - h) / 2),
      width: w,
      height: h,
    });
    return w;
  });

  /** get-window-width — 获取当前窗口宽度 */
  ipcMain.handle('get-window-width', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 350;
    return mainWindow.getSize()[0];
  });

  /** open-external — 在默认浏览器中打开外部链接 */
  ipcMain.handle('open-external', async (_event, url) => {
    try {
      await shell.openExternal(url);
    } catch (err) {
      console.error('[OpenExternal] 打开链接失败:', err);
    }
  });

  /** fetch-link-preview — 主进程抓取网页 OG 元数据（无 CORS 限制，3s 硬超时） */
  ipcMain.handle('fetch-link-preview', async (_event, url) => {
    // 检查缓存
    const cacheKey = require('crypto').createHash('md5').update(url).digest('hex');
    const cached = store.get(`linkCache.${cacheKey}`, null);
    if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
      return { ...cached, cached: true };
    }

    // 3秒硬超时保护
    const timeoutResult = { title: null, favicon: null, description: null, source: 'timeout', error: 'TIMEOUT' };
    try {
      const result = await Promise.race([
        fetchPage(url),
        new Promise((resolve) => setTimeout(() => resolve(timeoutResult), 3000)),
      ]);

      // 写入缓存
      if (result.title && !result.error) {
        const cacheEntry = { ...result, timestamp: Date.now() };
        store.set(`linkCache.${cacheKey}`, cacheEntry);
      }

      return result;
    } catch {
      return timeoutResult;
    }
  });

  /**
   * 抓取网页并解析 OG 元数据
   * 返回 { title, favicon, description, source, error? }
   */
  function fetchPage(url) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        req.destroy();
        resolve({ title: null, favicon: null, description: null, source: 'timeout', error: 'TIMEOUT' });
      }, 3000);

      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        timeout: 2000,
      }, (res) => {
        // 跟随重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timeout);
          res.destroy();
          const redirectUrl = new URL(res.headers.location, url).href;
          fetchPage(redirectUrl).then(resolve);
          return;
        }

        // 错误状态处理
        if (res.statusCode === 401 || res.statusCode === 403) {
          clearTimeout(timeout);
          res.destroy();
          resolve({ title: null, favicon: null, description: null, source: 'error', error: 'need_login' });
          return;
        }
        if (res.statusCode === 404) {
          clearTimeout(timeout);
          res.destroy();
          resolve({ title: null, favicon: null, description: null, source: 'error', error: 'not_found' });
          return;
        }
        if (res.statusCode !== 200) {
          clearTimeout(timeout);
          res.destroy();
          resolve({ title: null, favicon: null, description: null, source: 'error', error: `http_${res.statusCode}` });
          return;
        }

        let data = '';
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          data += chunk.toString();
          // 只读前 10KB，拿到 <head> 就够了
          if (received > 10240) {
            res.destroy();
          }
        });
        res.on('end', () => {
          clearTimeout(timeout);

          // 反爬检测：HTML 太短且含验证码关键词
          if (data.length < 500 && /验证|captcha|verify/i.test(data)) {
            resolve({ title: null, favicon: null, description: null, source: 'error', error: 'captcha' });
            return;
          }

          const meta = parseMeta(data, url);
          resolve(meta);
        });
        res.on('error', () => {
          clearTimeout(timeout);
          resolve({ title: null, favicon: null, description: null, source: 'error' });
        });
      });
      req.on('error', () => {
        clearTimeout(timeout);
        resolve({ title: null, favicon: null, description: null, source: 'error' });
      });
      req.on('timeout', () => {
        req.destroy();
        clearTimeout(timeout);
        resolve({ title: null, favicon: null, description: null, source: 'error' });
      });
    });
  }

  /** 解析 HTML 中的 OG 元标签 */
  function parseMeta(html, baseUrl) {
    // 优先级：og:title > twitter:title > <title>
    let title = null;

    const ogTitle = html.match(/<meta[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["']/i);
    if (ogTitle) {
      title = decodeHtml(ogTitle[1]);
    }

    if (!title) {
      const twitterTitle = html.match(/<meta[^>]*name\s*=\s*["']twitter:title["'][^>]*content\s*=\s*["']([^"']+)["']/i)
        || html.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']twitter:title["']/i);
      if (twitterTitle) {
        title = decodeHtml(twitterTitle[1]);
      }
    }

    if (!title) {
      const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleTag && titleTag[1].trim()) {
        title = decodeHtml(titleTag[1].trim());
      }
    }

    // og:image
    let favicon = null;
    const ogImage = html.match(/<meta[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i);
    if (ogImage) {
      favicon = ogImage[1];
    }

    // <link rel="icon">
    if (!favicon) {
      const linkIcon = html.match(/<link[^>]*rel\s*=\s*["'](?:shortcut )?icon["'][^>]*href\s*=\s*["']([^"']+)["']/i);
      if (linkIcon) {
        favicon = new URL(linkIcon[1], baseUrl).href;
      }
    }

    // og:description
    let description = null;
    const ogDesc = html.match(/<meta[^>]*property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:description["']/i);
    if (ogDesc) {
      description = decodeHtml(ogDesc[1]);
    }

    const source = title ? 'og-meta' : 'error';
    return { title, favicon, description, source };
  }

  /** 解码 HTML 实体 */
  function decodeHtml(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

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

  // ========== 截图 overlay IPC ==========

  /**
   * start-screenshot-overlay — 启动截图 overlay 流程
   * 返回裁剪后的 dataUrl，或抛出 'cancelled' 错误
   */
  ipcMain.handle('start-screenshot-overlay', async () => {
    const result = await startScreenshotOverlay();
    if (result === null) {
      throw new Error('cancelled');
    }
    return result;
  });

  /**
   * screenshot:crop — overlay 发送裁剪坐标
   * 在主进程中裁剪 NativeImage，返回 dataUrl
   */
  ipcMain.handle('screenshot:crop', async (_event, { x, y, width, height }) => {
    try {
      const source = capturedScreenshot?.[0];
      if (!source) throw new Error('No captured screenshot');

      // 获取对应显示器的 scaleFactor，将逻辑坐标转为像素坐标
      const displays = screen.getAllDisplays();
      const primaryDisplay = screen.getPrimaryDisplay();
      const sf = primaryDisplay.scaleFactor;

      // 裁剪坐标需减去显示器在虚拟屏幕中的偏移
      const cropX = Math.round((x - primaryDisplay.bounds.x) * sf);
      const cropY = Math.round((y - primaryDisplay.bounds.y) * sf);
      const cropW = Math.round(width * sf);
      const cropH = Math.round(height * sf);

      console.log(`[Screenshot] 裁剪: screen(${x},${y},${width},${height}) -> pixel(${cropX},${cropY},${cropW},${cropH}), sf=${sf}`);

      const cropped = source.thumbnail.crop({
        x: cropX, y: cropY, width: cropW, height: cropH,
      });
      const dataUrl = cropped.toDataURL();

      hideOverlay();
      capturedScreenshot = null;
      if (screenshotResolve) {
        screenshotResolve(dataUrl);
        screenshotResolve = null;
      }

      return { success: true, dataUrl };
    } catch (err) {
      console.error('[Screenshot] 裁剪失败:', err);
      hideOverlay();
      return { success: false, error: err.message };
    }
  });

  /**
   * screenshot:cancel — overlay 取消截图
   */
  ipcMain.handle('screenshot:cancel', () => {
    hideOverlay();
    capturedScreenshot = null;
    if (screenshotResolve) {
      screenshotResolve(null);
      screenshotResolve = null;
    }
    return { success: true };
  });

  // ========== Dock 控制 IPC ==========

  /** dock:pin — 锁定展开状态 */
  ipcMain.handle('dock:pin', () => {
    dockPinned = true;
    console.log('[Dock] 已锁定');
    return { success: true };
  });

  /** dock:unpin — 解锁，允许自动收起 */
  ipcMain.handle('dock:unpin', () => {
    dockPinned = false;
    console.log('[Dock] 已解锁');
    scheduleCollapse('用户解锁');
    return { success: true };
  });

  /** dock:toggle-pin — 切换锁定 */
  ipcMain.handle('dock:toggle-pin', () => {
    dockPinned = !dockPinned;
    console.log(`[Dock] 锁定状态: ${dockPinned}`);
    if (!dockPinned) scheduleCollapse('用户解锁');
    return { pinned: dockPinned };
  });

  /** dock:expand — 手动展开（外部调用，如截图完成后） */
  ipcMain.handle('dock:expand', (_event, delay) => {
    expandDock('外部请求');
    if (delay && delay > 0) {
      scheduleCollapse(`延时${delay}ms后收起`);
    }
    return { success: true };
  });

  /** dock:set-interacting — 渲染进程通知正在交互 */
  ipcMain.handle('dock:set-interacting', (_event, interacting) => {
    dockInteracting = interacting;
    if (interacting) {
      clearTimeout(dockHideTimer);
    } else {
      scheduleCollapse('交互结束');
    }
    return { success: true };
  });

  /** dock:get-state — 获取当前 Dock 状态 */
  ipcMain.handle('dock:get-state', () => {
    return { expanded: dockExpanded, pinned: dockPinned };
  });
}

app.whenReady().then(async () => {
  try {
    await initStore();
    registerIpcHandlers();
    createWindow();
    // 预创建截图 overlay 窗口（隐藏），点击时直接 show() 不需重新初始化
    precreateOverlayWindow();
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

// 应用退出时清理资源
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  destroyOverlay();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
