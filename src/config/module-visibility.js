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
  { id: 'todos', label: '待办事项' },
  { id: 'workspaces', label: '工作区' },
  { id: 'timeline', label: '时间轴' },
  { id: 'quickLinks', label: '快捷入口' },
  { id: 'fileNavigator', label: '文件导航' },
  { id: 'quickNote', label: '随手记' },
  { id: 'aiAssistant', label: 'AI 助手' },
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
