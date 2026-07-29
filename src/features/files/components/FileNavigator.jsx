/**
 * FileNavigator.jsx — 文件导航模块
 *
 * 支持从系统文件资源管理器拖拽文件、文件夹或应用快捷方式建立快捷入口。
 * 提供两种视图：大图标和详细信息列表。
 */

import React, { useState, useEffect, useRef } from 'react';

import { LayoutGrid, List, Trash2 } from 'lucide-react';
import FileTypeIcon, { getFileKind } from './FileTypeIcon';
import FolderCascadeMenu from './FolderCascadeMenu';
import { measureVisualRect } from '../../../utils/measureVisualRect';

const api = window.desktopAPI;

// ========== Tooltip 工具 ==========
function useOverflowTooltip() {
  const [tooltip, setTooltip] = useState({ show: false, text: '', x: 0, y: 0 });
  const tooltipTimer = useRef(null);
  const textRefs = useRef(new Map());

  const bindRef = (id) => (el) => {
    if (el) textRefs.current.set(id, el);
  };

  const handleEnter = (id, text) => (e) => {
    const el = textRefs.current.get(id);
    if (el && el.scrollWidth > el.clientWidth) {
      if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
      tooltipTimer.current = setTimeout(() => {
        const rect = el.getBoundingClientRect();
        setTooltip({
          show: true,
          text,
          x: rect.left + rect.width / 2,
          y: rect.top - 4,
        });
      }, 300);
    }
  };

  const handleLeave = () => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    setTooltip((prev) => ({ ...prev, show: false }));
  };

  const TooltipNode = tooltip.show ? (
    <div
      className="fixed z-50 px-2 py-1 text-[12px] font-normal text-fluent-text-primary bg-fluent-surface-flyout border border-fluent-stroke-card rounded-fluent shadow-fluent-flyout pointer-events-none whitespace-nowrap"
      style={{
        left: tooltip.x,
        top: tooltip.y,
        transform: 'translate(-50%, -100%)',
      }}
    >
      {tooltip.text}
      <div className="absolute left-1/2 top-full -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-fluent-surface-flyout" />
    </div>
  ) : null;

  return { bindRef, handleEnter, handleLeave, TooltipNode };
}

/** 截取路径的最后两级目录用于显示 */
function truncatePath(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return p;
  return '.../' + parts.slice(-2).join('/');
}

export default function FileNavigator({ activeWorkspace }) {
  const storeKey = `fileShortcuts:${activeWorkspace}`;
  const viewKey = `fileShortcutViewMode`;

  const [shortcuts, setShortcuts] = useState([]);
  const [viewMode, setViewMode] = useState('icons'); // icons | details
  const [dropHighlight, setDropHighlight] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, item }
  const [draggingIndex, setDraggingIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const dragSourceIndexRef = useRef(null);

  // 多级级联浏览
  const [cascadeEnabled, setCascadeEnabled] = useState(true);
  const [cascade, setCascade] = useState(null); // { itemId, path, anchorEl }
  const itemRefs = useRef(new Map());
  const hoverTimerRef = useRef(null);
  const closeTimerRef = useRef(null);

  const bindItemRef = (id) => (el) => {
    if (el) itemRefs.current.set(id, el);
  };

  const clearCascadeTimers = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  };

  const closeCascade = () => {
    clearCascadeTimers();
    setCascade(null);
  };

  const handleItemEnter = (item) => {
    if (!cascadeEnabled || draggingIndex !== null) return;
    if (getFileKind(item.path) !== 'folder') return;
    clearCascadeTimers();
    hoverTimerRef.current = setTimeout(() => {
      const el = itemRefs.current.get(item.id);
      if (el) setCascade({ itemId: item.id, path: item.path, anchorEl: el });
    }, 300);
  };

  const handleItemLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (cascade) {
      // 留 150ms 宽限让鼠标移进弹窗(hover 桥)
      closeTimerRef.current = setTimeout(() => setCascade(null), 150);
    }
  };

  const handleMenuHover = (inside) => {
    if (inside) {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    } else {
      closeCascade();
    }
  };

  const handleCascadeOpen = (path) => {
    closeCascade();
    handleOpenFolder(path);
  };

  const handleCascadeToggle = async () => {
    const next = !cascadeEnabled;
    setCascadeEnabled(next);
    if (!next) closeCascade();
    await api.storeSet('fileNavCascadeEnabled', next);
  };

  // 内容滚动时关闭弹窗,避免定位漂移(级联菜单自身的滚动除外)
  useEffect(() => {
    if (!cascade) return;
    const onScroll = (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-cascade-menu]')) return;
      closeCascade();
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!cascade]);

  const tooltip = useOverflowTooltip();

  // 加载数据 + 一次性迁移旧数据
  useEffect(() => {
    (async () => {
      // 视图模式
      const savedView = await api.storeGet(viewKey, 'icons');
      setViewMode(['icons', 'details'].includes(savedView) ? savedView : 'icons');

      // 多级浏览开关(默认开)
      const savedCascade = await api.storeGet('fileNavCascadeEnabled', true);
      setCascadeEnabled(savedCascade !== false);

      // 新键
      let data = await api.storeGet(storeKey, null);

      // 迁移旧置顶数据（只迁一次）
      if (data === null) {
        const oldPinned = await api.storeGet(`pinnedFolders:${activeWorkspace}`, []);
        if (oldPinned && oldPinned.length > 0) {
          data = oldPinned.map((p) => ({
            id: p.id || `fs-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            path: p.path,
            name: p.alias || p.path.replace(/\\/g, '/').split('/').pop() || p.path,
            addedAt: new Date().toISOString().slice(0, 10),
          }));
          await api.storeSet(storeKey, data);
        } else {
          data = [];
        }
      }
      setShortcuts(data || []);
    })();
  }, [storeKey]);

  const saveShortcuts = async (updated) => {
    setShortcuts(updated);
    await api.storeSet(storeKey, updated);
  };

  const handleOpenFolder = async (folderPath) => {
    await api.openFolder(folderPath);
  };

  const handleDelete = async (id) => {
    const updated = shortcuts.filter((s) => s.id !== id);
    await saveShortcuts(updated);
    setContextMenu(null);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropHighlight(true);
  };

  const handleDragLeave = () => {
    setDropHighlight(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHighlight(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const added = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let path = '';
      try {
        if (api && api.getFilePath) {
          path = api.getFilePath(file);
        }
      } catch {}
      if (!path) continue;

      if (shortcuts.find((s) => s.path === path) || added.find((a) => a.path === path)) continue;

      const name = path.replace(/\\/g, '/').split('/').pop() || path;
      added.push({
        id: `fs-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        path,
        name,
        addedAt: new Date().toISOString().slice(0, 10),
      });
    }

    if (added.length > 0) {
      await saveShortcuts([...shortcuts, ...added]);
    }
  };

  const handleViewChange = async (mode) => {
    setViewMode(mode);
    await api.storeSet(viewKey, mode);
  };

  // 图标视图拖拽排序
  const handleDragStart = (e, index) => {
    e.dataTransfer.setData('text/plain', index.toString());
    e.dataTransfer.effectAllowed = 'move';
    dragSourceIndexRef.current = index;
    setDraggingIndex(index);
  };

  const handleDragEnd = () => {
    // 不在此处清空 ref，防止 drop 事件在 dragend 之后触发时丢失 sourceIndex
    setDraggingIndex(null);
    setDragOverIndex(null);
  };

  const isInternalDrag = (e) =>
    dragSourceIndexRef.current !== null || e.dataTransfer.types.includes('text/plain');

  const handleDragOverReorder = (e, index) => {
    if (!isInternalDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  };

  const handleDragLeaveReorder = () => {
    setDragOverIndex(null);
  };

  const handleDropReorder = async (e, targetIndex) => {
    const sourceIndex = dragSourceIndexRef.current !== null
      ? dragSourceIndexRef.current
      : parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (Number.isNaN(sourceIndex) || sourceIndex === null) {
      // 外部拖入，交给容器层的 handleDrop 处理
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    dragSourceIndexRef.current = null;
    setDraggingIndex(null);
    setDragOverIndex(null);
    const insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    if (sourceIndex === insertIndex) return;
    const updated = [...shortcuts];
    const [moved] = updated.splice(sourceIndex, 1);
    updated.splice(insertIndex, 0, moved);
    await saveShortcuts(updated);
  };

  const closeContextMenu = () => setContextMenu(null);

  return (
    <div onClick={closeContextMenu}>
      {/* 标题栏 + 视图切换 */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[15px] font-semibold text-fluent-text-primary">文件导航</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCascadeToggle}
            className={`relative w-7 h-4 rounded-full transition-colors mr-1 ${
              cascadeEnabled
                ? 'bg-fluent-accent'
                : 'bg-fluent-fill-hover border border-fluent-stroke-control'
            }`}
            title={cascadeEnabled ? '关闭悬停浏览文件夹' : '开启悬停浏览文件夹'}
          >
            <span
              className={`absolute top-[2px] w-3 h-3 rounded-full bg-white shadow transition-all ${
                cascadeEnabled ? 'left-[14px]' : 'left-[2px]'
              }`}
            />
          </button>
          <button
            onClick={() => handleViewChange('icons')}
            className={`icon-btn ${
              viewMode === 'icons'
                ? 'bg-fluent-accent-light text-fluent-accent hover:bg-fluent-accent-light hover:text-fluent-accent'
                : ''
            }`}
            title="大图标"
          >
            <LayoutGrid size={14} />
          </button>
          <button
            onClick={() => handleViewChange('details')}
            className={`icon-btn ${
              viewMode === 'details'
                ? 'bg-fluent-accent-light text-fluent-accent hover:bg-fluent-accent-light hover:text-fluent-accent'
                : ''
            }`}
            title="详细信息"
          >
            <List size={14} />
          </button>
        </div>
      </div>

      {/* 内容区域（拖拽接收区） */}
      <div
        data-tour="file-nav"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`rounded-fluent-lg border p-3 transition-colors ${
          dropHighlight
            ? 'bg-fluent-accent-light border-fluent-accent-border'
            : 'bg-fluent-surface-card border-fluent-stroke-card'
        } shadow-fluent-card`}
      >
        {shortcuts.length === 0 ? (
          <div className="text-[12px] font-normal text-fluent-text-tertiary py-4 text-center">
            从文件资源管理器拖拽文件、文件夹或快捷方式到此处添加
          </div>
        ) : viewMode === 'icons' ? (
          <div className="grid grid-cols-4 gap-2">
            {shortcuts.map((item, index) => (
              <div
                key={item.id}
                ref={bindItemRef(item.id)}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOverReorder(e, index)}
                onDragLeave={handleDragLeaveReorder}
                onDrop={(e) => handleDropReorder(e, index)}
                onDoubleClick={() => handleOpenFolder(item.path)}
                onMouseEnter={() => handleItemEnter(item)}
                onMouseLeave={handleItemLeave}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, item });
                }}
                className={`relative flex flex-col items-center justify-center gap-1 rounded-fluent-lg border p-2 cursor-pointer transition-all ${
                  draggingIndex === index
                    ? 'opacity-40 bg-fluent-fill-hover border-dashed border-fluent-stroke-control'
                    : 'bg-fluent-surface-solid border-fluent-stroke-card hover:bg-fluent-fill-hover'
                }`}
              >
                {dragOverIndex === index && draggingIndex !== index && (
                  <div className="absolute -left-1 top-2 bottom-2 w-0.5 bg-fluent-accent rounded-full shadow-[0_0_10px_rgba(0,120,212,1)] z-10 pointer-events-none" />
                )}
                <FileTypeIcon path={item.path} size={24} />
                <span
                  ref={tooltip.bindRef(item.id)}
                  onMouseEnter={tooltip.handleEnter(item.id, item.name)}
                  onMouseLeave={tooltip.handleLeave}
                  className="text-[14px] font-normal text-fluent-text-primary truncate w-full text-center"
                >
                  {item.name}
                </span>
              </div>
            ))}
            {/* 末尾插入区 */}
            <div
              className="relative rounded-lg min-h-[60px]"
              onDragOver={(e) => { e.preventDefault(); setDragOverIndex(shortcuts.length); }}
              onDragLeave={handleDragLeaveReorder}
              onDrop={(e) => handleDropReorder(e, shortcuts.length)}
            >
              {dragOverIndex === shortcuts.length && (
                <div className="absolute left-0 top-2 bottom-2 w-0.5 bg-fluent-accent rounded-full shadow-[0_0_10px_rgba(0,120,212,1)] z-10 pointer-events-none" />
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {shortcuts.map((item, index) => (
              <div
                key={item.id}
                ref={bindItemRef(item.id)}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOverReorder(e, index)}
                onDragLeave={handleDragLeaveReorder}
                onDrop={(e) => handleDropReorder(e, index)}
                onDoubleClick={() => handleOpenFolder(item.path)}
                onMouseEnter={() => handleItemEnter(item)}
                onMouseLeave={handleItemLeave}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, item });
                }}
                className={`relative flex items-center gap-2 h-[44px] px-2 rounded-fluent border cursor-pointer transition-colors ${
                  draggingIndex === index
                    ? 'opacity-40 bg-fluent-fill-hover border-dashed border-fluent-stroke-control'
                    : 'bg-fluent-surface-solid border-fluent-stroke-card hover:bg-fluent-fill-hover'
                }`}
              >
                {dragOverIndex === index && draggingIndex !== index && (
                  <div className="absolute -left-1 top-1.5 bottom-1.5 w-0.5 bg-fluent-accent rounded-full shadow-[0_0_10px_rgba(0,120,212,1)] z-10 pointer-events-none" />
                )}
                <FileTypeIcon path={item.path} size={18} />
                <span
                  ref={tooltip.bindRef(item.id)}
                  onMouseEnter={tooltip.handleEnter(item.id, item.name)}
                  onMouseLeave={tooltip.handleLeave}
                  className="text-[14px] font-normal text-fluent-text-primary truncate flex-1 min-w-0"
                >
                  {item.name}
                </span>
              </div>
            ))}
            {/* 末尾插入区 */}
            <div
              className="relative rounded-lg h-2"
              onDragOver={(e) => { e.preventDefault(); setDragOverIndex(shortcuts.length); }}
              onDragLeave={handleDragLeaveReorder}
              onDrop={(e) => handleDropReorder(e, shortcuts.length)}
            >
              {dragOverIndex === shortcuts.length && (
                <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-fluent-accent rounded-full shadow-[0_0_10px_rgba(0,120,212,1)] z-10 pointer-events-none" />
              )}
            </div>
          </div>
        )}
      </div>

      {tooltip.TooltipNode}

      {/* 多级级联浏览弹窗 */}
      {cascade && (
        <FolderCascadeMenu
          anchorRect={measureVisualRect(cascade.anchorEl)}
          rootPath={cascade.path}
          onOpen={handleCascadeOpen}
          onHoverChange={handleMenuHover}
          onRequestClose={closeCascade}
        />
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-fluent-surface-flyout border border-fluent-stroke-card rounded-fluent-lg py-1 shadow-fluent-flyout min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleDelete(contextMenu.item.id)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-fluent-danger hover:bg-fluent-fill-hover"
          >
            <Trash2 size={12} /> 删除快捷方式
          </button>
        </div>
      )}
    </div>
  );
}
