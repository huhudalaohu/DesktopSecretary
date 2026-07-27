/**
 * WorkspaceSwitcher.jsx — 工作区切换模块（Edge 标签页风格）
 *
 * 顶部横向标签栏，对齐 Edge 浏览器标签页逻辑：
 * - 标签平分可用宽度（flex-1），数量多时均匀压缩，压到最小宽度后才滚动
 * - 激活标签白底浮起，非激活标签透明底、之间以细分隔线区隔
 * - 左侧序号是小号浅色徽标（类 favicon），与 TodoList 的 gradientColor 约定一致
 * - 右侧 × 关闭按钮（hover 显示，激活标签常显）
 * - 双击标签重命名，拖拽排序，右键菜单（复制/删除）
 */

import React, { useState, useRef, useEffect } from 'react';
import { Plus, X } from 'lucide-react';

/**
 * 深蓝到浅蓝的渐变插值
 * @param {number} index 当前索引
 * @param {number} total 总数
 * @param {string} startHex 起始色（深蓝）
 * @param {string} endHex 结束色（浅蓝）
 * @returns {{rgb: string, r: number, g: number, b: number}}
 */
function gradientColor(index, total, startHex = '#0259BB', endHex = '#B3D9FF') {
  if (total <= 1) {
    const r = parseInt(startHex.slice(1, 3), 16);
    const g = parseInt(startHex.slice(3, 5), 16);
    const b = parseInt(startHex.slice(5, 7), 16);
    return { rgb: startHex, r, g, b };
  }
  const t = index / (total - 1);
  const hexToRgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = hexToRgb(startHex);
  const [r2, g2, b2] = hexToRgb(endHex);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return { rgb: `rgb(${r}, ${g}, ${b})`, r, g, b };
}

export default function WorkspaceSwitcher({ workspaces, active, onSwitch, onAdd, onDelete, onReorder, onRename, onDuplicate }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [dragIndex, setDragIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, wsId }
  const scrollContainerRef = useRef(null);

  // 激活工作区变化时，自动滚动到可视区域
  useEffect(() => {
    if (!scrollContainerRef.current || !active) return;
    const el = scrollContainerRef.current.querySelector(`[data-ws-id="${active}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [active]);

  // 提交新工作区（Enter 或失焦时触发，用 ref 防重复）
  const didSubmitRef = useRef(false);
  const submitNewWorkspace = () => {
    if (didSubmitRef.current) return;
    const trimmed = newName.trim();
    if (trimmed) {
      didSubmitRef.current = true;
      onAdd(trimmed);
    }
    setNewName('');
    setAdding(false);
    setTimeout(() => { didSubmitRef.current = false; }, 100);
  };
  const cancelNewWorkspace = () => {
    didSubmitRef.current = true;
    setNewName('');
    setAdding(false);
    setTimeout(() => { didSubmitRef.current = false; }, 100);
  };

  // 确认重命名
  const handleConfirmRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && renamingId && onRename) onRename(renamingId, trimmed);
    setRenamingId(null);
    setRenameValue('');
  };

  return (
    <>
      <style>{`
        .edge-tabs-scroll::-webkit-scrollbar { height: 4px !important; }
        .edge-tabs-scroll::-webkit-scrollbar-track { background: transparent !important; border-radius: 999px !important; }
        .edge-tabs-scroll::-webkit-scrollbar-thumb { border-radius: 999px !important; background: transparent !important; }
        .edge-tabs-scroll::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.2) !important; }
        .edge-tabs-scroll::-webkit-scrollbar-button { display: none !important; }
      `}</style>
      <div>
        <div
          ref={scrollContainerRef}
          data-tour="workspace-tabs"
          className="edge-tabs-scroll flex items-end overflow-x-auto px-1 pt-1.5"
          onContextMenu={(e) => e.preventDefault()}
          onWheel={(e) => {
            if (e.deltaY !== 0) {
              e.currentTarget.scrollLeft += e.deltaY;
              e.preventDefault();
            }
          }}
        >
          {workspaces.map((ws, index) => {
            const color = gradientColor(index, workspaces.length);
            const isActive = active === ws.id;
            // Edge 风格分隔线：只出现在两个非激活标签之间
            const showDivider = !isActive
              && index < workspaces.length - 1
              && active !== workspaces[index + 1].id;

            return renamingId === ws.id ? (
              <input
                key={ws.id}
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmRename();
                  if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                }}
                onBlur={handleConfirmRename}
                onClick={(e) => e.stopPropagation()}
                className="input px-2 py-1 rounded-t-fluent rounded-b-none text-[12px] border-fluent-accent w-24 flex-shrink-0"
              />
            ) : (
              <div
                key={ws.id}
                data-ws-id={ws.id}
                draggable
                role="button"
                tabIndex={0}
                onClick={() => onSwitch(ws.id)}
                onDoubleClick={() => {
                  setRenamingId(ws.id);
                  setRenameValue(ws.name);
                }}
                onDragStart={(e) => {
                  setDragIndex(index);
                  e.dataTransfer.effectAllowed = 'copyMove';
                  e.dataTransfer.setData('text/plain', index.toString());
                  e.dataTransfer.setData('text/workspace', `${ws.id}|${ws.name}`);
                  e.dataTransfer.setData('application/json', JSON.stringify({ workspaceId: ws.id, workspaceName: ws.name }));
                  window.__draggingWorkspace = { workspaceId: ws.id, workspaceName: ws.name };
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDropIndex(index);
                }}
                onDragLeave={() => {
                  if (dropIndex === index) setDropIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
                  if (!Number.isNaN(from) && from !== index) onReorder(from, index);
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropIndex(null);
                  delete window.__draggingWorkspace;
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, wsId: ws.id });
                }}
                className={`
                  group relative flex items-center flex-1 basis-0 min-w-[48px] max-w-[160px] h-8 rounded-t-fluent-lg text-[12px] select-none cursor-pointer transition-colors overflow-hidden
                  ${dragIndex === index ? 'opacity-40' : ''}
                  ${dropIndex === index && dragIndex !== index ? 'border-l-2 border-fluent-accent' : ''}
                  ${isActive
                    ? 'bg-fluent-surface-solid text-fluent-text-primary shadow-fluent-card'
                    : 'text-fluent-text-secondary hover:bg-fluent-fill-hover hover:text-fluent-text-primary'
                  }
                `}
                title={ws.name}
              >
                {/* 左侧序号徽标（类 favicon：小号浅色底 + 项目色数字） */}
                <span
                  className="w-4 h-4 ml-2 flex items-center justify-center flex-shrink-0 rounded-fluent text-[9px] font-bold tabular-nums leading-none"
                  style={{
                    backgroundColor: color.rgb,
                    color: '#FFFFFF',
                  }}
                >
                  {index + 1}
                </span>
                {/* 项目名称 */}
                <span className="truncate flex-1 min-w-0 ml-1.5">{ws.name}</span>
                {/* 关闭按钮：激活标签常显，其余 hover 显示 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(ws.id);
                  }}
                  tabIndex={-1}
                  title="关闭工作区（移入回收站）"
                  className={`
                    flex-shrink-0 w-4 h-4 mr-1.5 rounded-fluent items-center justify-center
                    text-fluent-text-tertiary hover:bg-fluent-stroke-control hover:text-fluent-text-primary transition-colors
                    ${isActive ? 'flex' : 'hidden group-hover:flex'}
                  `}
                >
                  <X size={11} />
                </button>
                {/* 非激活标签之间的分隔线 */}
                {showDivider && (
                  <span className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-fluent-stroke-strong pointer-events-none group-hover:opacity-0 transition-opacity" />
                )}
              </div>
            );
          })}

          {/* 添加按钮 */}
          {adding ? (
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewWorkspace();
                if (e.key === 'Escape') cancelNewWorkspace();
              }}
              onBlur={submitNewWorkspace}
              placeholder="名称..."
              className="input mb-0.5 px-2 py-1 rounded-t-fluent rounded-b-none text-[12px] w-20 flex-shrink-0"
            />
          ) : (
            <button
              onClick={() => setAdding(true)}
              title="新建工作区"
              className="w-7 h-7 mb-0.5 ml-0.5 rounded-fluent flex items-center justify-center flex-shrink-0 text-fluent-text-tertiary hover:bg-fluent-fill-hover hover:text-fluent-text-primary transition-colors"
            >
              <Plus size={14} />
            </button>
          )}
        </div>

        {/* 右键菜单 */}
        {contextMenu && (
          <>
            <div
              className="fixed inset-0 z-[9998]"
              onClick={() => setContextMenu(null)}
            />
            <div
              className="fixed z-[9999] bg-fluent-surface-flyout border border-fluent-stroke-card rounded-fluent-lg py-1 shadow-fluent-flyout min-w-[80px]"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <button
                onClick={() => {
                  if (onDuplicate) onDuplicate(contextMenu.wsId);
                  setContextMenu(null);
                }}
                className="w-full text-left text-[11px] px-3 py-1.5 text-fluent-text-secondary hover:bg-fluent-fill-hover"
              >
                复制
              </button>
              <button
                onClick={() => {
                  onDelete(contextMenu.wsId);
                  setContextMenu(null);
                }}
                className="w-full text-left text-[11px] px-3 py-1.5 text-fluent-danger hover:bg-fluent-fill-hover"
              >
                删除
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
