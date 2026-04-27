/**
 * 同步模块常量定义
 */

// 固定 key：这些数据会同步到云端
const SYNC_KEYS = [
  'workspaces',
  'todosGlobal',
  'pinnedFolders',
  'linkCache',
  'reminderLevels',
  'trashedWorkspaces',
  'trashedTodos',
];

// 动态 key 前缀：需要扫描 store 中所有匹配的 key
const DYNC_KEY_PREFIXES = [
  'quickLinks:',
  'fileShortcuts:',
];

// 不同步的设备本地 key
const LOCAL_ONLY_KEYS = [
  'windowWidthPercent',
  'dockedEdge',
  'dockBounds',
  'dockEdgeOffset',
  'fontScale',
  'pinShortcutKey',
  'autoLaunch',
  'aiSettings',
  'syncSession',
  'recentFolders',
  'tokenStats',
];

const SYNC_DEBOUNCE_MS = 3000;
const SYNC_RETRY_DELAYS = [2000, 5000, 10000];

module.exports = {
  SYNC_KEYS,
  DYNC_KEY_PREFIXES,
  LOCAL_ONLY_KEYS,
  SYNC_DEBOUNCE_MS,
  SYNC_RETRY_DELAYS,
};
