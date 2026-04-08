/**
 * App.jsx — 主布局组件
 *
 * 布局结构:
 *   ┌──────────────────────────┐
 *   │  WorkspaceSwitcher       │  ← 顶部工作区切换
 *   ├──────────────────────────┤
 *   │  FileNavigator           │  ← 置顶文件夹 + 最近访问
 *   ├──────────────────────────┤
 *   │  TodoList                │  ← 待办列表
 *   ├──────────────────────────┤
 *   │  AIAssistant             │  ← AI 助手卡片
 *   └──────────────────────────┘
 *
 * 毛玻璃容器: bg-slate-900/80 + backdrop-blur(20px)
 */

import React, { useState, useEffect } from 'react';
import WorkspaceSwitcher from './components/WorkspaceSwitcher';
import FileNavigator from './components/FileNavigator';
import TodoList from './components/TodoList';
import AIAssistant from './components/AIAssistant';
import { X } from 'lucide-react';

const api = window.desktopAPI;

export default function App() {
  // 当前选中的工作区 ID
  const [activeWorkspace, setActiveWorkspace] = useState('project-a');
  // 工作区列表
  const [workspaces, setWorkspaces] = useState([]);

  // 启动时从 electron-store 加载工作区列表
  useEffect(() => {
    api.storeGet('workspaces', []).then((ws) => {
      if (ws.length > 0) {
        setWorkspaces(ws);
        setActiveWorkspace(ws[0].id);
      }
    });
  }, []);

  // 添加新工作区
  const addWorkspace = async (name) => {
    const id = `ws-${Date.now()}`;
    const updated = [...workspaces, { id, name }];
    setWorkspaces(updated);
    setActiveWorkspace(id);
    await api.storeSet('workspaces', updated);
  };

  return (
    // 毛玻璃外层容器
    <div className="h-full flex flex-col bg-slate-900/80 backdrop-blur-[20px] rounded-2xl border border-white/10 overflow-hidden">
      {/* 标题栏区域 */}
      <div className="flex items-center justify-between px-4 py-2 drag-region">
        <span className="text-sm font-medium text-white/70">DesktopSecretary</span>
        <button
          onClick={() => api.closeApp()}
          className="p-1 rounded hover:bg-white/10 transition-colors text-white/50 hover:text-white"
        >
          <X size={14} />
        </button>
      </div>

      {/* 工作区切换 */}
      <div className="px-4 pb-2">
        <WorkspaceSwitcher
          workspaces={workspaces}
          active={activeWorkspace}
          onSwitch={setActiveWorkspace}
          onAdd={addWorkspace}
        />
      </div>

      {/* 模块区域 — 可滚动 */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
        {/* 文件导航 */}
        <FileNavigator activeWorkspace={activeWorkspace} />

        {/* 待办列表 */}
        <TodoList activeWorkspace={activeWorkspace} />

        {/* AI 助手 */}
        <AIAssistant />
      </div>
    </div>
  );
}
