/**
 * App.jsx — 主布局组件
 *
 * 布局结构:
 *   ┌──────────────────────────┐
 *   │  TodoList                │  ← 最高级别，全局待办（不随工作区切换）
 *   ├──────────────────────────┤
 *   │  WorkspaceSwitcher       │  ← 工作区切换
 *   ├──────────────────────────┤
 *   │  QuickLinks / FileNav /  │  ← 可滚动模块区域
 *   │  AIAssistant             │
 *   └──────────────────────────┘
 *
 * 毛玻璃容器: bg-slate-900/80 + backdrop-blur(20px)
 */

import React, { useState, useEffect, useCallback } from 'react';
import WorkspaceSwitcher from './components/WorkspaceSwitcher';
import FileNavigator from './components/FileNavigator';
import TodoList from './components/TodoList';
import AIAssistant from './components/AIAssistant';
import QuickLinks from './components/QuickLinks';
import { X, Pin, PinOff } from 'lucide-react';

const api = window.desktopAPI;

export default function App() {
  const [activeWorkspace, setActiveWorkspace] = useState('project-a');
  const [workspaces, setWorkspaces] = useState([]);
  // 宽度百分比（占屏幕宽度），默认 20%
  const [widthPercent, setWidthPercent] = useState(20);
  // Dock 锁定状态
  const [docked, setDocked] = useState(true);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    api.storeGet('workspaces', []).then((ws) => {
      if (ws.length > 0) {
        setWorkspaces(ws);
        setActiveWorkspace(ws[0].id);
      }
    });
    // 加载保存的宽度百分比
    api.storeGet('windowWidthPercent', 20).then((pct) => {
      setWidthPercent(pct);
    });

    // 监听 Dock 状态变化
    const cleanup = api.onDockStateChanged((data) => {
      setDocked(data.expanded);
    });
    return cleanup;
  }, []);

  // 切换图钉锁定
  const handleTogglePin = useCallback(async () => {
    const result = await api.dockTogglePin();
    setPinned(result.pinned);
  }, []);

  const addWorkspace = async (name) => {
    const id = `ws-${Date.now()}`;
    const updated = [...workspaces, { id, name }];
    setWorkspaces(updated);
    setActiveWorkspace(id);
    await api.storeSet('workspaces', updated);
  };

  const deleteWorkspace = async (id) => {
    if (workspaces.length <= 1) return; // 至少保留一个
    const updated = workspaces.filter((ws) => ws.id !== id);
    setWorkspaces(updated);
    // 如果删除的是当前激活的工作区，切换到第一个
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

  const reorderWorkspaces = async (fromIndex, toIndex) => {
    const updated = [...workspaces];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    setWorkspaces(updated);
    await api.storeSet('workspaces', updated);
  };

  const applyWidth = useCallback(async (pct) => {
    const screenW = window.screen.width;
    const pixelWidth = Math.round(screenW * pct / 100);
    await api.resizeWindow(pixelWidth);
  }, []);

  const handleWidthChange = useCallback(async (e) => {
    const pct = parseInt(e.target.value, 10);
    setWidthPercent(pct);
    await api.storeSet('windowWidthPercent', pct);
    applyWidth(pct);
  }, [applyWidth]);

  return (
    <div
      className="h-full flex flex-col bg-slate-900/60 backdrop-blur-[24px] rounded-2xl border border-white/10 overflow-hidden"
    >
      {/* 标题栏区域 */}
      <div className="flex items-center justify-between px-4 py-2 drag-region">
        <span className="text-sm font-medium text-white/70">DesktopSecretary</span>
        <div className="flex items-center gap-1">
          {/* 图钉按钮 */}
          <button
            onClick={handleTogglePin}
            className={`p-1 rounded transition-colors ${
              pinned
                ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                : 'hover:bg-white/10 text-white/30 hover:text-white/60'
            }`}
            title={pinned ? '取消固定' : '固定窗口'}
          >
            {pinned ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
          <button
            onClick={() => api.closeApp()}
            className="p-1 rounded hover:bg-white/10 transition-colors text-white/50 hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* 待办列表 — 最高级别，固定在顶部，不受工作区切换影响 */}
      <div className="px-4 pb-2 border-b border-white/10">
        <TodoList />
      </div>

      {/* 工作区切换 */}
      <div className="px-4 py-2">
        <WorkspaceSwitcher
          workspaces={workspaces}
          active={activeWorkspace}
          onSwitch={setActiveWorkspace}
          onAdd={addWorkspace}
          onDelete={deleteWorkspace}
          onReorder={reorderWorkspaces}
          onRename={renameWorkspace}
        />
      </div>

      {/* 模块区域 — 可滚动 */}
      <div
        className="flex-1 overflow-y-auto px-4 pb-4 space-y-4"
      >
        {/* 快速入口 */}
        <QuickLinks activeWorkspace={activeWorkspace} />

        {/* 文件导航 */}
        <FileNavigator activeWorkspace={activeWorkspace} />

        {/* AI 助手 */}
        <AIAssistant />
      </div>

      {/* 底部宽度调节条 */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-t border-white/5">
        <span className="text-[10px] text-white/25 flex-shrink-0">宽度</span>
        <input
          type="range"
          min="15"
          max="35"
          value={widthPercent}
          onChange={handleWidthChange}
          className="flex-1 h-1 appearance-none bg-white/10 rounded-full cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/50
            [&::-webkit-slider-thumb]:hover:bg-white/70 [&::-webkit-slider-thumb]:transition-colors"
        />
        <span className="text-[10px] text-white/35 flex-shrink-0 w-8 text-right">{widthPercent}%</span>
      </div>
    </div>
  );
}
