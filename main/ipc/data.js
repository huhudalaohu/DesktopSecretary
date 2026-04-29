/**
 * 数据导出/导入/统计 IPC Handlers
 */

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

function registerDataIpcHandlers({ store, mainWindow, dialog, decryptAiSettings, safeStoreSet }) {
  /** data:export — 导出 Excel 可读数据 + JSON 完整备份 */
  ipcMain.handle('data:export', async () => {
    try {
      const XLSX = require('xlsx');
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const timeStr = new Date().toTimeString().slice(0, 5).replace(/:/g, '');
      const defaultName = `DesktopSecretary_导出_${dateStr}_${timeStr}`;

      const { filePath } = await dialog.showSaveDialog(mainWindow, {
        title: '导出数据',
        defaultPath: `${defaultName}.xlsx`,
        filters: [
          { name: 'Excel 文件', extensions: ['xlsx'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (!filePath) return { success: false, cancelled: true };

      const dir = path.dirname(filePath);
      const baseName = path.basename(filePath, path.extname(filePath));
      const excelPath = path.join(dir, `${baseName}.xlsx`);
      const backupPath = path.join(dir, `${baseName}_备份.json`);

      // 读取所有数据
      const workspaces = store.get('workspaces', []);
      const todosGlobal = store.get('todosGlobal', []);
      const globalQuickIcons = store.get('globalQuickIcons', []);
      const aiSettings = decryptAiSettings(store.get('aiSettings', {}));
      const tokenStats = store.get('tokenStats', {});

      // 按工作区读取隔离数据
      const allQuickLinks = [];
      const allFileShortcuts = [];
      for (const ws of workspaces) {
        const ql = store.get(`quickLinks:${ws.id}`, {});
        for (const [groupId, group] of Object.entries(ql)) {
          for (const link of group.links || []) {
            allQuickLinks.push({
              工作区: ws.name,
              分组: group.name || groupId,
              标题: link.title,
              URL: link.url,
              添加日期: link.addedAt,
            });
          }
        }
        const fsData = store.get(`fileShortcuts:${ws.id}`, []);
        for (const s of fsData) {
          allFileShortcuts.push({
            工作区: ws.name,
            名称: s.name,
            路径: s.path,
            添加日期: s.addedAt,
          });
        }
      }

      // 生成 Excel
      const wb = XLSX.utils.book_new();

      const wsWorkspaces = XLSX.utils.json_to_sheet(workspaces.map((w) => ({ ID: w.id, 名称: w.name })));
      XLSX.utils.book_append_sheet(wb, wsWorkspaces, '工作区');

      const wsTodos = XLSX.utils.json_to_sheet(
        todosGlobal.map((t) => ({
          内容: t.text,
          完成: t.done ? '是' : '否',
          优先级: t.priority,
          工作区ID: t.workspaceId || '',
          创建时间: t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : '',
        }))
      );
      XLSX.utils.book_append_sheet(wb, wsTodos, '待办事项');

      const wsLinks = XLSX.utils.json_to_sheet(allQuickLinks);
      XLSX.utils.book_append_sheet(wb, wsLinks, '快速链接');

      const wsIcons = XLSX.utils.json_to_sheet(
        globalQuickIcons.map((i) => ({ 标题: i.title, URL: i.url, 来源: i.titleSource }))
      );
      XLSX.utils.book_append_sheet(wb, wsIcons, '全局快捷图标');

      const wsFiles = XLSX.utils.json_to_sheet(allFileShortcuts);
      XLSX.utils.book_append_sheet(wb, wsFiles, '文件快捷方式');

      const safeAiSettings = { ...aiSettings, apiKey: aiSettings.apiKey ? '***' : '' };
      const wsAi = XLSX.utils.json_to_sheet([
        { 项目: '模型', 值: safeAiSettings.provider },
        { 项目: 'API Key', 值: safeAiSettings.apiKey },
        { 项目: 'Base URL', 值: safeAiSettings.customBaseUrl || '' },
        { 项目: '模型名称', 值: safeAiSettings.customModel || '' },
        { 项目: '截图快捷键', 值: safeAiSettings.shortcutKey || '' },
      ]);
      XLSX.utils.book_append_sheet(wb, wsAi, 'AI 设置');

      const wsToken = XLSX.utils.json_to_sheet([
        { 项目: '今日消耗', 值: tokenStats.today || 0 },
        { 项目: '本月消耗', 值: tokenStats.month || 0 },
        { 项目: '上次请求', 值: tokenStats.lastRequest || 0 },
      ]);
      XLSX.utils.book_append_sheet(wb, wsToken, 'Token 统计');

      XLSX.writeFile(wb, excelPath);

      // 生成 JSON 备份（完整数据，含敏感信息，用于恢复）
      const backupData = {
        _meta: { appName: 'DesktopSecretary', version: '1.0.0', exportedAt: new Date().toISOString() },
        workspaces,
        todosGlobal,
        globalQuickIcons,
        aiSettings,
        tokenStats,
        fileShortcutViewMode: store.get('fileShortcutViewMode', 'icons'),
        dockedEdge: store.get('dockedEdge', null),
        dockBounds: store.get('dockBounds', null),
        dockEdgeOffset: store.get('dockEdgeOffset', null),
        windowWidthPercent: store.get('windowWidthPercent', 1.0),
        autoLaunch: store.get('autoLaunch', false),
      };
      for (const ws of workspaces) {
        backupData[`quickLinks:${ws.id}`] = store.get(`quickLinks:${ws.id}`, {});
        backupData[`fileShortcuts:${ws.id}`] = store.get(`fileShortcuts:${ws.id}`, []);
      }
      // 保留 linkCache
      backupData.linkCache = store.get('linkCache', {});

      fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');

      return { success: true, excelPath, backupPath };
    } catch (err) {
      console.error('[DataExport] 导出失败:', err);
      return { success: false, error: err.message };
    }
  });

  /** data:import — 从 JSON 备份恢复数据 */
  ipcMain.handle('data:import', async () => {
    try {
      const { filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: '导入备份',
        properties: ['openFile'],
        filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      });
      if (!filePaths || filePaths.length === 0) return { success: false, cancelled: true };

      const content = fs.readFileSync(filePaths[0], 'utf-8');
      const data = JSON.parse(content);

      if (!data._meta || data._meta.appName !== 'DesktopSecretary') {
        return { success: false, error: '无效的备份文件（缺少 DesktopSecretary 标识）' };
      }

      // 恢复所有数据键
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith('_')) continue;
        safeStoreSet(key, value);
      }

      return { success: true, message: '数据已恢复，建议重启应用以确保所有组件重新加载。' };
    } catch (err) {
      console.error('[DataImport] 导入失败:', err);
      return { success: false, error: err.message };
    }
  });

  /** data:stats — 获取存储统计 */
  ipcMain.handle('data:stats', () => {
    try {
      const stats = fs.statSync(store.path);
      const fileSize = stats.size;
      const fileSizeFormatted =
        fileSize < 1024
          ? `${fileSize} B`
          : fileSize < 1024 * 1024
            ? `${(fileSize / 1024).toFixed(1)} KB`
            : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;

      const workspaces = store.get('workspaces', []);
      const todos = store.get('todosGlobal', []).length;
      let links = 0;
      let fileShortcuts = 0;
      for (const ws of workspaces) {
        const ql = store.get(`quickLinks:${ws.id}`, {});
        for (const group of Object.values(ql)) {
          links += (group.links || []).length;
        }
        fileShortcuts += store.get(`fileShortcuts:${ws.id}`, []).length;
      }
      const globalIcons = store.get('globalQuickIcons', []).length;

      return {
        success: true,
        fileSize,
        fileSizeFormatted,
        counts: {
          workspaces: workspaces.length,
          todos,
          links,
          fileShortcuts,
          globalIcons,
        },
      };
    } catch (err) {
      console.error('[DataStats] 统计失败:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerDataIpcHandlers };
