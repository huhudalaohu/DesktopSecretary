/**
 * BrowserWindow 平台化选项
 *
 * 把 mac / win 的差异集中在这里，调用方只关心业务字段（bounds、preload 路径等）。
 */

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/**
 * Dock 主窗口 options
 */
function mainWindowOptions(base) {
  const opts = {
    ...base,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    movable: true,
  };
  if (isMac) {
    // mac 下使用 vibrancy 获得磨砂；且让窗口跟随用户切 Space
    opts.vibrancy = 'under-window';
    opts.visualEffectState = 'active';
    opts.titleBarStyle = 'hidden';
    opts.trafficLightPosition = { x: -100, y: -100 }; // 隐藏红绿灯
  }
  return opts;
}

/**
 * 截图 overlay 窗口 options
 */
function overlayWindowOptions(base) {
  return {
    ...base,
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
    // mac 下 overlay 同样需要跨 Space + 覆盖全屏应用
    ...(isMac ? { enableLargerThanScreen: true } : {}),
  };
}

/**
 * 窗口创建后需要在实例上调用的平台设置
 */
function applyMainWindowPlatformSetup(win) {
  if (isMac) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // Windows 下默认 alwaysOnTop: true 即可穿透大多数场景
}

function applyOverlayPlatformSetup(win) {
  if (isMac) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
}

/**
 * 启动时的 dock 行为（macOS app.dock，不是我们自己的 Dock 组件）
 */
function applyAppLevelPlatformSetup(app) {
  if (isMac && typeof app.dock !== 'undefined' && app.dock.hide) {
    // 让我们的应用像菜单栏小工具一样不占 mac Dock 栏（LSUIElement=true 也要配）
    app.dock.hide();
  }
}

module.exports = {
  mainWindowOptions,
  overlayWindowOptions,
  applyMainWindowPlatformSetup,
  applyOverlayPlatformSetup,
  applyAppLevelPlatformSetup,
};
