/**
 * Browser mock for window.desktopAPI
 * Used when running in Vite dev server (no Electron)
 */

if (typeof window !== 'undefined' && !window.desktopAPI) {
  const storeKey = 'desktop-secretary-mock';

  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(storeKey)) || {};
    } catch {
      return {};
    }
  }

  function saveStore(data) {
    localStorage.setItem(storeKey, JSON.stringify(data));
  }

  const defaultData = {
    workspaces: [
      { id: 'project-a', name: '项目A' },
      { id: 'project-b', name: '项目B' },
      { id: 'daily', name: '日常' },
    ],
    todosGlobal: [
      { id: '1', text: '完成项目需求文档', done: false, priority: 'urgent', createdAt: Date.now() - 3600000, workspaceId: 'project-a', reminderTime: Date.now() + 3600000 },
      { id: '2', text: '代码审查 PR #42', done: false, priority: 'high', createdAt: Date.now() - 1800000, workspaceId: 'project-b' },
      { id: '3', text: '准备周五会议材料', done: true, priority: 'medium', createdAt: Date.now() - 7200000 },
      { id: '4', text: '更新 README 文档', done: false, priority: 'low', createdAt: Date.now() },
    ],
    quickLinks: {
      'project-a': [
        {
          group: '飞书文档',
          links: [
            { id: 'l1', title: '产品需求文档', url: 'https://feishu.cn/doc/abc123', favicon: null },
            { id: 'l2', title: '技术方案设计', url: 'https://feishu.cn/doc/def456', favicon: null },
          ],
        },
        {
          group: 'OA系统',
          links: [
            { id: 'l3', title: '请假审批', url: 'https://oa.company.com/leave', favicon: null },
          ],
        },
        {
          group: '第三方工具',
          links: [
            { id: 'l4', title: 'GitHub Repo', url: 'https://github.com/user/repo', favicon: null },
            { id: 'l5', title: 'Figma 设计稿', url: 'https://figma.com/file/abc', favicon: null },
          ],
        },
        { group: '腾讯文档', links: [] },
        { group: '未分类', links: [] },
      ],
    },
    linkCache: {},
    aiSettings: {
      provider: 'kimi',
      apiKey: '',
      customBaseUrl: '',
      customModel: '',
      shortcutKey: 'CmdOrCtrl+Shift+A',
    },
  };

  // Init store with defaults
  let store = loadStore();
  if (!store.workspaces) {
    store = { ...defaultData, ...store };
    saveStore(store);
  }

  // 异步加载 ai-preset.js 覆盖默认 AI 配置
  import('./ai-preset.js')
    .then((m) => {
      const preset = m.AI_PRESET;
      if (!preset || !preset.provider) return;
      const current = store.aiSettings || {};
      const merged = {
        ...current,
        provider: preset.provider || current.provider,
        apiKey: preset.apiKey || current.apiKey,
        customBaseUrl: preset.customBaseUrl || current.customBaseUrl,
        customModel: preset.customModel || current.customModel,
        shortcutKey: preset.shortcutKey || current.shortcutKey,
      };
      store.aiSettings = merged;
      saveStore(store);
    })
    .catch(() => {});

  const resolve = (val) => Promise.resolve(val);

  window.desktopAPI = {
    storeGet: (key, defaultValue) => {
      const keys = key.split('.');
      let val = store;
      for (const k of keys) {
        if (val == null) return resolve(defaultValue);
        val = val[k];
      }
      return resolve(val !== undefined ? val : defaultValue);
    },

    storeSet: (key, value) => {
      const keys = key.split('.');
      let obj = store;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]]) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      saveStore(store);
      return resolve();
    },

    openFolder: (folderPath) => {
      // 浏览器预览模式：无法打开本地文件夹，复制路径到剪贴板并提示
      if (folderPath) {
        navigator.clipboard?.writeText(folderPath).catch(() => {});
        console.log('[BrowserMock] openFolder:', folderPath);
        // 使用 toast 提示代替 alert，避免阻塞
        const toast = document.createElement('div');
        toast.textContent = `浏览器预览模式无法打开本地路径，已复制到剪贴板: ${folderPath}`;
        toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 16px;border-radius:6px;font-size:13px;z-index:9999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90vw;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
      }
      return resolve();
    },
    getFilePath: (file) => {
      // 浏览器安全限制：File.path 为 undefined，用模拟路径代替
      if (file?.path) return file.path;
      if (file?.name) return `/mock/${file.name}`;
      return '';
    },
    getScreenInfo: () => resolve([]),
    getFrontWindows: () => resolve([]),
    getScreenInfo: () => resolve([]),
    getFrontWindows: () => resolve([]),
    showError: (title, content) => { alert(`${title}\n${content}`); return resolve(); },
    showReminder: (title, detail) => { alert(`[提醒] ${title}\n${detail}`); return resolve(); },
    closeApp: () => { alert('关闭（浏览器预览模式下不可用）'); return resolve(); },
    resizeWindow: (w) => resolve(w),
    getWindowWidth: () => resolve(350),
    openExternal: (url) => { window.open(url, '_blank'); return resolve(); },
    fetchLinkPreview: () => resolve({ title: null, favicon: null, description: null, source: 'mock' }),
    fetchRenderedTitle: () => resolve({ title: null, favicon: null, source: 'mock' }),
    registerShortcut: () => resolve({ success: true }),
    unregisterShortcut: () => resolve({ success: true }),
    onShortcutTriggered: () => () => {},
    registerPinShortcut: () => resolve({ success: true }),
    unregisterPinShortcut: () => resolve({ success: true }),
    onPinShortcutTriggered: () => () => {},
    startScreenshotOverlay: () => resolve(null),
    onScreenshotStart: () => () => {},
    onScreenshotUpdateWindowRect: () => () => {},
    screenshotCrop: () => resolve({ success: false }),
    screenshotCancel: () => resolve({ success: true }),
    screenshotReady: () => {},
    onScreenshotReset: () => () => {},
    dockPin: () => resolve({ success: true }),
    dockUnpin: () => resolve({ success: true }),
    dockTogglePin: () => resolve({ pinned: false }),
    dockExpand: () => resolve({ success: true }),
    dockSetInteracting: () => resolve({ success: true }),
    dockGetState: () => resolve({ expanded: true, pinned: false, dockedEdge: 'right', dockBounds: null }),
    getDockEdge: () => resolve({ dockedEdge: 'right', dockBounds: null }),
    onDockStateChanged: () => () => {},
    onDockSnapHint: () => () => {},
    onDockEdgeChanged: () => () => {},
    onReminderTriggered: () => () => {},
    getAutoLaunch: () => resolve(false),
    setAutoLaunch: () => resolve({ success: true }),

    checkForUpdate: async (currentVersion) => {
      await new Promise((r) => setTimeout(r, 600));
      return { success: true, hasUpdate: false, currentVersion, latestVersion: currentVersion };
    },
    onUpdateStatus: () => () => {},
    downloadUpdate: async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return { success: true };
    },
    installUpdate: async () => {
      alert('安装（浏览器预览模式下不可用）');
      return { success: true };
    },

    exportData: async () => {
      const data = {
        _meta: { appName: 'DesktopSecretary', version: '1.0.0', exportedAt: new Date().toISOString() },
        ...store,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `DesktopSecretary_备份_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return { success: true, excelPath: '(浏览器模式暂不支持Excel导出)', backupPath: a.download };
    },

    importData: () => {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
          const file = e.target.files[0];
          if (!file) return resolve({ success: false, cancelled: true });
          const reader = new FileReader();
          reader.onload = (ev) => {
            try {
              const data = JSON.parse(ev.target.result);
              if (!data._meta || data._meta.appName !== 'DesktopSecretary') {
                return resolve({ success: false, error: '无效的备份文件' });
              }
              for (const [key, value] of Object.entries(data)) {
                if (key.startsWith('_')) continue;
                store[key] = value;
              }
              saveStore(store);
              resolve({ success: true, message: '数据已恢复，建议刷新页面。' });
            } catch (err) {
              resolve({ success: false, error: err.message });
            }
          };
          reader.readAsText(file);
        };
        input.click();
      });
    },

    getDataStats: () => {
      const raw = localStorage.getItem(storeKey) || '{}';
      const fileSize = new Blob([raw]).size;
      const fileSizeFormatted =
        fileSize < 1024
          ? `${fileSize} B`
          : fileSize < 1024 * 1024
            ? `${(fileSize / 1024).toFixed(1)} KB`
            : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;
      const workspaces = store.workspaces || [];
      const todos = (store.todosGlobal || []).length;
      let links = 0;
      let fileShortcuts = 0;
      for (const ws of workspaces) {
        const ql = store[`quickLinks:${ws.id}`] || {};
        for (const group of Object.values(ql)) {
          links += (group.links || []).length;
        }
        fileShortcuts += (store[`fileShortcuts:${ws.id}`] || []).length;
      }
      const globalIcons = (store.globalQuickIcons || []).length;
      return resolve({
        success: true,
        fileSize,
        fileSizeFormatted,
        counts: { workspaces: workspaces.length, todos, links, fileShortcuts, globalIcons },
      });
    },
  };

  // 额外暴露 electronAPI mock（设置页检查更新等功能使用）
  window.electronAPI = {
    checkForUpdate: async (version) => {
      await new Promise((r) => setTimeout(r, 600));
      return { success: true, hasUpdate: false, currentVersion: version, latestVersion: version, status: 'latest' };
    },
    onUpdateStatus: () => () => {},
    downloadUpdate: async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return { success: true };
    },
    installUpdate: async () => {
      alert('安装（浏览器预览模式下不可用）');
      return { success: true };
    },
  };

  console.log('[BrowserMock] desktopAPI mock loaded');
}
