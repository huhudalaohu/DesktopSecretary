/**
 * FileNavigator.jsx — 文件导航模块
 *
 * 包含两个区域:
 *   1. 置顶区域 (Pinned): 横向小卡片，支持右键取消置顶、拖拽排序
 *   2. 最近访问 (Recent): 纵向列表，右键可置顶或删除记录
 *
 * 数据存储键:
 *   - pinnedFolders: [{id, path, alias}] — 置顶文件夹，最多 8 个
 *   - recentFolders: [{path, timestamp}] — 最近访问，最多 15 条
 */

import React, { useState, useEffect } from 'react';
import { Folder, Pin, PinOff, Trash2 } from 'lucide-react';

const api = window.desktopAPI;

/** 截取路径的最后两级目录用于显示 */
function truncatePath(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return p;
  return '.../' + parts.slice(-2).join('/');
}

/** 计算相对时间（几分钟前、几小时前等） */
function relativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

export default function FileNavigator({ activeWorkspace }) {
  const [pinned, setPinned] = useState([]);     // 置顶文件夹列表
  const [recent, setRecent] = useState([]);     // 最近访问列表
  const [contextMenu, setContextMenu] = useState(null); // 右键菜单 {x, y, type, item}

  // 存储键按工作区分隔
  const pinnedKey = `pinnedFolders:${activeWorkspace}`;
  const recentKey = `recentFolders:${activeWorkspace}`;

  // 加载数据（切换工作区时重新加载）
  useEffect(() => {
    api.storeGet(pinnedKey, []).then(setPinned);
    api.storeGet(recentKey, []).then(setRecent);
  }, [pinnedKey, recentKey]);

  // 打开文件夹并刷新最近访问
  const handleOpenFolder = async (folderPath) => {
    await api.openFolder(folderPath, recentKey);
    // 稍作延迟后刷新 recentFolders（主进程已写入）
    setTimeout(() => {
      api.storeGet(recentKey, []).then(setRecent);
    }, 300);
  };

  // 置顶文件夹
  const handlePin = async (folderPath) => {
    if (pinned.length >= 8) {
      api.showError('置顶已满', '最多只能置顶 8 个文件夹');
      return;
    }
    if (pinned.find((p) => p.path === folderPath)) return;

    const alias = folderPath.replace(/\\/g, '/').split('/').pop() || folderPath;
    const updated = [...pinned, { id: `pin-${Date.now()}`, path: folderPath, alias }];
    setPinned(updated);
    await api.storeSet(pinnedKey, updated);
    setContextMenu(null);
  };

  // 取消置顶
  const handleUnpin = async (id) => {
    const updated = pinned.filter((p) => p.id !== id);
    setPinned(updated);
    await api.storeSet(pinnedKey, updated);
    setContextMenu(null);
  };

  // 删除最近访问记录
  const handleRemoveRecent = async (folderPath) => {
    const updated = recent.filter((r) => r.path !== folderPath);
    setRecent(updated);
    await api.storeSet(recentKey, updated);
    setContextMenu(null);
  };

  // 置顶卡片拖拽排序
  const handleDragStart = (e, index) => {
    e.dataTransfer.setData('text/plain', index.toString());
  };

  const handleDrop = async (e, targetIndex) => {
    e.preventDefault();
    const sourceIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (sourceIndex === targetIndex) return;

    const updated = [...pinned];
    const [moved] = updated.splice(sourceIndex, 1);
    updated.splice(targetIndex, 0, moved);
    setPinned(updated);
    await api.storeSet(pinnedKey, updated);
  };

  // 关闭右键菜单
  const closeContextMenu = () => setContextMenu(null);

  return (
    <div onClick={closeContextMenu}>
      <div className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">文件导航</div>

      <div className="rounded-xl bg-white/5 border border-white/10 p-3">
        {/* ========== 置顶区域 ========== */}
      <div className="mb-3">
        <div className="text-[10px] text-white/30 uppercase tracking-wider mb-2">置顶</div>
        {pinned.length === 0 ? (
          <div className="text-xs text-white/20 py-2">右键文件夹可置顶到这里</div>
        ) : (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {pinned.map((item, index) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDrop(e, index)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, type: 'pinned', item });
                }}
                onClick={() => handleOpenFolder(item.path)}
                className="flex-shrink-0 w-[100px] h-[80px] rounded-xl bg-white/5 border border-white/10 flex flex-col items-center justify-center gap-1 cursor-pointer hover:bg-white/10 transition-colors"
              >
                <Folder size={20} className="text-blue-300" />
                <span className="text-[10px] text-white/70 truncate w-full text-center px-1">
                  {item.alias}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ========== 最近访问区域 ========== */}
      <div>
        <div className="text-[10px] text-white/30 uppercase tracking-wider mb-2">最近访问</div>
        {recent.length === 0 ? (
          <div className="text-xs text-white/20 py-2">通过本软件打开的文件夹会出现在这里</div>
        ) : (
          <div className="space-y-1">
            {recent.map((item) => (
              <div
                key={item.path}
                onClick={() => handleOpenFolder(item.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, type: 'recent', item });
                }}
                className="flex items-center gap-2 h-[48px] px-2 rounded-lg hover:bg-white/5 cursor-pointer transition-colors"
              >
                <Folder size={16} className="text-blue-300 flex-shrink-0" />
                <span className="text-xs text-white/60 truncate flex-1">
                  {truncatePath(item.path)}
                </span>
                <span className="text-[10px] text-white/25 flex-shrink-0">
                  {relativeTime(item.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ========== 右键菜单 ========== */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-slate-800/95 backdrop-blur border border-white/10 rounded-lg py-1 shadow-xl min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.type === 'pinned' && (
            <button
              onClick={() => handleUnpin(contextMenu.item.id)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
            >
              <PinOff size={12} /> 取消置顶
            </button>
          )}
          {contextMenu.type === 'recent' && (
            <>
              <button
                onClick={() => handlePin(contextMenu.item.path)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
              >
                <Pin size={12} /> 置顶到导航
              </button>
              <button
                onClick={() => handleRemoveRecent(contextMenu.item.path)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400/80 hover:bg-white/10"
              >
                <Trash2 size={12} /> 删除记录
              </button>
            </>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
