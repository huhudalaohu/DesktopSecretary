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
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

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
});
