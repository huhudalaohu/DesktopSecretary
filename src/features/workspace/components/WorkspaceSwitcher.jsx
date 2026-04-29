/**
 * WorkspaceSwitcher.jsx — 工作区切换模块（Edge 标签页风格）
 *
 * 顶部横向标签栏，模仿 Edge 浏览器标签页设计：
 * - 梯形圆角标签，上圆下直
 * - 激活标签白底 + 底部蓝线指示
 * - 左侧颜色竖线标识项目序号色
 * - 右侧 × 关闭按钮（hover 显示）
 * - 双击标签重命名
 */

import React, { useState, useRef, useEffect } from 'react';
import { Plus } from 'lucide-react';

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
        .edge-tabs-scroll::-webkit-scrollbar-thumb:hover { background: #D4D4D4 !important; }
        .edge-tabs-scroll::-webkit-scrollbar-button { display: none !important; }
      `}</style>
      <div>
        <div
          ref={scrollContainerRef}
          className="edge-tabs-scroll flex items-end gap-0.5 overflow-x-auto pl-1 pr-2 pt-1.5"
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
                className="px-2 py-1 rounded-t-md text-[13px] bg-white text-gray-800 border border-[#0078D4] outline-none w-24"
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
                  group relative flex items-center h-7 rounded-t-md text-[13px] select-none cursor-pointer transition-colors overflow-hidden flex-shrink-0
                  ${dragIndex === index ? 'opacity-40' : ''}
                  ${dropIndex === index && dragIndex !== index ? 'border-l-2 border-[#0078D4]' : ''}
                  ${isActive
                    ? 'bg-white text-[#333] font-semibold'
                    : 'bg-[#E8E8E8] text-[#999] hover:bg-[#DCDCDC] font-normal'
                  }
                `}
                style={{ fontFamily: "'D-DIN', sans-serif" }}
                title={ws.name}
              >
                {/* 左侧序号区 */}
                <div
                  className="h-full w-[18px] flex items-center justify-center flex-shrink-0 transition-colors"
                  style={{
                    backgroundColor: isActive ? '#FFFFFF' : color.rgb,
                  }}
                >
                  <span
                    className="text-[11px] font-bold tabular-nums leading-none transition-colors"
                    style={{ color: isActive ? color.rgb : '#FFFFFF' }}
                  >
                    {index + 1}
                  </span>
                </div>
                {/* 项目名称 */}
                <span className="truncate max-w-[80px] ml-1.5 mr-2">{ws.name}</span>
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
              className="mb-0.5 px-2 py-1 rounded-t-lg text-[13px] bg-white text-gray-800 border border-[#E0E0E0] outline-none focus:border-[#0078D4] w-20"
            />
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="w-7 h-7 mb-0.5 rounded-full flex items-center justify-center text-[#5F6368] hover:bg-[#E0E0E0] transition-colors flex-shrink-0"
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
              className="fixed z-[9999] bg-white border border-[#E5E5E5] rounded-lg py-1 shadow-lg min-w-[80px]"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <button
                onClick={() => {
                  if (onDuplicate) onDuplicate(contextMenu.wsId);
                  setContextMenu(null);
                }}
                className="w-full text-left text-[11px] px-3 py-1.5 text-gray-600 hover:bg-gray-50"
              >
                复制
              </button>
              <button
                onClick={() => {
                  onDelete(contextMenu.wsId);
                  setContextMenu(null);
                }}
                className="w-full text-left text-[11px] px-3 py-1.5 text-red-500 hover:bg-red-50"
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
