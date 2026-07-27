/**
 * App.jsx — 主布局组件
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import WorkspaceSwitcher from './features/workspace/components/WorkspaceSwitcher';
import FileNavigator from './features/files/components/FileNavigator';
import QuickNote from './features/files/components/QuickNote';
import TodoList from './features/workspace/components/TodoList';
import AIAssistant from './features/ai/components/AIAssistant';
import QuickLinks from './features/files/components/QuickLinks';
import Timeline from './features/reminders/components/Timeline';
import SettingsPanel from './features/settings/components/SettingsPanel';
import RechargeModal from './features/credits/RechargeModal';
import OnboardingTutorial from './features/onboarding/OnboardingTutorial';
import { DEFAULT_REMINDER_LEVELS } from './features/reminders/components/ReminderLevelSettings';
import { DEFAULT_AI_SETTINGS } from './config/ai-config';
import { DEFAULT_MODULE_VISIBILITY, normalizeModuleVisibility } from './config/module-visibility';
import { X, Pin, PinOff, Settings, HelpCircle } from 'lucide-react';
import {
  DndContext,
  useSensor,
  useSensors,
  pointerWithin,
  closestCenter,
} from '@dnd-kit/core';
import { SmartPointerSensor } from './utils/dnd-sensors';
import { formatTokens } from './utils/format';
import { useScreenshotAI, SCREENSHOT_STATUS, DAILY_LIMIT } from './hooks/useScreenshotAI';
import { useSettings } from './hooks/useSettings';
import { useTrash } from './hooks/useTrash';
import { useAutoUpdate } from './hooks/useAutoUpdate';

const api = window.desktopAPI;

export default function App() {
  const [activeWorkspace, setActiveWorkspace] = useState('project-a');
  const [workspaces, setWorkspaces] = useState([]);
  const [docked, setDocked] = useState(true);
  const [pinned, setPinned] = useState(false);
  const [snapHintEdge, setSnapHintEdge] = useState(null);
  const [reminderLevels, setReminderLevels] = useState(DEFAULT_REMINDER_LEVELS);
  const [moduleVisibility, setModuleVisibility] = useState(DEFAULT_MODULE_VISIBILITY);

  // 数据管理
  const [dataStats, setDataStats] = useState(null);
  const [dataActionMsg, setDataActionMsg] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  // 充值弹窗(放在根级避免被设置面板的 overflow 裁剪)
  const [rechargeOpen, setRechargeOpen] = useState(false);

  // 新手教程(首次启动自动弹出,之后从左下角「教程」按钮打开)
  const [tourOpen, setTourOpen] = useState(false);

  // ========== Hooks ==========
  const settings = useSettings(api);
  const {
    screenshot,
    screenshotStatus,
    statusMessage,
    aiResult,
    tokenStats,
    focusTodoId,
    setFocusTodoId,
    handleScreenshotAndAnalyze,
  } = useScreenshotAI(api, settings.aiSettings);

  const {
    updateStatus,
    updateInfo,
    handleCheckUpdate,
    handleDownloadUpdate,
    handleInstallUpdate,
  } = useAutoUpdate(api);

  const trash = useTrash(api, workspaces, setWorkspaces);

  // ========== 工作区操作 ==========
  const addWorkspace = async (name) => {
    const id = `ws-${Date.now()}`;
    const updated = [...workspaces, { id, name }];
    setWorkspaces(updated);
    setActiveWorkspace(id);
    await api.storeSet('workspaces', updated);
  };

  const deleteWorkspace = async (id) => {
    if (workspaces.length <= 1) return;
    const wsToTrash = workspaces.find((ws) => ws.id === id);
    if (wsToTrash) {
      const trashed = await api.storeGet('trashedWorkspaces', []);
      const newTrashed = [{ ...wsToTrash, trashedAt: Date.now() }, ...trashed];
      await api.storeSet('trashedWorkspaces', newTrashed);
      trash.setTrashedWorkspaces(newTrashed);
    }
    const updated = workspaces.filter((ws) => ws.id !== id);
    setWorkspaces(updated);
    if (activeWorkspace === id) {
      setActiveWorkspace(updated[0].id);
    }
    await api.storeSet('workspaces', updated);
  };

  const renameWorkspace = async (id, newName) => {
    const updated = workspaces.map((ws) => ws.id === id ? { ...ws, name: newName } : ws);
    setWorkspaces(updated);
    await api.storeSet('workspaces', updated);
  };

  const duplicateWorkspace = async (id) => {
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return;

    const newId = `ws-${Date.now()}`;
    const newName = `${ws.name} 副本`;
    const updatedWorkspaces = [...workspaces, { id: newId, name: newName }];
    setWorkspaces(updatedWorkspaces);
    setActiveWorkspace(newId);
    await api.storeSet('workspaces', updatedWorkspaces);

    const wsLinks = await api.storeGet(`quickLinks:${id}`, {});
    if (wsLinks && Object.keys(wsLinks).length > 0) {
      await api.storeSet(`quickLinks:${newId}`, JSON.parse(JSON.stringify(wsLinks)));
    }

    const wsFileShortcuts = await api.storeGet(`fileShortcuts:${id}`, []);
    if (wsFileShortcuts.length > 0) {
      await api.storeSet(`fileShortcuts:${newId}`, JSON.parse(JSON.stringify(wsFileShortcuts)));
    }
  };

  const reorderWorkspaces = async (fromIndex, toIndex) => {
    const updated = [...workspaces];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    setWorkspaces(updated);
    await api.storeSet('workspaces', updated);
  };

  // ========== 数据导出/导入 ==========
  const handleExportData = async () => {
    setExporting(true);
    setDataActionMsg(null);
    let msgType = null;
    try {
      const result = await api.exportData();
      if (result.success) {
        msgType = 'success';
        setDataActionMsg({
          type: 'success',
          text: `导出成功: ${result.excelPath?.split?.(/[\\/]/)?.pop?.() || ''} + 备份.json`,
        });
        const stats = await api.getDataStats();
        if (stats?.success) setDataStats(stats);
      } else if (result.cancelled) {
        // 用户取消
      } else {
        msgType = 'error';
        setDataActionMsg({ type: 'error', text: `导出失败: ${result.error}` });
      }
    } catch (err) {
      msgType = 'error';
      setDataActionMsg({ type: 'error', text: `导出失败: ${err?.message || '未知错误'}` });
    } finally {
      setExporting(false);
      if (msgType !== 'success') {
        setTimeout(() => setDataActionMsg(null), 3000);
      }
    }
  };

  const handleImportData = async () => {
    setImporting(true);
    setDataActionMsg(null);
    let msgType = null;
    try {
      const result = await api.importData();
      if (result.success) {
        msgType = 'success';
        setDataActionMsg({ type: 'success', text: result.message || '数据已恢复' });
        const stats = await api.getDataStats();
        if (stats?.success) setDataStats(stats);
      } else if (result.cancelled) {
        // 用户取消
      } else {
        msgType = 'error';
        setDataActionMsg({ type: 'error', text: `导入失败: ${result.error}` });
      }
    } catch (err) {
      msgType = 'error';
      setDataActionMsg({ type: 'error', text: `导入失败: ${err?.message || '未知错误'}` });
    } finally {
      setImporting(false);
      if (msgType !== 'success') {
        setTimeout(() => setDataActionMsg(null), 3000);
      }
    }
  };

  // ========== 数据加载 & 事件监听 ==========
  const reloadAllData = useCallback(() => {
    api.storeGet('workspaces', []).then((ws) => {
      if (ws && ws.length > 0) {
        setWorkspaces(ws);
        setActiveWorkspace(ws[0].id);
      } else {
        setWorkspaces([]);
        setActiveWorkspace(null);
      }
    });
    api.storeGet('reminderLevels', null).then((saved) => {
      if (saved && Array.isArray(saved) && saved.length > 0) {
        setReminderLevels(saved);
      }
    });
    api.storeGet('trashedWorkspaces', []).then((saved) => trash.setTrashedWorkspaces(saved || []));
    api.storeGet('trashedTodos', []).then((saved) => trash.setTrashedTodos(saved || []));
  }, [api]);

  useEffect(() => {
    reloadAllData();

    api.storeGet('aiSettings', DEFAULT_AI_SETTINGS).then((saved) => {
      const merged = { ...DEFAULT_AI_SETTINGS, ...saved };
      settings.setAiSettings(merged);
      settings.setShortcutInput(merged.shortcutKey || 'CmdOrCtrl+Shift+A');
    });

    api.storeGet('pinShortcutKey', '').then((saved) => {
      settings.setPinShortcutInput(saved || '');
    });

    api.getAutoLaunch().then((enabled) => settings.setAutoLaunch(!!enabled));

    api.storeGet('fontScale', 1.0).then((saved) => {
      const scale = typeof saved === 'number' ? saved : 1.0;
      settings.setFontScale(scale);
    });

    api.storeGet('moduleVisibility', DEFAULT_MODULE_VISIBILITY).then((saved) => {
      setModuleVisibility(normalizeModuleVisibility(saved));
    });

    // 监听回收站变化
    const onTrashUpdated = () => {
      api.storeGet('trashedWorkspaces', []).then((saved) => trash.setTrashedWorkspaces(saved || []));
      api.storeGet('trashedTodos', []).then((saved) => trash.setTrashedTodos(saved || []));
    };
    window.addEventListener('trash-updated', onTrashUpdated);

    const cleanupProfile = api.onProfileSwitched?.(() => {
      reloadAllData();
    }) || (() => {});

    api.getDataStats().then((stats) => {
      if (stats?.success) setDataStats(stats);
    });

    // 拉取当前 Dock 状态
    api.dockGetState?.().then((s) => {
      if (!s) return;
      setDocked(!!s.expanded);
      setPinned(!!s.pinned);
    });

    const cleanupState = api.onDockStateChanged((data) => {
      setDocked(data.expanded);
      if (data.pinned !== undefined) setPinned(data.pinned);
    });
    const cleanupHint = api.onDockSnapHint?.((data) => {
      setSnapHintEdge(data?.edge ?? null);
    }) || (() => {});

    return () => {
      window.removeEventListener('trash-updated', onTrashUpdated);
      cleanupProfile();
      cleanupState();
      cleanupHint();
    };
  }, [reloadAllData]);

  // 首次启动:未看过教程则自动弹出
  useEffect(() => {
    api.storeGet('onboardingDone', false).then((done) => {
      if (!done) setTourOpen(true);
    }).catch(() => {});
  }, []);

  // ========== Dock 操作 ==========
  const handleTogglePin = useCallback(async () => {
    const result = await api.dockTogglePin();
    setPinned(result.pinned);
  }, []);

  const handleModuleVisibilityChange = async (moduleId, visible) => {
    const previous = moduleVisibility;
    const next = { ...moduleVisibility, [moduleId]: visible };
    setModuleVisibility(next);
    try {
      await api.storeSet('moduleVisibility', next);
    } catch (err) {
      console.error('保存模块显示设置失败:', err);
      setModuleVisibility(previous);
    }
  };

  useEffect(() => {
    const cleanup = api.onPinShortcutTriggered(() => {
      handleTogglePin();
    });
    return cleanup;
  }, [handleTogglePin]);

  // ========== DnD ==========
  const dndSensors = useSensors(
    useSensor(SmartPointerSensor, { activationConstraint: { distance: 5 } })
  );

  return (
    <div className="h-full flex flex-col rounded-lg overflow-hidden relative">
      {/* 标题栏 */}
      <div className="flex items-center justify-end px-4 py-2 drag-region">
        <div className="flex items-center gap-1" data-tour="titlebar-btns">
          <button
            onClick={handleTogglePin}
            className={`p-1 rounded-fluent transition-colors ${
              pinned
                ? 'bg-fluent-accent-light text-fluent-accent hover:bg-fluent-fill-hover'
                : 'text-fluent-text-tertiary hover:text-fluent-text-secondary hover:bg-fluent-fill-hover'
            }`}
            title={pinned ? '取消固定' : '固定窗口'}
          >
            {pinned ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
          <button
            onClick={() => api.closeApp()}
            className="p-1 rounded-fluent transition-colors text-fluent-text-tertiary hover:bg-fluent-danger hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* 字号缩放区域 */}
      <div style={{ zoom: settings.fontScale }} className="flex-1 flex flex-col overflow-hidden">
        {snapHintEdge && (
          <div className={`snap-hint snap-hint--${snapHintEdge}`} aria-hidden="true" />
        )}

        <DndContext
          sensors={dndSensors}
          collisionDetection={(args) => {
            const pointer = pointerWithin(args);
            return pointer.length > 0 ? pointer : closestCenter(args);
          }}
          onDragEnd={(event) => {
            const { active, over } = event;
            delete window.__draggingWorkspace;
            if (!over) return;

            const wsOverIndex = workspaces.findIndex((w) => w.id === over.id);
            const wsActiveIndex = workspaces.findIndex((w) => w.id === active.id);
            if (wsOverIndex !== -1 && wsActiveIndex !== -1 && wsOverIndex !== wsActiveIndex) {
              reorderWorkspaces(wsActiveIndex, wsOverIndex);
              return;
            }

            if (over.id.startsWith('todo-')) {
              const todoId = over.id.slice(5);
              const ws = workspaces.find((w) => w.id === active.id);
              if (ws && todoId) {
                window.dispatchEvent(new CustomEvent('bind-workspace', {
                  detail: { todoId, workspaceId: ws.id },
                }));
              }
            }
          }}
        >
          {moduleVisibility.todos && (
            <div className="px-4 pb-2">
              <TodoList
                workspaces={workspaces}
                activeWorkspace={activeWorkspace}
                onSwitchWorkspace={setActiveWorkspace}
                onScreenshot={handleScreenshotAndAnalyze}
                screenshotStatus={screenshotStatus}
                reminderLevels={reminderLevels}
                focusTodoId={focusTodoId}
              />
            </div>
          )}

          {moduleVisibility.workspaces && (
            <WorkspaceSwitcher
              workspaces={workspaces}
              active={activeWorkspace}
              onSwitch={setActiveWorkspace}
              onAdd={addWorkspace}
              onDelete={deleteWorkspace}
              onReorder={reorderWorkspaces}
              onRename={renameWorkspace}
              onDuplicate={duplicateWorkspace}
            />
          )}
        </DndContext>

        {/* 白色页面容器：与标签条底边齐平相接，激活标签融入页面 */}
        <div className="flex-1 flex flex-col overflow-hidden bg-fluent-surface-solid pt-2">
          {moduleVisibility.timeline && (
            <Timeline
              activeWorkspace={activeWorkspace}
              reminderLevels={reminderLevels}
              onFocusTodo={setFocusTodoId}
            />
          )}

          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-6">
          {moduleVisibility.quickLinks && <QuickLinks activeWorkspace={activeWorkspace} />}
          {moduleVisibility.fileNavigator && <FileNavigator activeWorkspace={activeWorkspace} />}
          {moduleVisibility.quickNote && <QuickNote />}
          {moduleVisibility.aiAssistant && (
            <AIAssistant
              settings={settings.aiSettings}
              screenshot={screenshot}
              screenshotStatus={screenshotStatus}
              statusMessage={statusMessage}
              aiResult={aiResult}
              tokenStats={tokenStats}
              formatTokens={formatTokens}
              dailyLimit={DAILY_LIMIT}
            />
          )}
          </div>
        </div>

        {/* 设置面板 */}
        {settings.showSettings && (
          <SettingsPanel
            panelRef={settings.settingsPanelRef}
            fontScale={settings.fontScale}
            setFontScale={settings.setFontScale}
            aiSettings={settings.aiSettings}
            setAiSettings={settings.setAiSettings}
            editingShortcut={settings.editingShortcut}
            setEditingShortcut={settings.setEditingShortcut}
            shortcutInput={settings.shortcutInput}
            setShortcutInput={settings.setShortcutInput}
            editingPinShortcut={settings.editingPinShortcut}
            setEditingPinShortcut={settings.setEditingPinShortcut}
            pinShortcutInput={settings.pinShortcutInput}
            setPinShortcutInput={settings.setPinShortcutInput}
            testing={settings.testing}
            textTesting={settings.textTesting}
            testResult={settings.testResult}
            textTestResult={settings.textTestResult}
            settingsSaveMsg={settings.settingsSaveMsg}
            autoLaunch={settings.autoLaunch}
            setAutoLaunch={settings.setAutoLaunch}
            moduleVisibility={moduleVisibility}
            onModuleVisibilityChange={handleModuleVisibilityChange}
            reminderLevels={reminderLevels}
            setReminderLevels={setReminderLevels}
            dataStats={dataStats}
            dataActionMsg={dataActionMsg}
            exporting={exporting}
            importing={importing}
            trashedWorkspaces={trash.trashedWorkspaces}
            trashedTodos={trash.trashedTodos}
            updateStatus={updateStatus}
            updateInfo={updateInfo}
            handleSaveSettings={settings.handleSaveSettings}
            handleSaveShortcut={settings.handleSaveShortcut}
            handleSavePinShortcut={settings.handleSavePinShortcut}
            handleTestConnection={settings.handleTestConnection}
            handleTextTest={settings.handleTextTest}
            handleExportData={handleExportData}
            handleImportData={handleImportData}
            restoreWorkspace={trash.restoreWorkspace}
            restoreTodo={trash.restoreTodo}
            permanentlyDeleteWorkspace={trash.permanentlyDeleteWorkspace}
            permanentlyDeleteTodo={trash.permanentlyDeleteTodo}
            clearTrash={trash.clearTrash}
            handleCheckUpdate={handleCheckUpdate}
            handleDownloadUpdate={handleDownloadUpdate}
            handleInstallUpdate={handleInstallUpdate}
            api={api}
            onOpenRecharge={() => setRechargeOpen(true)}
          />
        )}

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between px-4 py-1.5 border-t border-fluent-stroke-divider gap-1">
          <button
            onClick={() => setTourOpen(true)}
            className="flex items-center px-1.5 py-1 rounded-fluent transition-colors text-fluent-text-tertiary hover:text-fluent-text-secondary hover:bg-fluent-fill-hover"
            title="新手教程"
          >
            <HelpCircle size={14} />
            <span className="text-[12px] font-normal text-fluent-text-tertiary ml-0.5">教程</span>
          </button>
          <button
            ref={settings.settingsButtonRef}
            data-tour="settings-btn"
            onClick={() => settings.setShowSettings(!settings.showSettings)}
            className={`flex items-center px-1.5 py-1 rounded-fluent transition-colors ${
              settings.showSettings ? 'bg-fluent-accent-light text-fluent-accent' : 'text-fluent-text-tertiary hover:text-fluent-text-secondary hover:bg-fluent-fill-hover'
            }`}
            title="设置"
          >
            <Settings size={14} />
            <span className="text-[12px] font-normal text-fluent-text-tertiary ml-0.5">设置</span>
          </button>
        </div>
      </div>{/* /字号缩放区域 */}

      {/* 新手教程 */}
      {tourOpen && (
        <OnboardingTutorial onClose={() => setTourOpen(false)} />
      )}

      {/* 充值弹窗:渲染在 zoom 容器外,避免被缩放和被设置面板 overflow 裁剪 */}
      {rechargeOpen && (
        <RechargeModal onClose={() => setRechargeOpen(false)} />
      )}
    </div>
  );
}
