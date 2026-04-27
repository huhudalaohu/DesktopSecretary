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
 *   - get-front-windows    — 获取前台窗口信息（跨平台，平台抽象层分发）
 *   - register-shortcut    — 注册全局快捷键
 *   - unregister-shortcut  — 注销全局快捷键
 */

const { app, BrowserWindow, screen, ipcMain, shell, desktopCapturer, dialog, globalShortcut, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const platform = require('./main/platform');
const { initSync, getAuth, getEngine } = require('./main/sync');

// 开发模式下加载 .env 文件；生产环境 asar 中不含 dotenv，依赖系统环境变量或构建注入
try {
  require('dotenv').config();
} catch {
  // 生产环境静默跳过，process.env 直接使用系统环境变量
}

// ========== 腾讯云 CloudBase ==========
let tcbApp = null;
let tcbAuth = null;
const TCB_ENV_ID = process.env.TCB_ENV_ID || 'ds-dev-d9g28xlrgd2600837';
let TCB_SECRET_ID = process.env.TCB_SECRET_ID;
let TCB_SECRET_KEY = process.env.TCB_SECRET_KEY;

// 生产版本 fallback：从配置文件读取凭证（asar 打包后无 .env）
if (!TCB_SECRET_ID || !TCB_SECRET_KEY) {
  try {
    const configPath = path.join(__dirname, 'config', 'publish-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      TCB_SECRET_ID = config.secretId;
      TCB_SECRET_KEY = config.secretKey;
      console.log('[CloudBase] 使用配置文件凭证');
    }
  } catch (err) {
    console.warn('[CloudBase] 读取配置文件失败:', err.message);
  }
}

if (TCB_SECRET_ID && TCB_SECRET_KEY) {
  try {
    const cloudbase = require('@cloudbase/node-sdk');
    tcbApp = cloudbase.init({
      env: TCB_ENV_ID,
      secretId: TCB_SECRET_ID,
      secretKey: TCB_SECRET_KEY,
    });
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

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173';
const DEV_SERVER_WAIT_MS = 15000;

// 公开更新 API（无需 SecretKey，客户端直接 fetch）
// 优先读取环境变量（开发模式），fallback 到硬编码的 COS 地址（生产环境开箱即用）
const UPDATE_API_URL = process.env.UPDATE_API_URL || 'https://ds-update-1420931574.cos.ap-guangzhou.myqcloud.com/update.json';

// electron-store 使用 dynamic import（v8+ 为 ESM-only）
let Store;
let store;

// 主窗口引用
let mainWindow = null;

// 截图 overlay 窗口池（每块显示器一个，解决多屏 + 跨 DPI 的渲染问题）
// key: String(display.id)，value: BrowserWindow
const overlayWindows = new Map();
let screenshotResolve = null;  // Promise resolve 函数，等待用户操作后回调
let screenshotTimeout = null;  // 截图流程超时定时器
let capturedScreenshot = null; // 平台抽象层返回的 CaptureSource[]，用于裁剪
let overlayActive = false;     // 当前是否处于截图选区阶段

// ========== QQ 式 Dock 自动隐藏 ==========
const DOCK_EDGE_WIDTH = 3;        // 贴边时露出的细边宽度(px)
const DOCK_EXPANDED_WIDTH = 350;  // 展开时的默认宽度(px)
const DOCK_HEIGHT_RATIO = 0.85;   // 高度占屏幕比例
const DOCK_HOT_ZONE_WIDTH = 8;    // 触发热区宽度(px)
const DOCK_EXPAND_DELAY = 800;    // 鼠标贴边到展开的延迟(ms) — 防误触
const DOCK_GRACE_PERIOD = 3000;   // 展开后的宽限期(ms)，期间不检测离开
const DOCK_SNAP_THRESHOLD = 20;   // 拖动释放时离边缘 ≤ 此距离则吸附(px)
const DOCK_MOVE_THROTTLE = 30;    // 拖动 move 事件节流(ms)
const DOCK_MIN_WIDTH = 280;
const DOCK_MAX_WIDTH = 520;
const DOCK_MIN_HEIGHT = 400;
const DOCK_RATIO_MIN = 1.2;       // 浮空态 height/width 最小比
const DOCK_RATIO_MAX = 4.0;       // 浮空态 height/width 最大比

let dockExpanded = false;
let dockPinned = false;
let dockHideTimer = null;         // 预留（当前不使用延迟收起）
let dockGraceTimer = null;
let dockMouseTimer = null;
let dockExpandTimer = null;       // 贴边展开延迟定时器（800ms）
let dockInteracting = false;      // 保留以兼容 IPC，不再参与收起判定
let dockExpandedWidth = DOCK_EXPANDED_WIDTH;
let dockedEdge = 'right';         // 'left' | 'right' | 'top' | null(浮空)
let dockBounds = null;            // 浮空时的 {x,y,width,height}
let dockEdgeOffset = null;        // 吸附后沿边位置: left/right 为 {y,height}；top 为 {x,width}
let dockMoveThrottleTimer = null; // move 事件节流句柄
let dockResizeThrottleTimer = null;
let lastSnapHintEdge = undefined; // 防止重复推送 snap-hint
let suppressMoveHint = false;     // 编程性 setBounds 期间屏蔽蓝光推送
let suppressMoveHintTimer = null;
let moveEndDebounceTimer = null;  // macOS 上检测拖动结束（moved 事件不可靠）
let lastHandleWindowMovedTime = 0; // 防止 moved / debounce 重复执行

// 当前注册的快捷键
let registeredShortcut = null;
let registeredPinShortcut = null;

// 提醒通知轮询定时器
let reminderCheckInterval = null;
const REMINDER_CHECK_MS = 60 * 1000; // 每分钟检查一次
const REMINDER_COOLDOWN_MS = 5 * 60 * 1000; // 同一待办 5 分钟内不重复提醒

// fetchRenderedTitle 并发锁，防止同时创建多个 offscreen 窗口
let renderedTitleLock = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 检查待办提醒：每分钟轮询一次，找到到期的未触发提醒并弹出对话框
 */
function checkReminders() {
  if (!store || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const todos = store.get('todosGlobal', []);
    if (!Array.isArray(todos) || todos.length === 0) return;
    const now = Date.now();
    const dueTodos = todos.filter(
      (t) => !t.done && t.reminderTime && t.reminderTime <= now && !t.reminderTriggered
    );
    if (dueTodos.length === 0) return;
    // 只提醒第一个，避免同时弹出多个对话框
    const todo = dueTodos[0];
    // 标记已触发并保存
    const updated = todos.map((t) =>
      t.id === todo.id ? { ...t, reminderTriggered: true } : t
    );
    store.set('todosGlobal', updated);
    // 通知前端刷新
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('reminder:triggered', { todoId: todo.id });
    }
    // 弹出系统通知（优先使用系统通知，降级到对话框）
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: '待办提醒',
        body: todo.text || '有待办事项到期',
        silent: false,
      });
      notif.show();
    } else {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '待办提醒',
        message: '待办事项到期',
        detail: todo.text || '',
        buttons: ['知道了'],
      });
    }
  } catch (err) {
    console.error('[Reminder] 检查提醒失败:', err.message);
  }
}

function startReminderPolling() {
  if (reminderCheckInterval) clearInterval(reminderCheckInterval);
  checkReminders(); // 启动时立即检查一次
  reminderCheckInterval = setInterval(checkReminders, REMINDER_CHECK_MS);
  console.log('[Reminder] 提醒轮询已启动，间隔', REMINDER_CHECK_MS, 'ms');
}

function getRendererUrl(routePath = '/') {
  return new URL(routePath, `${DEV_SERVER_URL}/`).toString();
}

function canReachUrl(targetUrl) {
  return new Promise((resolve) => {
    const client = targetUrl.startsWith('https:') ? https : http;
    let settled = false;
    const request = client.get(targetUrl, (response) => {
      response.resume();
      if (!settled) {
        settled = true;
        resolve((response.statusCode || 0) < 500);
      }
    });

    request.on('error', () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });

    request.setTimeout(2000, () => {
      request.destroy();
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
  });
}

async function waitForDevServer(targetUrl, timeoutMs = DEV_SERVER_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await canReachUrl(targetUrl)) {
      return true;
    }
    await sleep(300);
  }

  return false;
}

async function loadRendererWindow(browserWindow, routePath, fallbackFilePath) {
  if (!app.isPackaged) {
    const devEntryUrl = getRendererUrl(routePath);
    const serverReady = await waitForDevServer(DEV_SERVER_URL);

    if (serverReady) {
      console.log(`[Renderer] Loading dev server: ${devEntryUrl}`);
      await browserWindow.loadURL(devEntryUrl);
      return;
    }

    console.warn(`[Renderer] Dev server not ready after ${DEV_SERVER_WAIT_MS}ms, fallback to file.`);
  }

  console.log(`[Renderer] Loading file: ${fallbackFilePath}`);
  await browserWindow.loadFile(fallbackFilePath);
}

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
        shortcutKey: 'CmdOrCtrl+Shift+A',
      },
    },
  });
}

// ========== API Key 加密存储 ==========

let safeStorageAvailable = false;

/**
 * 初始化 safeStorage 可用性检测（在 app.whenReady 后调用）
 * 不仅依赖 isEncryptionAvailable()，还做一轮实际加解密测试，
 * 避免某些 macOS 环境（如未签名应用、钥匙串权限受限）下反复报错。
 */
function initSafeStorage() {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      safeStorageAvailable = false;
      console.warn('[SafeStorage] isEncryptionAvailable() 返回 false，使用明文存储');
      return;
    }
    const testData = 'test-' + Date.now();
    const encrypted = safeStorage.encryptString(testData);
    const decrypted = safeStorage.decryptString(encrypted);
    safeStorageAvailable = decrypted === testData;
    if (!safeStorageAvailable) {
      console.warn('[SafeStorage] 加解密测试不一致，使用明文存储');
    }
  } catch (err) {
    safeStorageAvailable = false;
    console.warn('[SafeStorage] 初始化测试失败，将使用明文存储:', err.message);
  }
}

/**
 * 加密 aiSettings 中的 apiKey（使用操作系统级加密，如 Windows DPAPI）
 * 加密后的数据以 base64 形式存入 apiKeyEncrypted，并删除明文 apiKey
 */
function encryptAiSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  if (!settings.apiKey) {
    // 没有明文 key，直接返回（可能已经是加密形态）
    return settings;
  }
  try {
    if (!safeStorageAvailable) {
      console.warn('[Encrypt] safeStorage 不可用，继续使用明文存储');
      return settings;
    }
    const encrypted = safeStorage.encryptString(settings.apiKey);
    const result = { ...settings };
    result.apiKeyEncrypted = encrypted.toString('base64');
    delete result.apiKey;
    return result;
  } catch (err) {
    console.error('[Encrypt] API Key 加密失败:', err);
    return settings;
  }
}

/**
 * 解密 aiSettings 中的 apiKey
 * 如果存在明文 apiKey（旧数据），直接返回并触发迁移
 */
function decryptAiSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  // 旧版兼容：存在明文 apiKey
  if (settings.apiKey) return settings;
  if (!settings.apiKeyEncrypted) return settings;
  try {
    if (!safeStorageAvailable) {
      console.warn('[Decrypt] safeStorage 不可用，无法解密 API Key');
      return settings;
    }
    const encrypted = Buffer.from(settings.apiKeyEncrypted, 'base64');
    const apiKey = safeStorage.decryptString(encrypted);
    const result = { ...settings };
    result.apiKey = apiKey;
    delete result.apiKeyEncrypted;
    return result;
  } catch (err) {
    console.error('[Decrypt] API Key 解密失败:', err);
    return settings;
  }
}

/**
 * 安全的 store 写入，自动对 aiSettings 中的 apiKey 加密
 */
function safeStoreSet(key, value) {
  if (key === 'aiSettings') {
    value = encryptAiSettings(value);
  }
  store.set(key, value);
}

/**
 * 将旧版明文 apiKey 迁移为加密存储
 */
async function migrateApiKeyEncryption() {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[Migrate] safeStorage 不可用，跳过加密迁移');
      return;
    }
    const settings = store.get('aiSettings', {});
    if (settings && settings.apiKey && settings.apiKey.length > 0 && !settings.apiKeyEncrypted) {
      const encrypted = safeStorage.encryptString(settings.apiKey);
      const migrated = { ...settings };
      migrated.apiKeyEncrypted = encrypted.toString('base64');
      delete migrated.apiKey;
      store.set('aiSettings', migrated);
      console.log('[Migrate] API Key 已迁移为操作系统级加密存储');
    }
  } catch (err) {
    console.error('[Migrate] API Key 加密迁移失败:', err);
  }
}

/**
 * 将窗口定位到 Dock 位置
 *   - dockedEdge 为 'left'|'right'|'top'：按边缘计算（expanded 决定露出宽/高）；
 *     沿边坐标从 dockEdgeOffset 读，首次为空时退回居中。
 *   - dockedEdge 为 null：浮空模式，直接用 dockBounds
 */
function positionDockWindow(expanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // 屏蔽 200ms 内的 snap-hint 推送（setBounds 会触发 move 事件）
  suppressMoveHint = true;
  if (suppressMoveHintTimer) clearTimeout(suppressMoveHintTimer);
  suppressMoveHintTimer = setTimeout(() => { suppressMoveHint = false; }, 200);

  if (dockedEdge === null) {
    if (dockBounds) {
      mainWindow.setBounds(dockBounds, false);
    }
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primaryDisplay.size;
  const { x: bx, y: by } = primaryDisplay.bounds;
  const defaultH = Math.round(sh * DOCK_HEIGHT_RATIO);

  let x, y, w, h;

  if (dockedEdge === 'right' || dockedEdge === 'left') {
    w = expanded ? dockExpandedWidth : DOCK_EDGE_WIDTH;
    h = dockEdgeOffset?.height ?? defaultH;
    h = Math.max(DOCK_MIN_HEIGHT, Math.min(sh, h));
    const defaultY = by + Math.round((sh - h) / 2);
    y = dockEdgeOffset?.y ?? defaultY;
    y = Math.max(by, Math.min(by + sh - h, y));
    x = dockedEdge === 'right' ? (bx + sw - w) : bx;
  } else if (dockedEdge === 'top') {
    const storedW = dockEdgeOffset?.width ?? dockExpandedWidth;
    w = Math.max(DOCK_MIN_WIDTH, Math.min(sw, storedW));
    if (expanded) {
      h = Math.max(DOCK_MIN_HEIGHT, Math.min(sh, dockEdgeOffset?.height ?? defaultH));
    } else {
      h = DOCK_EDGE_WIDTH;
    }
    const defaultX = bx + Math.round((sw - w) / 2);
    x = dockEdgeOffset?.x ?? defaultX;
    x = Math.max(bx, Math.min(bx + sw - w, x));
    y = by;
  }

  mainWindow.setBounds({ x, y, width: w, height: h }, true);
}

/**
 * 长宽比与最小/最大尺寸 clamp（浮空态 resize 用）
 */
function clampFloatingBounds(b) {
  let { x, y, width, height } = b;
  const screenH = screen.getPrimaryDisplay().workAreaSize.height;
  width = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, width));
  height = Math.max(DOCK_MIN_HEIGHT, Math.min(screenH, height));
  const ratio = height / width;
  if (ratio < DOCK_RATIO_MIN) height = Math.round(width * DOCK_RATIO_MIN);
  if (ratio > DOCK_RATIO_MAX) height = Math.round(width * DOCK_RATIO_MAX);
  return { x, y, width, height };
}

/**
 * 计算窗口与当前所在显示器三条边（上/左/右）的距离
 */
function getEdgeDistances(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const sb = display.bounds;
  return {
    display: sb,
    dLeft: bounds.x - sb.x,
    dRight: (sb.x + sb.width) - (bounds.x + bounds.width),
    dTop: bounds.y - sb.y,
  };
}

function pickSnapEdge(distances) {
  const { dLeft, dRight, dTop } = distances;
  const minD = Math.min(dLeft, dRight, dTop);
  if (minD > DOCK_SNAP_THRESHOLD) return null;
  if (minD === dLeft) return 'left';
  if (minD === dRight) return 'right';
  return 'top';
}

/**
 * 展开 Dock
 */
function expandDock(reason) {
  if (dockExpandTimer) { clearTimeout(dockExpandTimer); dockExpandTimer = null; }
  if (dockExpanded) return;
  console.log(`[Dock] 展开 (${reason})`);
  dockExpanded = true;
  clearTimeout(dockHideTimer); dockHideTimer = null;
  clearTimeout(dockGraceTimer);

  mainWindow.setIgnoreMouseEvents(false);
  positionDockWindow(true);
  mainWindow.show();
  console.log('[Window] shown, bounds=', mainWindow.getBounds(), 'dockedEdge=', dockedEdge, 'dockExpanded=', dockExpanded);
  mainWindow.focus();

  dockGraceTimer = setTimeout(() => { dockGraceTimer = null; }, DOCK_GRACE_PERIOD);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dock:state-changed', { expanded: true, pinned: dockPinned });
  }
}

/**
 * 收起 Dock（同步）
 *   - 钉起状态不收起
 *   - 浮空模式不收起（常驻展开）
 */
function collapseDock(reason) {
  if (dockExpandTimer) { clearTimeout(dockExpandTimer); dockExpandTimer = null; }
  if (!dockExpanded) return;
  if (dockPinned) return;
  if (dockedEdge === null) return;
  console.log(`[Dock] 收起 (${reason})`);
  dockExpanded = false;
  clearTimeout(dockHideTimer); dockHideTimer = null;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dock:state-changed', { expanded: false, pinned: dockPinned });
  }

  // 延迟缩小窗口，让渲染侧先切样式，避免视觉抖
  setTimeout(() => {
    if (!dockExpanded && mainWindow && !mainWindow.isDestroyed()) {
      positionDockWindow(false);
    }
  }, 250);
}

/**
 * 延迟展开（鼠标贴边 0.8s 后展开，防误触）
 */
function scheduleExpand(reason) {
  if (dockExpandTimer) return;
  if (dockExpanded) return;
  if (dockedEdge === null || dockPinned) return;
  dockExpandTimer = setTimeout(() => {
    dockExpandTimer = null;
    expandDock(reason);
  }, DOCK_EXPAND_DELAY);
}

/**
 * 鼠标位置检测循环（主进程轮询）
 *   - 浮空或钉起：清定时器，不判定
 *   - 贴边吸附：鼠标进入热区延迟展开；鼠标离开窗口立即收起
 */
function startDockMouseTracking() {
  dockMouseTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // 浮空或钉起：清定时器，跳过判定
    if (dockedEdge === null || dockPinned) {
      if (dockExpandTimer) { clearTimeout(dockExpandTimer); dockExpandTimer = null; }
      if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();

    // 未展开：外扩 HOT_ZONE 缓冲，判定是否贴近
    const inHotZone = !dockExpanded && (
      cursor.x >= bounds.x - DOCK_HOT_ZONE_WIDTH &&
      cursor.x <= bounds.x + bounds.width + DOCK_HOT_ZONE_WIDTH &&
      cursor.y >= bounds.y - DOCK_HOT_ZONE_WIDTH &&
      cursor.y <= bounds.y + bounds.height + DOCK_HOT_ZONE_WIDTH
    );

    // 已展开：严格在窗口内（不外扩，离开即收起）
    const inExpandedWindow = dockExpanded && (
      cursor.x >= bounds.x &&
      cursor.x <= bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y <= bounds.y + bounds.height
    );

    const inZone = inHotZone || inExpandedWindow;

    if (inZone) {
      if (dockExpanded) {
        // 已展开：清 expand timer（虽然通常此时不会有）
        if (dockExpandTimer) { clearTimeout(dockExpandTimer); dockExpandTimer = null; }
      } else {
        // 鼠标贴边：启动 0.8s 延迟展开
        scheduleExpand('贴边 0.8s');
      }
    } else {
      // 离开区域
      if (dockExpandTimer) { clearTimeout(dockExpandTimer); dockExpandTimer = null; }
      if (dockExpanded && !dockGraceTimer) {
        collapseDock('鼠标离开');
      }
    }
  }, 80);
}

/**
 * 创建主窗口（Dock 模式）
 */
async function createWindow() {
  const savedPct = store.get('windowWidthPercent', 20);
  const screenW = screen.getPrimaryDisplay().size.width;
  dockExpandedWidth = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, Math.round(screenW * savedPct / 100)));

  // 读 dockedEdge + dockBounds；兼容旧 dockPosition
  const savedEdge = store.get('dockedEdge', undefined);
  if (savedEdge === undefined) {
    const legacy = store.get('dockPosition', null);
    if (legacy === 'right' || legacy === 'top-right') dockedEdge = 'right';
    else if (legacy === 'left' || legacy === 'top-left') dockedEdge = 'left';
    else dockedEdge = 'right';
    store.set('dockedEdge', dockedEdge);
    try { store.delete('dockPosition'); } catch {}
  } else {
    const valid = ['left', 'right', 'top'];
    if (savedEdge === null) dockedEdge = null;
    else dockedEdge = valid.includes(savedEdge) ? savedEdge : 'right';
  }

  dockBounds = store.get('dockBounds', null);
  dockEdgeOffset = store.get('dockEdgeOffset', null);

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primaryDisplay.size;
  const { x: bx, y: by } = primaryDisplay.bounds;
  const defaultH = Math.round(sh * DOCK_HEIGHT_RATIO);

  // 启动默认为展开状态（app.whenReady 里会 pin + expandDock）
  let initialX, initialY, initialW, initialH;
  if (dockedEdge === null && dockBounds) {
    ({ x: initialX, y: initialY, width: initialW, height: initialH } = dockBounds);
  } else if (dockedEdge === 'left' || dockedEdge === 'right') {
    initialW = dockExpandedWidth;
    initialH = dockEdgeOffset?.height ?? defaultH;
    initialH = Math.max(DOCK_MIN_HEIGHT, Math.min(sh, initialH));
    const centerY = by + Math.round((sh - initialH) / 2);
    initialY = dockEdgeOffset?.y ?? centerY;
    initialY = Math.max(by, Math.min(by + sh - initialH, initialY));
    initialX = dockedEdge === 'left' ? bx : (bx + sw - initialW);
  } else if (dockedEdge === 'top') {
    const storedW = dockEdgeOffset?.width ?? dockExpandedWidth;
    initialW = Math.max(DOCK_MIN_WIDTH, Math.min(sw, storedW));
    initialH = defaultH;
    const centerX = bx + Math.round((sw - initialW) / 2);
    initialX = dockEdgeOffset?.x ?? centerX;
    initialX = Math.max(bx, Math.min(bx + sw - initialW, initialX));
    initialY = by;
  } else {
    // 浮空但无 bounds：默认右侧
    dockedEdge = 'right';
    initialW = dockExpandedWidth;
    initialH = defaultH;
    initialX = bx + sw - initialW;
    initialY = by + Math.round((sh - initialH) / 2);
  }

  mainWindow = new BrowserWindow(platform.windowOptions.mainWindowOptions({
    x: initialX,
    y: initialY,
    width: initialW,
    height: initialH,
    minWidth: DOCK_MIN_WIDTH,
    minHeight: DOCK_MIN_HEIGHT,
    resizable: dockedEdge === null,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }));
  platform.windowOptions.applyMainWindowPlatformSetup(mainWindow);
  console.log('[Window] created, initialBounds=', { x: initialX, y: initialY, width: initialW, height: initialH }, 'dockedEdge=', dockedEdge);

  // 开发模式加载 Vite dev server（支持热更新），生产模式加载 build 产物
  const indexFile = path.join(__dirname, 'dist', 'index.html');
  loadRendererWindow(mainWindow, '/', indexFile).catch((err) => {
    console.error('Failed to load window content:', err);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Window loaded successfully');
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('Window failed to load:', code, desc);
  });

  // 拖动过程：节流 move，推送 snap-hint
  mainWindow.on('move', () => {
    if (dockMoveThrottleTimer) return;
    dockMoveThrottleTimer = setTimeout(() => {
      dockMoveThrottleTimer = null;
      handleWindowMove();

      // macOS 上 frame:false + -webkit-app-region:drag 不会触发 moved 事件，
      // 用 debounce 检测拖动结束（150ms 无新 move 即认为停下了）
      if (process.platform === 'darwin') {
        clearTimeout(moveEndDebounceTimer);
        moveEndDebounceTimer = setTimeout(() => {
          if (Date.now() - lastHandleWindowMovedTime < 300) return;
          handleWindowMoved();
        }, 150);
      }
    }, DOCK_MOVE_THROTTLE);
  });

  // 拖动结束：边缘吸附判定（macOS 上 moved 事件对 frameless 窗口不可靠，跳过）
  mainWindow.on('moved', () => {
    if (process.platform === 'darwin') return;
    if (Date.now() - lastHandleWindowMovedTime < 300) return;
    handleWindowMoved();
  });

  // Resize：仅浮空态允许，clamp 长宽比与最大最小
  mainWindow.on('will-resize', (event, newBounds) => {
    if (dockedEdge !== null) {
      event.preventDefault();
      return;
    }
    const clamped = clampFloatingBounds(newBounds);
    if (clamped.width !== newBounds.width || clamped.height !== newBounds.height) {
      event.preventDefault();
      mainWindow.setBounds(clamped);
    }
  });

  mainWindow.on('resize', () => {
    if (dockedEdge !== null) return;
    if (dockResizeThrottleTimer) return;
    dockResizeThrottleTimer = setTimeout(() => {
      dockResizeThrottleTimer = null;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const b = mainWindow.getBounds();
      dockBounds = b;
      store.set('dockBounds', b);
    }, 200);
  });

  mainWindow.on('closed', () => {
    clearInterval(dockMouseTimer);
    clearTimeout(dockHideTimer);
    clearTimeout(dockGraceTimer);
    clearTimeout(dockExpandTimer);
    clearTimeout(dockMoveThrottleTimer);
    clearTimeout(dockResizeThrottleTimer);
    console.log('Window closed');
    mainWindow = null;
  });

  startDockMouseTracking();
}

/**
 * 拖动中：节流计算 snap-hint，推送给渲染侧显示发光边
 *   - 编程性 setBounds 期间（suppressMoveHint）或吸附状态下不推 hint，
 *     以免吸附动作完成后蓝光闪回。
 */
function handleWindowMove() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;

  if (suppressMoveHint || dockedEdge !== null) {
    if (lastSnapHintEdge !== undefined && lastSnapHintEdge !== null) {
      lastSnapHintEdge = null;
      mainWindow.webContents.send('dock:snap-hint', { edge: null });
    }
    return;
  }

  const b = mainWindow.getBounds();
  const d = getEdgeDistances(b);
  const hintEdge = pickSnapEdge(d);

  if (hintEdge !== lastSnapHintEdge) {
    lastSnapHintEdge = hintEdge;
    mainWindow.webContents.send('dock:snap-hint', { edge: hintEdge });
  }
}

/**
 * 拖动结束：若近边缘则吸附；否则进入浮空模式
 */
function handleWindowMoved() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getBounds();
  const d = getEdgeDistances(b);
  const targetEdge = pickSnapEdge(d);

  // 清 snap-hint
  lastSnapHintEdge = undefined;
  mainWindow.webContents.send('dock:snap-hint', { edge: null });

  if (targetEdge !== null) {
    // 吸附到边缘，保留拖动终点沿边位置
    dockedEdge = targetEdge;
    if (targetEdge === 'right' || targetEdge === 'left') {
      dockEdgeOffset = { y: b.y, height: b.height };
      // 保留用户调整后的窗口宽度，避免吸附后宽度被重置
      dockExpandedWidth = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, b.width));
      store.set('windowWidthPercent', Math.round((dockExpandedWidth / screen.getPrimaryDisplay().size.width) * 100));
    } else {
      dockEdgeOffset = { x: b.x, width: b.width, height: b.height };
    }
    store.set('dockedEdge', targetEdge);
    store.set('dockEdgeOffset', dockEdgeOffset);
    mainWindow.setResizable(false);
    dockExpanded = true;
    positionDockWindow(true);
    mainWindow.webContents.send('dock:edge-changed', { dockedEdge, dockBounds: null });
    mainWindow.webContents.send('dock:state-changed', { expanded: true, pinned: dockPinned });
  } else {
    // 浮空模式
    dockedEdge = null;
    dockBounds = b;
    store.set('dockedEdge', null);
    store.set('dockBounds', b);
    mainWindow.setResizable(true);
    dockExpanded = true; // 浮空常驻展开
    if (dockExpandTimer) { clearTimeout(dockExpandTimer); dockExpandTimer = null; }
    if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }
    mainWindow.webContents.send('dock:edge-changed', { dockedEdge: null, dockBounds: b });
    mainWindow.webContents.send('dock:state-changed', { expanded: true, pinned: dockPinned });
  }
}

/**
 * 计算所有显示器合并后的虚拟屏幕边界（保留：当前用于调试日志）
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
 * 创建一个 overlay 窗口，覆盖指定 display 的 bounds
 */
async function createOverlayForDisplay(display) {
  const win = new BrowserWindow(platform.windowOptions.overlayWindowOptions({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--display-id=${display.id}`],
    },
  }));
  platform.windowOptions.applyOverlayPlatformSetup(win);

  const overlayFile = path.join(__dirname, 'dist', 'screenshot-overlay.html');
  try {
    // 开发模式下优先从 Vite dev server 加载，避免 dist 目录不存在或过时
    if (!app.isPackaged) {
      const devOverlayUrl = `${DEV_SERVER_URL}/screenshot-overlay.html`;
      const serverReady = await canReachUrl(devOverlayUrl);
      if (serverReady) {
        await win.loadURL(devOverlayUrl);
      } else {
        await win.loadFile(overlayFile);
      }
    } else {
      await win.loadFile(overlayFile);
    }
  } catch (err) {
    console.error(`[Screenshot] overlay[${display.id}] 加载失败:`, err);
    throw err;
  }

  await new Promise((resolve) => {
    if (win.isDestroyed()) { resolve(); return; }
    const timer = setTimeout(resolve, 800);
    win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    win.webContents.once('dom-ready', () => { clearTimeout(timer); resolve(); });
    win.webContents.once('did-fail-load', () => { clearTimeout(timer); resolve(); });
  });

  const displayId = String(display.id);
  win.on('closed', () => {
    overlayWindows.delete(displayId);
  });

  overlayWindows.set(displayId, win);
  console.log(`[Screenshot] overlay[${displayId}] 预创建完成 bounds=${display.bounds.x},${display.bounds.y} ${display.bounds.width}x${display.bounds.height}`);
  return win;
}

/**
 * 确保每块显示器都有 overlay；新插入的显示器会补建，移除的则销毁
 */
async function ensureOverlayReady() {
  const displays = screen.getAllDisplays();
  const wanted = new Set(displays.map((d) => String(d.id)));

  // 销毁已拔掉的显示器对应的 overlay
  for (const [id, win] of overlayWindows) {
    if (!wanted.has(id)) {
      try { if (!win.isDestroyed()) win.destroy(); } catch {}
      overlayWindows.delete(id);
      console.log(`[Screenshot] overlay[${id}] 已移除（显示器拔出）`);
    }
  }

  // 为每个显示器补建 overlay
  const creations = [];
  for (const d of displays) {
    const id = String(d.id);
    const existing = overlayWindows.get(id);
    if (existing && !existing.isDestroyed()) {
      // 同步一下 bounds（metrics 变了之后）
      try {
        existing.setBounds({
          x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
        });
      } catch {}
      continue;
    }
    if (existing) overlayWindows.delete(id);
    creations.push(createOverlayForDisplay(d));
  }
  if (creations.length > 0) {
    await Promise.all(creations);
  }
}

/**
 * 显示器热插拔事件，重建 overlay 池
 */
function attachDisplayChangeListeners() {
  const rebuild = () => {
    ensureOverlayReady().catch((err) => {
      console.error('[Screenshot] overlay 池重建失败:', err);
    });
  };
  screen.on('display-added', rebuild);
  screen.on('display-removed', rebuild);
  screen.on('display-metrics-changed', rebuild);
}

/**
 * 隐藏所有 overlay 并恢复主窗口
 */
function hideOverlay() {
  overlayActive = false;
  for (const win of overlayWindows.values()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send('screenshot:reset'); } catch {}
    try { win.hide(); } catch {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log('[Window] show() from hideOverlay');
    mainWindow.show();
    mainWindow.focus();
  }
}

/**
 * 销毁全部 overlay（仅应用退出时调用）
 */
function destroyOverlay() {
  for (const win of overlayWindows.values()) {
    try {
      if (!win.isDestroyed()) {
        win.removeAllListeners('closed');
        win.destroy();
      }
    } catch {}
  }
  overlayWindows.clear();
}

/**
 * 启动截图 overlay 流程
 * 返回 Promise<dataUrl | null>，null 表示用户取消
 *
 * 流程优化：
 *   1. 先截屏、发送数据到 overlay
 *   2. 等待 overlay 确认新图片加载完毕（screenshot:ready 握手）
 *   3. 再显示 overlay 窗口 → 避免闪烁旧截图
 *   4. 前台窗口检测用异步 exec → 不阻塞主进程事件循环
 */
function startScreenshotOverlay() {
  return new Promise(async (resolve) => {
    const t0 = Date.now();
    screenshotResolve = resolve;

    // 清理上一次残留数据
    capturedScreenshot = null;
    if (screenshotTimeout) {
      clearTimeout(screenshotTimeout);
      screenshotTimeout = null;
    }

    // 120 秒超时保护（给用户足够时间选区）
    screenshotTimeout = setTimeout(() => {
      console.log('[Screenshot] overlay 超时，自动取消');
      hideOverlay();
      capturedScreenshot = null;
      screenshotTimeout = null;
      if (screenshotResolve) {
        screenshotResolve(null);
        screenshotResolve = null;
      }
    }, 120000);

    // 1. 隐藏主窗口 + 保证每块屏的 overlay 都就绪（复用预创建 + 热插拔补建）
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 清除可能触发 expandDock/show 的定时器，防止 hide 后窗口又被 show 出来
      if (dockExpandTimer) { clearTimeout(dockExpandTimer); dockExpandTimer = null; }
      if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }

      console.log('[Window] hide triggered at:', new Error().stack);
      mainWindow.hide();

      // Windows DWM 有 compositing 延迟，hide() 后窗口不会立即从屏幕上消失。
      // 等待 ~100ms 确保窗口完全不可见后再继续，避免偶发性截到自身窗口。
      await sleep(100);
    }

    try {
      await ensureOverlayReady();
    } catch (err) {
      console.error('[Screenshot] overlay 就绪失败:', err);
      if (screenshotTimeout) { clearTimeout(screenshotTimeout); screenshotTimeout = null; }
      if (screenshotResolve) { screenshotResolve(null); screenshotResolve = null; }
      return;
    }

    const displays = screen.getAllDisplays();

    // 2. 截屏（走平台抽象层，返回所有屏的 CaptureSource[]）
    let sources;
    try {
      sources = await platform.screenCapture.captureAllScreens();
      capturedScreenshot = sources;
      console.log(`[Screenshot] 截屏成功, 源数量=${sources.length}`);
    } catch (err) {
      console.error('[Screenshot] 截屏失败:', err);
      if (screenshotTimeout) { clearTimeout(screenshotTimeout); screenshotTimeout = null; }
      hideOverlay();
      if (screenshotResolve) { screenshotResolve(null); screenshotResolve = null; }
      return;
    }

    const t1 = Date.now();
    console.log(`[Screenshot] 截屏+窗口准备完成: ${t1 - t0}ms`);

    // 3. 清空 ready 监听，准备收集每块屏的 ready 信号
    ipcMain.removeAllListeners('screenshot:ready');

    // 4. 每块屏推一张 PNG Buffer 到对应 overlay
    const pendingOverlays = [];
    for (const display of displays) {
      const displayId = String(display.id);
      const win = overlayWindows.get(displayId);
      if (!win || win.isDestroyed()) {
        console.warn(`[Screenshot] display ${displayId} 缺少 overlay，跳过`);
        continue;
      }

      // 找到对应 display 的 capture source
      let source = sources.find((s) => s.displayId === displayId);
      if (!source) {
        // 回退：按 bounds 左上角匹配
        source = sources.find((s) =>
          Math.abs(s.bounds.x - display.bounds.x) <= 2 &&
          Math.abs(s.bounds.y - display.bounds.y) <= 2
        );
      }
      if (!source) {
        console.warn(`[Screenshot] display ${displayId} 没有匹配到截图源，跳过`);
        continue;
      }

      const tBuf0 = Date.now();
      const buffer = source.toBuffer('png');
      const tBuf1 = Date.now();
      console.log(`[Screenshot] display[${displayId}] PNG ${tBuf1 - tBuf0}ms, ${Math.round(buffer.length / 1024)}KB, engine=${source.engine}`);

      win.webContents.send('screenshot:start', {
        buffer,
        mime: 'image/png',
        windowRect: null,
        // 对于 per-monitor overlay，虚拟边界就是自己这块屏的 bounds
        virtualBounds: {
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
        },
        primaryDisplay: {
          bounds: display.bounds,
          scaleFactor: display.scaleFactor,
        },
      });

      pendingOverlays.push(win);
    }

    if (pendingOverlays.length === 0) {
      console.error('[Screenshot] 没有任何 overlay 可用');
      if (screenshotTimeout) { clearTimeout(screenshotTimeout); screenshotTimeout = null; }
      hideOverlay();
      if (screenshotResolve) { screenshotResolve(null); screenshotResolve = null; }
      return;
    }

    // 5. 等待所有 overlay ready（图片加载完毕），500ms 兜底
    await new Promise((readyResolve) => {
      let remaining = pendingOverlays.length;
      const readyTimeout = setTimeout(() => {
        console.log(`[Screenshot] overlay ready 超时(剩 ${remaining})，强制显示`);
        ipcMain.removeListener('screenshot:ready', onReady);
        readyResolve();
      }, 500);
      const onReady = () => {
        remaining--;
        if (remaining <= 0) {
          clearTimeout(readyTimeout);
          ipcMain.removeListener('screenshot:ready', onReady);
          readyResolve();
        }
      };
      ipcMain.on('screenshot:ready', onReady);
    });

    // 6. 图片就绪，显示所有 overlay；焦点给光标所在那块屏
    overlayActive = true;
    const cursor = screen.getCursorScreenPoint();
    const cursorDisplay = screen.getDisplayNearestPoint(cursor);
    for (const win of pendingOverlays) {
      try { win.show(); } catch {}
    }
    const focusId = String(cursorDisplay.id);
    const focusWin = overlayWindows.get(focusId) || pendingOverlays[0];
    if (focusWin && !focusWin.isDestroyed()) {
      try { focusWin.focus(); } catch {}
    }

    const t2 = Date.now();
    console.log(`[Screenshot] Overlay 显示完成: ${t2 - t0}ms (截屏${t1 - t0}ms + 加载${t2 - t1}ms), overlays=${pendingOverlays.length}`);

    // 7. 异步获取前台窗口（仅推给该窗口所在 display 的 overlay）
    platform.windowInfo.getForegroundWindow().then((winInfo) => {
      if (!winInfo) return;
      if (!winInfo.processName || winInfo.processName.toLowerCase().includes('electron')) return;
      // 按窗口中心点定位所在显示器
      const cx = (winInfo.rect.left + winInfo.rect.right) / 2;
      const cy = (winInfo.rect.top + winInfo.rect.bottom) / 2;
      const targetDisplay = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
      const targetWin = overlayWindows.get(String(targetDisplay.id));
      if (targetWin && !targetWin.isDestroyed()) {
        targetWin.webContents.send('screenshot:update-window-rect', winInfo.rect);
        console.log(`[Screenshot] 前台窗口检测 → display ${targetDisplay.id}: ${Date.now() - t0}ms`);
      }
    }).catch((err) => {
      console.log('[Screenshot] 前台窗口检测失败（非关键）:', err.message);
    });
  });
}

// ========== IPC 处理器 ==========

/** 清理过期的 linkCache（网页元数据缓存，24h 过期） */
function cleanupLinkCache() {
  try {
    const now = Date.now();
    const allCache = store.get('linkCache', {});
    let removed = 0;
    for (const [key, entry] of Object.entries(allCache)) {
      if (now - entry.timestamp > 24 * 60 * 60 * 1000) {
        delete allCache[key];
        removed++;
      }
    }
    if (removed > 0) {
      store.set('linkCache', allCache);
      console.log(`[Cleanup] linkCache 清理完成，移除 ${removed} 条过期缓存`);
    }
  } catch (err) {
    console.error('[Cleanup] linkCache 清理失败:', err);
  }
}

function registerIpcHandlers() {
  /** store:get — 读取 electron-store 数据 */
  ipcMain.handle('store:get', (_event, key, defaultValue) => {
    const value = store.get(key, defaultValue);
    if (key === 'aiSettings') {
      return decryptAiSettings(value);
    }
    return value;
  });

  /** store:set — 写入 electron-store 数据 */
  ipcMain.handle('store:set', (_event, key, value) => {
    if (key === 'aiSettings') {
      value = encryptAiSettings(value);
    }
    store.set(key, value);
    // 触发自动同步（如果 key 在同步范围内）
    const engine = getEngine();
    if (engine) {
      engine.onStoreChanged(key);
    }
  });

  /** show-reminder — 弹出待办提醒对话框 */
  ipcMain.handle('show-reminder', async (_event, title, detail) => {
    if (!mainWindow) return;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '待办提醒',
      message: title || '待办事项到期',
      detail: detail || '',
      buttons: ['知道了'],
    });
    return result;
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
   * get-front-windows — 获取前台窗口信息
   * 走平台抽象层：Windows 使用 PowerShell；macOS 暂返回空（阶段 2 接入 get-windows）
   */
  ipcMain.handle('get-front-windows', async () => {
    try {
      const winInfo = await platform.windowInfo.getForegroundWindow();
      if (!winInfo) return [];

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
        // 使用 copyFile + unlink 替代 rename，支持跨磁盘/分区移动
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src);
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

  /** resize-window — 调整窗口宽度 */
  ipcMain.handle('resize-window', (_event, newWidth) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const minW = 280;
    const maxW = 600;
    const w = Math.max(minW, Math.min(maxW, newWidth));
    // 记住用户设置的展开宽度
    dockExpandedWidth = w;
    // 持久化到 store，重启后保持用户设置的宽度
    try {
      const screenW = screen.getPrimaryDisplay().size.width;
      store.set('windowWidthPercent', Math.round((w / screenW) * 100));
    } catch (err) {
      console.warn('[Resize] 保存宽度百分比失败:', err.message);
    }
    // Dock 模式下：若已展开则直接 reposition；若收起则先展开再定位
    if (!dockExpanded) expandDock('resize-window');
    else positionDockWindow(true);
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

      // 顺便清理过期缓存（概率触发，避免每次请求都全量扫描）
      if (Math.random() < 0.1) cleanupLinkCache();

      return result;
    } catch {
      return timeoutResult;
    }
  });

  /** fetch-rendered-title — Electron 隐藏窗口渲染后提取标题（对付 CSR / 反爬） */
  ipcMain.handle('fetch-rendered-title', async (_event, url) => {
    const cacheKey = require('crypto').createHash('md5').update(`render:${url}`).digest('hex');
    const cached = store.get(`linkCache.${cacheKey}`, null);
    if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
      return { ...cached, cached: true };
    }

    const result = await fetchRenderedTitle(url);
    if (result.title) {
      const cacheEntry = { ...result, timestamp: Date.now() };
      store.set(`linkCache.${cacheKey}`, cacheEntry);
    }
    return result;
  });

  /**
   * 抓取网页并解析 OG 元数据
   * 返回 { title, favicon, description, source, error? }
   */
  function fetchPage(url) {
    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : http;
      let req = null;
      const timeout = setTimeout(() => {
        if (req) req.destroy();
        resolve({ title: null, favicon: null, description: null, source: 'timeout', error: 'TIMEOUT' });
      }, 3000);

      req = mod.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
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
        let responseSettled = false;
        function safeResolve(value) {
          if (!responseSettled) {
            responseSettled = true;
            clearTimeout(timeout);
            resolve(value);
          }
        }
        res.on('data', (chunk) => {
          received += chunk.length;
          data += chunk.toString();
          // 只读前 10KB，拿到 <head> 就够了
          if (received > 10240) {
            // 先解析并 resolve，再 destroy；否则 end 事件不会触发导致 Promise 挂起
            safeResolve(parseMeta(data, url));
            res.destroy();
          }
        });
        res.on('end', () => {
          // 反爬检测：HTML 太短且含验证码关键词
          if (data.length < 500 && /验证|captcha|verify/i.test(data)) {
            safeResolve({ title: null, favicon: null, description: null, source: 'error', error: 'captcha' });
            return;
          }
          safeResolve(parseMeta(data, url));
        });
        res.on('error', () => {
          safeResolve({ title: null, favicon: null, description: null, source: 'error' });
        });
        res.on('close', () => {
          // 兜底：如果 data 事件里已 resolve，这里不会重复执行
          safeResolve(parseMeta(data, url));
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

  /** 解析 HTML 中的 OG 元标签（增强版：支持微信、知乎、掘金等特殊结构） */
  function parseMeta(html, baseUrl) {
    // 优先级：og:title > twitter:title > 特殊站点规则 > <title>
    let title = null;
    let source = 'og-meta';

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

    // 特殊站点规则（微信、知乎、掘金、CSDN 等）
    if (!title) {
      // 微信文章：rich_media_title / activity_name
      const wxTitle = html.match(/<h2[^>]*class\s*=\s*["'][^"]*rich_media_title["'][^>]*>([\s\S]*?)<\/h2>/i)
        || html.match(/<div[^>]*id\s*=\s*["']activity_name["'][^>]*>([\s\S]*?)<\/div>/i);
      if (wxTitle) {
        title = decodeHtml(wxTitle[1].replace(/<[^>]+>/g, '').trim());
        source = 'og-meta';
      }
      // 知乎：Post-Title / h1.Title
      if (!title) {
        const zhTitle = html.match(/<h1[^>]*class\s*=\s*["'][^"]*Post-Title["'][^>]*>([\s\S]*?)<\/h1>/i)
          || html.match(/<h1[^>]*class\s*=\s*["'][^"]*Title["'][^>]*>([\s\S]*?)<\/h1>/i);
        if (zhTitle) {
          title = decodeHtml(zhTitle[1].replace(/<[^>]+>/g, '').trim());
          source = 'og-meta';
        }
      }
      // 掘金：article-title
      if (!title) {
        const jjTitle = html.match(/<h1[^>]*class\s*=\s*["'][^"]*article-title["'][^>]*>([\s\S]*?)<\/h1>/i);
        if (jjTitle) {
          title = decodeHtml(jjTitle[1].replace(/<[^>]+>/g, '').trim());
          source = 'og-meta';
        }
      }
      // CSDN：title / article-title
      if (!title) {
        const csdnTitle = html.match(/<h1[^>]*class\s*=\s*["'][^"]*title-article["'][^>]*>([\s\S]*?)<\/h1>/i)
          || html.match(/<span[^>]*class\s*=\s*["'][^"]*article-title["'][^>]*>([\s\S]*?)<\/span>/i);
        if (csdnTitle) {
          title = decodeHtml(csdnTitle[1].replace(/<[^>]+>/g, '').trim());
          source = 'og-meta';
        }
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

    if (!title) source = 'error';
    return { title, favicon, description, source };
  }

  /**
   * 用 Electron 隐藏窗口渲染页面后提取标题（对付 CSR / 反爬站点）
   * 流程：创建 offscreen BrowserWindow → loadURL → 等待 JS 执行 → executeJavaScript 提取标题
   */
  async function fetchRenderedTitle(targetUrl) {
    // 并发锁：如果已有实例在执行，等待后重试（利用缓存降低重试频率）
    if (renderedTitleLock) {
      await sleep(500);
      return fetchRenderedTitle(targetUrl);
    }
    renderedTitleLock = true;
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 720,
        webPreferences: {
          offscreen: true,
          nodeIntegration: false,
          contextIsolation: true,
          javascript: true,
        },
      });

      const cleanup = (result) => {
        clearTimeout(timeout);
        try { win.destroy(); } catch {}
        renderedTitleLock = false;
        resolve(result);
      };

      const timeout = setTimeout(() => {
        cleanup({ title: null, favicon: null, source: 'error' });
      }, 8000);

      win.webContents.on('did-finish-load', async () => {
        // 再等 1.5s 让 SPA 完成 JS 渲染
        await sleep(1500);
        try {
          const result = await win.webContents.executeJavaScript(`
            (() => {
              const og = document.querySelector('meta[property="og:title"]');
              if (og && og.content) return { title: og.content.trim(), favicon: null };
              const tw = document.querySelector('meta[name="twitter:title"]');
              if (tw && tw.content) return { title: tw.content.trim(), favicon: null };
              // 微信文章
              const wx = document.querySelector('#activity_name, .rich_media_title');
              if (wx) return { title: wx.textContent.trim(), favicon: null };
              // 知乎
              const zh = document.querySelector('.Post-Title, h1.Title');
              if (zh) return { title: zh.textContent.trim(), favicon: null };
              // 掘金
              const jj = document.querySelector('h1.article-title');
              if (jj) return { title: jj.textContent.trim(), favicon: null };
              return { title: document.title.trim(), favicon: null };
            })()
          `);
          if (result && result.title && result.title.length > 0 && result.title !== 'about:blank') {
            cleanup({ title: result.title, favicon: result.favicon, source: 'render' });
          } else {
            cleanup({ title: null, favicon: null, source: 'error' });
          }
        } catch {
          cleanup({ title: null, favicon: null, source: 'error' });
        }
      });

      win.webContents.on('did-fail-load', () => {
        clearTimeout(timeout);
        try { win.destroy(); } catch {}
        resolve({ title: null, favicon: null, source: 'error' });
      });

      win.loadURL(targetUrl, {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
    });
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
    const normalized = platform.shortcuts.normalizeShortcut(accelerator);

    try {
      const registered = globalShortcut.register(normalized, () => {
        // 快捷键触发时通知渲染进程
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('shortcut-triggered');
        }
      });
      if (registered) {
        registeredShortcut = normalized;
        console.log(`[Shortcut] 已注册: ${normalized}`);
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

  /**
   * register-pin-shortcut — 注册切换钉住状态的全局快捷键
   */
  ipcMain.handle('register-pin-shortcut', (_event, accelerator) => {
    if (registeredPinShortcut) {
      try { globalShortcut.unregister(registeredPinShortcut); } catch {}
      registeredPinShortcut = null;
    }
    if (!accelerator) return { success: true };
    const normalized = platform.shortcuts.normalizeShortcut(accelerator);
    try {
      const registered = globalShortcut.register(normalized, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pin-shortcut-triggered');
        }
      });
      if (registered) {
        registeredPinShortcut = normalized;
        console.log(`[PinShortcut] 已注册: ${normalized}`);
        return { success: true };
      } else {
        return { success: false, error: '快捷键注册失败，可能已被其他程序占用' };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** unregister-pin-shortcut — 注销钉住状态快捷键 */
  ipcMain.handle('unregister-pin-shortcut', () => {
    if (registeredPinShortcut) {
      try { globalShortcut.unregister(registeredPinShortcut); } catch {}
      console.log(`[PinShortcut] 已注销: ${registeredPinShortcut}`);
      registeredPinShortcut = null;
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
      if (!capturedScreenshot || capturedScreenshot.length === 0) {
        throw new Error('No captured screenshot');
      }

      // 找到裁剪矩形落在的显示器 —— 支持多屏
      const primaryDisplay = screen.getPrimaryDisplay();
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      let source = capturedScreenshot.find((s) => {
        const b = s.bounds;
        return centerX >= b.x && centerX < b.x + b.width && centerY >= b.y && centerY < b.y + b.height;
      });
      if (!source) {
        source = capturedScreenshot.find((s) => s.displayId === String(primaryDisplay.id))
              || capturedScreenshot[0];
      }

      const sf = source.scaleFactor;
      const cropX = Math.round((x - source.bounds.x) * sf);
      const cropY = Math.round((y - source.bounds.y) * sf);
      const cropW = Math.round(width * sf);
      const cropH = Math.round(height * sf);

      console.log(`[Screenshot] 裁剪[${source.engine}]: screen(${x},${y},${width},${height}) -> pixel(${cropX},${cropY},${cropW},${cropH}), sf=${sf}, display=${source.displayId}`);

      const cropped = source.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
      const dataUrl = cropped.toDataUrl();

      hideOverlay();
      capturedScreenshot = null;
      if (screenshotTimeout) {
        clearTimeout(screenshotTimeout);
        screenshotTimeout = null;
      }
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
    if (screenshotTimeout) {
      clearTimeout(screenshotTimeout);
      screenshotTimeout = null;
    }
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
    store.set('dockPinned', true);
    if (dockExpandTimer) { clearTimeout(dockExpandTimer); dockExpandTimer = null; }
    if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }
    if (!dockExpanded) expandDock('pin');
    console.log('[Dock] 已锁定');
    return { success: true };
  });

  /** dock:unpin — 解锁，允许自动收起（鼠标离开后自然收起） */
  ipcMain.handle('dock:unpin', () => {
    dockPinned = false;
    store.set('dockPinned', false);
    if (dockExpandTimer) { clearTimeout(dockExpandTimer); dockExpandTimer = null; }
    if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }
    dockInteracting = false;
    console.log('[Dock] 已解锁');
    return { success: true };
  });

  /** dock:toggle-pin — 切换锁定 */
  ipcMain.handle('dock:toggle-pin', () => {
    dockPinned = !dockPinned;
    store.set('dockPinned', dockPinned);
    if (dockExpandTimer) { clearTimeout(dockExpandTimer); dockExpandTimer = null; }
    if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }
    if (dockPinned) {
      if (!dockExpanded) expandDock('pin');
    } else {
      dockInteracting = false;
    }
    console.log(`[Dock] 锁定状态: ${dockPinned}`);
    return { pinned: dockPinned };
  });

  /** dock:expand — 手动展开（外部调用，如截图完成后） */
  ipcMain.handle('dock:expand', (_event, delay) => {
    expandDock('外部请求');
    if (delay && delay > 0) {
      setTimeout(() => {
        if (!dockPinned && dockedEdge !== null) {
          collapseDock(`延时${delay}ms 后收起`);
        }
      }, delay);
    }
    return { success: true };
  });

  /** dock:set-interacting — 兼容旧 API；收起判定已不依赖此状态 */
  ipcMain.handle('dock:set-interacting', (_event, interacting) => {
    dockInteracting = !!interacting;
    return { success: true };
  });

  /** dock:get-state — 获取当前 Dock 状态 */
  ipcMain.handle('dock:get-state', () => {
    return { expanded: dockExpanded, pinned: dockPinned, dockedEdge, dockBounds };
  });

  /** dock:get-edge — 获取吸附边缘与浮空 bounds */
  ipcMain.handle('dock:get-edge', () => {
    return { dockedEdge, dockBounds };
  });

  /** get-auto-launch — 获取开机自启状态 */
  ipcMain.handle('get-auto-launch', () => {
    return store.get('autoLaunch', false);
  });

  /** set-auto-launch — 设置开机自启状态 */
  ipcMain.handle('set-auto-launch', (_event, enabled) => {
    store.set('autoLaunch', !!enabled);
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    console.log(`[AutoLaunch] 开机自启设置为: ${!!enabled}`);
    return { success: true };
  });

  // ========== 数据导出/导入/统计 IPC ==========

  /** data:export — 导出 Excel 可读数据 + JSON 完整备份 */
  ipcMain.handle('data:export', async () => {
    try {
      const XLSX = require('xlsx');
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const timeStr = new Date().toTimeString().slice(0, 5).replace(/:/g, '');
      const defaultName = `DesktopSecretary_导出_${dateStr}_${timeStr}`;

      const { filePath } = await dialog.showSaveDialog(mainWindow, {
        title: '导出数据',
        defaultPath: `${defaultName}.xlsx`,
        filters: [
          { name: 'Excel 文件', extensions: ['xlsx'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (!filePath) return { success: false, cancelled: true };

      const dir = path.dirname(filePath);
      const baseName = path.basename(filePath, path.extname(filePath));
      const excelPath = path.join(dir, `${baseName}.xlsx`);
      const backupPath = path.join(dir, `${baseName}_备份.json`);

      // 读取所有数据
      const workspaces = store.get('workspaces', []);
      const todosGlobal = store.get('todosGlobal', []);
      const globalQuickIcons = store.get('globalQuickIcons', []);
      const aiSettings = decryptAiSettings(store.get('aiSettings', {}));
      const tokenStats = store.get('tokenStats', {});

      // 按工作区读取隔离数据
      const allQuickLinks = [];
      const allFileShortcuts = [];
      for (const ws of workspaces) {
        const ql = store.get(`quickLinks:${ws.id}`, {});
        for (const [groupId, group] of Object.entries(ql)) {
          for (const link of group.links || []) {
            allQuickLinks.push({
              工作区: ws.name,
              分组: group.name || groupId,
              标题: link.title,
              URL: link.url,
              添加日期: link.addedAt,
            });
          }
        }
        const fsData = store.get(`fileShortcuts:${ws.id}`, []);
        for (const s of fsData) {
          allFileShortcuts.push({
            工作区: ws.name,
            名称: s.name,
            路径: s.path,
            添加日期: s.addedAt,
          });
        }
      }

      // 生成 Excel
      const wb = XLSX.utils.book_new();

      const wsWorkspaces = XLSX.utils.json_to_sheet(workspaces.map((w) => ({ ID: w.id, 名称: w.name })));
      XLSX.utils.book_append_sheet(wb, wsWorkspaces, '工作区');

      const wsTodos = XLSX.utils.json_to_sheet(
        todosGlobal.map((t) => ({
          内容: t.text,
          完成: t.done ? '是' : '否',
          优先级: t.priority,
          工作区ID: t.workspaceId || '',
          创建时间: t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : '',
        }))
      );
      XLSX.utils.book_append_sheet(wb, wsTodos, '待办事项');

      const wsLinks = XLSX.utils.json_to_sheet(allQuickLinks);
      XLSX.utils.book_append_sheet(wb, wsLinks, '快速链接');

      const wsIcons = XLSX.utils.json_to_sheet(
        globalQuickIcons.map((i) => ({ 标题: i.title, URL: i.url, 来源: i.titleSource }))
      );
      XLSX.utils.book_append_sheet(wb, wsIcons, '全局快捷图标');

      const wsFiles = XLSX.utils.json_to_sheet(allFileShortcuts);
      XLSX.utils.book_append_sheet(wb, wsFiles, '文件快捷方式');

      const safeAiSettings = { ...aiSettings, apiKey: aiSettings.apiKey ? '***' : '' };
      const wsAi = XLSX.utils.json_to_sheet([
        { 项目: '模型', 值: safeAiSettings.provider },
        { 项目: 'API Key', 值: safeAiSettings.apiKey },
        { 项目: 'Base URL', 值: safeAiSettings.customBaseUrl || '' },
        { 项目: '模型名称', 值: safeAiSettings.customModel || '' },
        { 项目: '截图快捷键', 值: safeAiSettings.shortcutKey || '' },
      ]);
      XLSX.utils.book_append_sheet(wb, wsAi, 'AI 设置');

      const wsToken = XLSX.utils.json_to_sheet([
        { 项目: '今日消耗', 值: tokenStats.today || 0 },
        { 项目: '本月消耗', 值: tokenStats.month || 0 },
        { 项目: '上次请求', 值: tokenStats.lastRequest || 0 },
      ]);
      XLSX.utils.book_append_sheet(wb, wsToken, 'Token 统计');

      XLSX.writeFile(wb, excelPath);

      // 生成 JSON 备份（完整数据，含敏感信息，用于恢复）
      const backupData = {
        _meta: { appName: 'DesktopSecretary', version: '1.0.0', exportedAt: new Date().toISOString() },
        workspaces,
        todosGlobal,
        globalQuickIcons,
        aiSettings,
        tokenStats,
        fileShortcutViewMode: store.get('fileShortcutViewMode', 'icons'),
        dockedEdge: store.get('dockedEdge', null),
        dockBounds: store.get('dockBounds', null),
        dockEdgeOffset: store.get('dockEdgeOffset', null),
        windowWidthPercent: store.get('windowWidthPercent', 1.0),
        autoLaunch: store.get('autoLaunch', false),
      };
      for (const ws of workspaces) {
        backupData[`quickLinks:${ws.id}`] = store.get(`quickLinks:${ws.id}`, {});
        backupData[`fileShortcuts:${ws.id}`] = store.get(`fileShortcuts:${ws.id}`, []);
      }
      // 保留 linkCache
      backupData.linkCache = store.get('linkCache', {});

      fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');

      return { success: true, excelPath, backupPath };
    } catch (err) {
      console.error('[DataExport] 导出失败:', err);
      return { success: false, error: err.message };
    }
  });

  /** data:import — 从 JSON 备份恢复数据 */
  ipcMain.handle('data:import', async () => {
    try {
      const { filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: '导入备份',
        properties: ['openFile'],
        filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      });
      if (!filePaths || filePaths.length === 0) return { success: false, cancelled: true };

      const content = fs.readFileSync(filePaths[0], 'utf-8');
      const data = JSON.parse(content);

      if (!data._meta || data._meta.appName !== 'DesktopSecretary') {
        return { success: false, error: '无效的备份文件（缺少 DesktopSecretary 标识）' };
      }

      // 恢复所有数据键
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith('_')) continue;
        safeStoreSet(key, value);
      }

      return { success: true, message: '数据已恢复，建议重启应用以确保所有组件重新加载。' };
    } catch (err) {
      console.error('[DataImport] 导入失败:', err);
      return { success: false, error: err.message };
    }
  });

  /** data:stats — 获取存储统计 */
  ipcMain.handle('data:stats', () => {
    try {
      const stats = fs.statSync(store.path);
      const fileSize = stats.size;
      const fileSizeFormatted =
        fileSize < 1024
          ? `${fileSize} B`
          : fileSize < 1024 * 1024
            ? `${(fileSize / 1024).toFixed(1)} KB`
            : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;

      const workspaces = store.get('workspaces', []);
      const todos = store.get('todosGlobal', []).length;
      let links = 0;
      let fileShortcuts = 0;
      for (const ws of workspaces) {
        const ql = store.get(`quickLinks:${ws.id}`, {});
        for (const group of Object.values(ql)) {
          links += (group.links || []).length;
        }
        fileShortcuts += store.get(`fileShortcuts:${ws.id}`, []).length;
      }
      const globalIcons = store.get('globalQuickIcons', []).length;

      return {
        success: true,
        fileSize,
        fileSizeFormatted,
        counts: {
          workspaces: workspaces.length,
          todos,
          links,
          fileShortcuts,
          globalIcons,
        },
      };
    } catch (err) {
      console.error('[DataStats] 统计失败:', err);
      return { success: false, error: err.message };
    }
  });

  // ========== 更新检查 IPC ==========

  /** check-for-update — 检查更新
   *  优先使用公开 HTTP API（无需 SecretKey），fallback 到 CloudBase SDK（兼容旧配置）
   */
  ipcMain.handle('check-for-update', async (_event, currentVersion) => {
    console.log('[Update] 检查更新, 当前版本:', currentVersion);

    // 发送检查中状态
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:status', { status: 'checking', version: currentVersion });
    }

    // 版本号比较：返回负数表示 v1 < v2，0 表示相等，正数表示 v1 > v2
    function compareVersion(v1, v2) {
      const parts1 = String(v1).split('.').map(Number);
      const parts2 = String(v2).split('.').map(Number);
      const maxLen = Math.max(parts1.length, parts2.length);
      for (let i = 0; i < maxLen; i++) {
        const a = parts1[i] || 0;
        const b = parts2[i] || 0;
        if (a !== b) return a - b;
      }
      return 0;
    }

    // 辅助函数：统一把后端返回格式映射成前端期望的 status 格式
    // 不再盲目相信 result.hasUpdate，而是自己做版本号比较
    function mapResult(result) {
      const latestVersion = result && (result.version || result.latestVersion);
      const shouldUpdate = latestVersion && compareVersion(currentVersion, latestVersion) < 0;
      const payload = shouldUpdate
        ? {
            status: 'available',
            version: currentVersion,
            latestVersion,
            releaseNotes: result.message || result.releaseNotes,
            downloadUrl: result.downloadUrl || null,
          }
        : {
            status: 'latest',
            version: currentVersion,
          };
      console.log('[Update] 版本比较:', currentVersion, 'vs', latestVersion, '→', payload.status);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:status', payload);
      }
      return result;
    }

    // ========== 公开 HTTP API（update.json）==========
    if (UPDATE_API_URL) {
      try {
        const url = new URL(UPDATE_API_URL);
        url.searchParams.set('version', currentVersion);
        const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const result = await resp.json();
        console.log('[Update] HTTP API 返回:', result);
        return mapResult(result);
      } catch (err) {
        console.error('[Update] HTTP API 调用失败:', err.message);
        const errorPayload = { status: 'error', version: currentVersion, error: err.message };
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:status', errorPayload);
        }
        return { success: false, error: err.message };
      }
    }

    const errMsg = '未配置更新接口（UPDATE_API_URL），自动更新已禁用';
    console.warn('[Update]', errMsg);
    const errorPayload = { status: 'error', version: currentVersion, error: errMsg };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:status', errorPayload);
    }
    return { success: false, error: errMsg };
  });

  // 保存下载的安装包路径，供安装步骤使用
  let updateInstallerPath = null;

  /** download-update — 下载更新安装包到临时目录
   *  支持 HTTP 重定向（最多 5 次），自动清理失败时的临时文件
   */
  ipcMain.handle('download-update', async (_event, downloadUrl) => {
    console.log('[Update] 开始下载:', downloadUrl);
    updateInstallerPath = null;

    const tmpDir = os.tmpdir();
    const fileName = `DesktopSecretary-Update-${Date.now()}.exe`;
    const filePath = path.join(tmpDir, fileName);
    const MAX_REDIRECTS = 5;

    return new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(filePath);
      let receivedBytes = 0;
      let totalBytes = 0;

      function doDownload(url, redirectsLeft) {
        const urlObj = new URL(url);
        const httpModule = urlObj.protocol === 'https:' ? https : http;

        const request = httpModule.get(url, (response) => {
          // 处理 HTTP 重定向 (301/302/307/308)
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            if (redirectsLeft <= 0) {
              fs.unlink(filePath, () => {});
              reject(new Error('下载重定向次数过多'));
              return;
            }
            console.log('[Update] 跟随重定向:', response.headers.location);
            doDownload(response.headers.location, redirectsLeft - 1);
            return;
          }

          if (response.statusCode !== 200) {
            fs.unlink(filePath, () => {});
            reject(new Error(`下载失败，HTTP ${response.statusCode}`));
            return;
          }

          totalBytes = parseInt(response.headers['content-length'] || '0', 10);

          response.on('data', (chunk) => {
            receivedBytes += chunk.length;
            const progress = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('update:status', {
                status: 'downloading',
                progress,
                receivedBytes,
                totalBytes,
              });
            }
          });

          response.pipe(fileStream);

          fileStream.on('finish', () => {
            updateInstallerPath = filePath;
            console.log('[Update] 下载完成:', filePath);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('update:status', { status: 'downloaded', installerPath: filePath });
            }
            resolve({ success: true, path: filePath });
          });
        });

        request.on('error', (err) => {
          fs.unlink(filePath, () => {});
          console.error('[Update] 下载失败:', err);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update:status', { status: 'error', error: err.message });
          }
          reject(err);
        });
      }

      fileStream.on('error', (err) => {
        fs.unlink(filePath, () => {});
        console.error('[Update] 写入文件失败:', err);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:status', { status: 'error', error: err.message });
        }
        reject(err);
      });

      doDownload(downloadUrl, MAX_REDIRECTS);
    });
  });

  /** install-update — 打开安装程序并退出应用
   *  最可靠的方式：直接用系统默认方式打开安装包，让用户手动完成安装向导。
   *  避免静默安装 /S 在 oneClick:false 模式下不稳定的问题。
   */
  ipcMain.handle('install-update', async () => {
    if (!updateInstallerPath || !fs.existsSync(updateInstallerPath)) {
      return { success: false, error: '安装包不存在，请重新下载' };
    }

    console.log('[Update] 打开安装程序:', updateInstallerPath);

    // 先关闭所有窗口，释放文件锁
    BrowserWindow.getAllWindows().forEach((win) => {
      try { if (!win.isDestroyed()) win.destroy(); } catch {}
    });

    // 用系统默认方式打开安装包（用户会看到 NSIS 安装向导）
    shell.openPath(updateInstallerPath);

    // 延迟退出应用，避免和安装向导冲突
    setTimeout(() => {
      app.quit();
    }, 500);

    return { success: true };
  });

  // ========== 同步相关 IPC ==========

  /** sync:sendCode — 发送注册验证码 */
  ipcMain.handle('sync:sendCode', async (_event, email) => {
    try {
      const auth = getAuth();
      if (!auth) throw new Error('同步模块未初始化');
      if (!auth.verify) throw new Error('验证码模块未初始化');
      return await auth.verify.sendCode(email.trim().toLowerCase());
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:register — 用户注册（需验证码） */
  ipcMain.handle('sync:register', async (_event, username, password, code, importLocalData = true) => {
    try {
      const auth = getAuth();
      if (!auth) throw new Error('同步模块未初始化');
      const result = await auth.register(username, password, code);
      const uid = result.uid;
      const engine = getEngine();
      if (engine) {
        if (importLocalData) {
          // 将当前顶层数据绑定到新账户并推送
          engine.profile.bindCurrentDataToProfile(uid);
          engine.profile.activeUid = uid;
          engine.push().catch((err) => console.error('[Sync] 注册后首次 Push 失败:', err.message));
        } else {
          // 空账户注册：将当前数据归档到匿名空间，清空顶层，不推送
          engine.profile.archiveProfile('anonymous');
          engine.profile.clearActiveKeys();
          engine.profile.activeUid = uid;
          console.log('[Profile] 空账户注册，已清空本地数据');
        }
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:login — 用户登录 */
  ipcMain.handle('sync:login', async (_event, username, password) => {
    try {
      const auth = getAuth();
      if (!auth) throw new Error('同步模块未初始化');
      const result = await auth.login(username, password);
      const uid = result.uid;
      const engine = getEngine();
      if (engine) {
        // ⭐ 关键：切换 profile 时合并匿名数据
        await engine.switchProfile(uid, { mergeAnonymous: true });
        engine.pull().catch((err) => console.error('[Sync] 登录后自动 Pull 失败:', err.message));
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:logout — 退出登录 */
  ipcMain.handle('sync:logout', async () => {
    try {
      const auth = getAuth();
      const engine = getEngine();
      if (!auth) throw new Error('同步模块未初始化');

      // 先归档当前账户数据，再切回匿名
      const currentUid = engine?.profile?.activeUid;
      if (engine && currentUid && currentUid !== 'anonymous') {
        engine.profile.archiveProfile(currentUid);
        await engine.switchProfile('anonymous', { mergeAnonymous: false });
      }

      return await auth.logout();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });



  /** sync:getStatus — 获取登录状态 */
  ipcMain.handle('sync:getStatus', () => {
    const auth = getAuth();
    if (!auth) return { isLoggedIn: false, error: '同步模块未初始化' };
    return auth.getStatus();
  });

  /** sync:syncNow — 手动触发同步 */
  ipcMain.handle('sync:syncNow', async () => {
    try {
      const engine = getEngine();
      if (!engine) throw new Error('同步模块未初始化');
      return await engine.sync();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:push — 手动上传 */
  ipcMain.handle('sync:push', async () => {
    try {
      const engine = getEngine();
      if (!engine) throw new Error('同步模块未初始化');
      return await engine.push();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** sync:pull — 手动下载 */
  ipcMain.handle('sync:pull', async () => {
    try {
      const engine = getEngine();
      if (!engine) throw new Error('同步模块未初始化');
      return await engine.pull();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// ========== 单实例锁定（防止重复开启多个窗口）==========
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[App] 已有实例在运行，退出当前实例');
  app.quit();
  return;
}

app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
  console.log('[App] 检测到第二次启动，聚焦已有窗口');
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (!dockExpanded && dockedEdge !== null) {
      expandDock('second-instance');
    }
  }
});

app.whenReady().then(async () => {
  try {
    platform.windowOptions.applyAppLevelPlatformSetup(app);
    await initStore();
    initSync(store, tcbApp);
    initSafeStorage();
    await migrateApiKeyEncryption();
    registerIpcHandlers();
    await createWindow();
    console.log('createWindow() completed, window count:', BrowserWindow.getAllWindows().length);

    // ========== electron-updater 自动更新事件监听 ==========
    autoUpdater.on('checking-for-update', () => {
      console.log('[AutoUpdate] 正在检查更新...');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:status', { status: 'checking' });
      }
    });

    autoUpdater.on('update-available', (info) => {
      console.log('[AutoUpdate] 发现新版本:', info.version);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:status', {
          status: 'available',
          latestVersion: info.version,
          releaseNotes: info.releaseNotes,
        });
      }
    });

    autoUpdater.on('update-not-available', () => {
      console.log('[AutoUpdate] 当前已是最新版本');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:status', { status: 'latest' });
      }
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:status', {
          status: 'downloading',
          progress: percent,
          receivedBytes: progress.transferred,
          totalBytes: progress.total,
        });
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log('[AutoUpdate] 更新已下载:', info.version);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:status', { status: 'downloaded', version: info.version });
      }
    });

    autoUpdater.on('error', (err) => {
      console.error('[AutoUpdate] 错误:', err.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:status', { status: 'error', error: err.message });
      }
    });

    // 应用启动后延迟 10 秒自动检查更新（避免启动时网络竞争）
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[AutoUpdate] 启动时检查更新失败:', err.message);
      });
    }, 10000);

    // 预创建截图 overlay（每块屏一个，常驻隐藏），截图时直接 show
    ensureOverlayReady().catch((err) => {
      console.error('[Screenshot] overlay 预创建失败（首次截图时会重试）:', err);
    });
    attachDisplayChangeListeners();

    // 启动时读取保存的锁定状态，首次默认锁定，保持展开
    dockPinned = store.get('dockPinned', true);
    expandDock('startup');

    // 应用开机自启设置
    const autoLaunch = store.get('autoLaunch', false);
    app.setLoginItemSettings({ openAtLogin: !!autoLaunch });

    // 启动时清理过期缓存
    cleanupLinkCache();

    // 启动时清理过期的临时更新安装包
    try {
      const tmpDir = os.tmpdir();
      const tmpFiles = fs.readdirSync(tmpDir);
      let cleaned = 0;
      for (const f of tmpFiles) {
        if (f.startsWith('DesktopSecretary-Update-') && f.endsWith('.exe')) {
          try { fs.unlinkSync(path.join(tmpDir, f)); cleaned++; } catch {}
        }
      }
      if (cleaned > 0) {
        console.log(`[Update] 启动时清理了 ${cleaned} 个过期临时安装包`);
      }
    } catch (err) {
      console.warn('[Update] 清理临时安装包失败:', err.message);
    }

    // 启动时自动注册保存的快捷键
    const savedSettings = decryptAiSettings(store.get('aiSettings', {}));
    if (savedSettings.shortcutKey) {
      const accelerator = platform.shortcuts.normalizeShortcut(savedSettings.shortcutKey);
      await new Promise((resolve) => {
        if (registeredShortcut) {
          try { globalShortcut.unregister(registeredShortcut); } catch {}
          registeredShortcut = null;
        }
        try {
          const ok = globalShortcut.register(accelerator, () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('shortcut-triggered');
            }
          });
          if (ok) {
            registeredShortcut = accelerator;
            console.log(`[Shortcut] 启动时自动注册: ${accelerator}`);
          }
          resolve(ok);
        } catch (err) {
          resolve(false);
        }
      });
    }

    // 启动时自动注册保存的钉住状态快捷键
    const savedPinShortcut = store.get('pinShortcutKey', '');
    if (savedPinShortcut) {
      const accelerator = platform.shortcuts.normalizeShortcut(savedPinShortcut);
      await new Promise((resolve) => {
        if (registeredPinShortcut) {
          try { globalShortcut.unregister(registeredPinShortcut); } catch {}
          registeredPinShortcut = null;
        }
        try {
          const ok = globalShortcut.register(accelerator, () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('pin-shortcut-triggered');
            }
          });
          if (ok) {
            registeredPinShortcut = accelerator;
            console.log(`[PinShortcut] 启动时自动注册: ${accelerator}`);
          }
          resolve(ok);
        } catch (err) {
          resolve(false);
        }
      });
    }

    // 启动待办提醒轮询
    startReminderPolling();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => {
          console.error('Failed to recreate main window:', err);
        });
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
  registeredShortcut = null;
  registeredPinShortcut = null;
  destroyOverlay();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
