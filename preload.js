/**
 * DesktopSecretary - 预加载脚本 (preload.js)
 *
 * 安全地将 IPC API 暴露给渲染进程。
 * 通过 contextBridge 注入 window.desktopAPI 对象，
 * 渲染进程只能调用这里列出的方法，无法直接访问 Node.js 或 Electron API。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  // ========== electron-store 操作 ==========

  /** 读取存储数据 */
  storeGet: (key, defaultValue) => ipcRenderer.invoke('store:get', key, defaultValue),

  /** 写入存储数据 */
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),

  // ========== 文件操作 ==========

  /** 用系统默认方式打开文件夹 */
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

  /** 获取拖拽文件的本地绝对路径（Electron 22+ webUtils） */
  getFilePath: (file) => webUtils.getPathForFile(file),

  /** 扫描桌面目录，返回最近修改的文件列表 */
  getDesktopFiles: () => ipcRenderer.invoke('get-desktop-files'),

  /** 移动文件到目标文件夹（会弹出系统确认对话框） */
  moveFiles: (fromPaths, toDir) => ipcRenderer.invoke('move-files', fromPaths, toDir),

  // ========== 截图 ==========

  /**
   * 截取所有屏幕的截图
   * @returns {Promise<{sources: Array<{id, displayId, name, dataUrl, thumbnailSize}>, totalDisplays, error?}>}
   */
  captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),

  /**
   * 获取所有屏幕的尺寸和位置信息
   * 用于绘制截图遮罩层覆盖全部屏幕
   */
  getScreenInfo: () => ipcRenderer.invoke('get-screen-info'),

  /**
   * 获取前台窗口信息（跨平台，主进程通过平台抽象层分发）
   * @returns {Promise<Array<{title, processName, rect, isChatApp}>>}
   */
  getFrontWindows: () => ipcRenderer.invoke('get-front-windows'),

  // ========== 系统交互 ==========

  /** 弹出系统错误提示框 */
  showError: (title, content) => ipcRenderer.invoke('show-error', title, content),

  /** 弹出待办提醒对话框 */

  /** 关闭应用 */
  closeApp: () => ipcRenderer.invoke('close-app'),

  /** 调整窗口宽度 */
  resizeWindow: (width) => ipcRenderer.invoke('resize-window', width),

  /** 获取当前窗口宽度 */
  getWindowWidth: () => ipcRenderer.invoke('get-window-width'),

  /** 在默认浏览器中打开外部链接 */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  /** 主进程抓取网页 OG 元数据（无 CORS 限制，2s 超时，24h 缓存） */
  fetchLinkPreview: (url) => ipcRenderer.invoke('fetch-link-preview', url),

  /** 主进程隐藏窗口渲染后提取标题（对付 CSR / 反爬） */
  fetchRenderedTitle: (url) => ipcRenderer.invoke('fetch-rendered-title', url),

  // ========== 全局快捷键 ==========

  /**
   * 注册全局快捷键
   * @param {string} accelerator — 快捷键字符串，如 "Ctrl+Shift+A"
   * @returns {Promise<{success, error?}>}
   */
  registerShortcut: (accelerator) => ipcRenderer.invoke('register-shortcut', accelerator),

  /**
   * 注销当前全局快捷键
   * @returns {Promise<{success}>}
   */
  unregisterShortcut: () => ipcRenderer.invoke('unregister-shortcut'),

  /**
   * 监听快捷键触发事件
   * @param {Function} callback — 快捷键按下时的回调
   * @returns {Function} 取消监听的函数
   */
  onShortcutTriggered: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('shortcut-triggered', handler);
    return () => ipcRenderer.removeListener('shortcut-triggered', handler);
  },

  /**
   * 注册切换钉住状态的全局快捷键
   */
  registerPinShortcut: (accelerator) => ipcRenderer.invoke('register-pin-shortcut', accelerator),

  /**
   * 注销切换钉住状态的全局快捷键
   */
  unregisterPinShortcut: () => ipcRenderer.invoke('unregister-pin-shortcut'),

  /**
   * 监听钉住状态快捷键触发事件
   */
  onPinShortcutTriggered: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('pin-shortcut-triggered', handler);
    return () => ipcRenderer.removeListener('pin-shortcut-triggered', handler);
  },

  // ========== 截图 overlay ==========

  /**
   * 启动截图 overlay 流程（隐藏主窗口、截屏、显示 overlay，等待用户操作）
   * @returns {Promise<string>} 裁剪后的 dataUrl
   */
  startScreenshotOverlay: () => ipcRenderer.invoke('start-screenshot-overlay'),

  /**
   * 监听截图 overlay 数据推送（仅 overlay 窗口使用）
   * @param {Function} callback — 接收 {dataUrl, windowRect, virtualBounds, primaryDisplay}
   * @returns {Function} 取消监听的函数
   */
  onScreenshotStart: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('screenshot:start', handler);
    return () => ipcRenderer.removeListener('screenshot:start', handler);
  },

  /**
   * 监听异步更新的前台窗口矩形（overlay 窗口使用）
   * @param {Function} callback — 接收 windowRect
   * @returns {Function} 取消监听的函数
   */
  onScreenshotUpdateWindowRect: (callback) => {
    const handler = (_event, rect) => callback(rect);
    ipcRenderer.on('screenshot:update-window-rect', handler);
    return () => ipcRenderer.removeListener('screenshot:update-window-rect', handler);
  },

  /**
   * 发送截图裁剪坐标到主进程
   * @param {Object} rect — {x, y, width, height} 虚拟屏幕坐标
   * @returns {Promise<{success, dataUrl?, error?}>}
   */
  screenshotCrop: (rect) => ipcRenderer.invoke('screenshot:crop', rect),

  /**
   * 取消截图 overlay
   * @returns {Promise<{success}>}
   */
  screenshotCancel: () => ipcRenderer.invoke('screenshot:cancel'),

  /**
   * 通知主进程 overlay 已加载好新截图（ready 握手）
   */
  screenshotReady: () => ipcRenderer.send('screenshot:ready'),

  /**
   * 监听截图重置信号（overlay 隐藏时清理旧状态）
   * @param {Function} callback
   * @returns {Function} 取消监听
   */
  onScreenshotReset: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('screenshot:reset', handler);
    return () => ipcRenderer.removeListener('screenshot:reset', handler);
  },

  // ========== Dock 控制 ==========

  /** 锁定展开状态 */
  dockPin: () => ipcRenderer.invoke('dock:pin'),

  /** 解锁 */
  dockUnpin: () => ipcRenderer.invoke('dock:unpin'),

  /** 切换锁定 */
  dockTogglePin: () => ipcRenderer.invoke('dock:toggle-pin'),

  /** 手动展开，可选延时后自动收起 */
  dockExpand: (delay) => ipcRenderer.invoke('dock:expand', delay),

  /** 通知正在交互（输入/滚动/点击） */
  dockSetInteracting: (interacting) => ipcRenderer.invoke('dock:set-interacting', interacting),

  /** 获取 Dock 状态 */
  dockGetState: () => ipcRenderer.invoke('dock:get-state'),

  /** 获取当前吸附边缘与浮空 bounds */
  getDockEdge: () => ipcRenderer.invoke('dock:get-edge'),

  /** 获取开机自启状态 */
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),

  /** 设置开机自启状态 */
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),

  // ========== 自动更新（基于 electron-updater）==========

  /** 触发检查更新 */
  checkUpdate: () => ipcRenderer.invoke('updater:check'),

  /** 监听更新状态推送 */
  onUpdateStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },

  /** 开始下载更新 */
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),

  /** 退出并安装更新 */
  quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),

  /** 导出数据（Excel + JSON 备份） */
  exportData: () => ipcRenderer.invoke('data:export'),

  /** 导入备份恢复数据 */
  importData: () => ipcRenderer.invoke('data:import'),

  /** 获取存储统计 */
  getDataStats: () => ipcRenderer.invoke('data:stats'),

  // ========== 云端同步 ==========

  /** 发送注册验证码 */
  syncSendCode: (email) => ipcRenderer.invoke('sync:sendCode', email),

  /** 用户注册（需验证码） */
  syncRegister: (username, password, code, importLocalData = true) => ipcRenderer.invoke('sync:register', username, password, code, importLocalData),

  /** 用户登录 */
  syncLogin: (username, password) => ipcRenderer.invoke('sync:login', username, password),

  /** 退出登录 */
  syncLogout: () => ipcRenderer.invoke('sync:logout'),

  /** 获取同步登录状态 */
  syncGetStatus: () => ipcRenderer.invoke('sync:getStatus'),

  /** 手动触发双向同步 */
  syncNow: () => ipcRenderer.invoke('sync:syncNow'),

  /** 手动上传 */
  syncPush: () => ipcRenderer.invoke('sync:push'),

  /** 手动下载 */
  syncPull: () => ipcRenderer.invoke('sync:pull'),

  /** 监听同步状态变化 */
  onSyncStatusChange: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sync:status-changed', handler);
    return () => ipcRenderer.removeListener('sync:status-changed', handler);
  },

  /** 监听 Profile 切换事件（账户切换后刷新数据） */
  onProfileSwitched: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('profile:switched', handler);
    return () => ipcRenderer.removeListener('profile:switched', handler);
  },

  /** 监听 Dock 状态变化 */
  onDockStateChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('dock:state-changed', handler);
    return () => ipcRenderer.removeListener('dock:state-changed', handler);
  },

  /**
   * 监听拖动过程中的边缘吸附提示
   * @param {Function} callback — 接收 {edge: 'left'|'right'|'top'|null}
   */
  onDockSnapHint: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('dock:snap-hint', handler);
    return () => ipcRenderer.removeListener('dock:snap-hint', handler);
  },

  /**
   * 监听吸附边缘或浮空状态切换
   * @param {Function} callback — 接收 {dockedEdge, dockBounds}
   */
  onDockEdgeChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('dock:edge-changed', handler);
    return () => ipcRenderer.removeListener('dock:edge-changed', handler);
  },

  // _appVersion 已废弃，版本号由 Vite 构建时通过 __APP_VERSION__ 注入
  // 保留此注释以避免破坏可能引用该字段的第三方代码
});

// 额外暴露 electronAPI（设置页检查更新等功能使用）
contextBridge.exposeInMainWorld('electronAPI', {
  checkUpdate: () => ipcRenderer.invoke('updater:check'),
  onUpdateStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
});

// === 拖放文件路径预存（解决 frameless 窗口 getFilePath 失效问题）===
// 注意：不在 window 级别监听 dragover，避免与 React 合成事件冲突
// React 组件的 onDragOver 会自行处理 e.preventDefault() 和 dropEffect
window.addEventListener('dragenter', (e) => {
  console.log('[Preload] dragenter', e.dataTransfer?.types, e.dataTransfer?.files?.length);
});
window.addEventListener('drop', (e) => {
  // 阻止默认行为（防止 Electron 导航到拖入的文件）
  e.preventDefault();
  console.log('[Preload] drop', 'types:', e.dataTransfer?.types, 'files:', e.dataTransfer?.files?.length);
  // 提前提取文件路径并缓存，避免在 React 合成事件中被框架拦截
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    const paths = [];
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      try {
        const p = webUtils.getPathForFile(e.dataTransfer.files[i]);
        if (p) paths.push(p);
      } catch (err) {
        console.log('[Preload] getPathForFile failed:', err.message);
      }
    }
    if (paths.length > 0) {
      window.__droppedFilePaths = paths;
      console.log('[Preload] Dropped file paths cached:', paths);
    }
  }
});
