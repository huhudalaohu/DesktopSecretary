/**
 * DesktopSecretary - 预加载脚本 (preload.js)
 *
 * 安全地将 IPC API 暴露给渲染进程。
 * 通过 contextBridge 注入 window.desktopAPI 对象，
 * 渲染进程只能调用这里列出的方法，无法直接访问 Node.js 或 Electron API。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  // ========== electron-store 操作 ==========

  /** 读取存储数据 */
  storeGet: (key, defaultValue) => ipcRenderer.invoke('store:get', key, defaultValue),

  /** 写入存储数据 */
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),

  // ========== 文件操作 ==========

  /** 用系统默认方式打开文件夹，并自动记录到 recentFolders */
  openFolder: (folderPath, storeKey) => ipcRenderer.invoke('open-folder', folderPath, storeKey),

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
   * 获取前台窗口信息（Windows 专用）
   * @returns {Promise<Array<{title, processName, rect, isChatApp}>>}
   */
  getFrontWindows: () => ipcRenderer.invoke('get-front-windows'),

  // ========== 系统交互 ==========

  /** 弹出系统错误提示框 */
  showError: (title, content) => ipcRenderer.invoke('show-error', title, content),

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

  /** 监听 Dock 状态变化 */
  onDockStateChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('dock:state-changed', handler);
    return () => ipcRenderer.removeListener('dock:state-changed', handler);
  },
});
