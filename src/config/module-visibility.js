export const DEFAULT_MODULE_VISIBILITY = Object.freeze({
  todos: true,
  workspaces: true,
  timeline: true,
  quickLinks: true,
  fileNavigator: true,
  quickNote: true,
  aiAssistant: true,
});

export const MODULE_VISIBILITY_OPTIONS = [
  { id: 'todos', label: '事件流' },
  { id: 'workspaces', label: '工作区' },
  { id: 'timeline', label: '时间流' },
  { id: 'quickLinks', label: '链接流' },
  { id: 'fileNavigator', label: '文件流' },
  { id: 'quickNote', label: '灵感流' },
  { id: 'aiAssistant', label: '智能流' },
];

export function normalizeModuleVisibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_MODULE_VISIBILITY };
  }

  return Object.keys(DEFAULT_MODULE_VISIBILITY).reduce((visibility, key) => {
    visibility[key] = typeof value[key] === 'boolean'
      ? value[key]
      : DEFAULT_MODULE_VISIBILITY[key];
    return visibility;
  }, {});
}
