/**
 * Managers 聚合入口
 */

const { StoreManager } = require('./store-manager');
const { ShortcutManager } = require('./shortcut-manager');
const { DockManager } = require('./dock-manager');
const { ScreenshotManager } = require('./screenshot-manager');
const { WindowManager } = require('./window-manager');

module.exports = {
  StoreManager,
  ShortcutManager,
  DockManager,
  ScreenshotManager,
  WindowManager,
};
