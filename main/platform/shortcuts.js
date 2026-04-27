/**
 * 快捷键抽象
 *
 * 使用 Electron 的 CmdOrCtrl 占位符：
 *   - Windows / Linux 下展开为 Control
 *   - macOS 下展开为 Command
 */

const DEFAULT_SCREENSHOT_SHORTCUT = 'CmdOrCtrl+Shift+Z';
const DEFAULT_AI_SHORTCUT = 'CmdOrCtrl+Shift+A';

/**
 * 把旧存档里的 Ctrl+... 规范化成 CmdOrCtrl+...，
 * 保证 macOS 上跟随 Command，Windows 上行为不变。
 */
function normalizeShortcut(accelerator) {
  if (!accelerator || typeof accelerator !== 'string') return accelerator;
  // 已经是 CmdOrCtrl / Cmd / Command 的保持不动
  if (/\b(CmdOrCtrl|Cmd|Command)\b/i.test(accelerator)) return accelerator;
  return accelerator.replace(/\bCtrl\b/i, 'CmdOrCtrl');
}

module.exports = {
  DEFAULT_SCREENSHOT_SHORTCUT,
  DEFAULT_AI_SHORTCUT,
  normalizeShortcut,
};
