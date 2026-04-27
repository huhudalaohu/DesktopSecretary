/**
 * 系统权限抽象
 *
 * Windows: 全部直接 granted
 * macOS:   需要"屏幕录制"（desktopCapturer / node-screenshots 依赖）
 *         和"辅助功能"（get-windows 依赖）两类权限
 *
 * 返回:
 *   { granted: boolean, status: 'granted'|'denied'|'not-determined'|'restricted',
 *     openSettings?: () => void }
 *
 * 未授权时 openSettings 会直接打开对应的"系统设置 → 隐私"面板。
 */

const { systemPreferences, shell } = require('electron');

const isMac = process.platform === 'darwin';

const MAC_SCREEN_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const MAC_A11Y_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

/**
 * 屏幕录制权限（截屏所需）
 */
async function ensureScreenCapturePermission() {
  if (!isMac) return { granted: true, status: 'granted' };

  const status = systemPreferences.getMediaAccessStatus('screen');
  return {
    granted: status === 'granted',
    status,
    openSettings: () => shell.openExternal(MAC_SCREEN_PANE),
  };
}

/**
 * 辅助功能权限（get-windows 拿窗口标题所需）
 */
async function ensureAccessibilityPermission() {
  if (!isMac) return { granted: true, status: 'granted' };

  // Electron 未直接暴露 AX 状态；get-windows 首次调用失败时捕获即可。
  // 这里返回 not-determined，让调用方决定是否引导用户。
  const trusted =
    typeof systemPreferences.isTrustedAccessibilityClient === 'function'
      ? systemPreferences.isTrustedAccessibilityClient(false)
      : false;
  return {
    granted: trusted,
    status: trusted ? 'granted' : 'not-determined',
    openSettings: () => shell.openExternal(MAC_A11Y_PANE),
  };
}

module.exports = {
  ensureScreenCapturePermission,
  ensureAccessibilityPermission,
};
