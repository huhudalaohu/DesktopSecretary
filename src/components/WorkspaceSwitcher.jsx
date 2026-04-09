/**
 * WorkspaceSwitcher.jsx — 工作区切换模块
 *
 * 顶部横向排列胶囊按钮: [项目A] [项目B] [日常] [+]
 * 选中状态: bg-white/20 + border-b-2 border-blue-400
 * 点击 [+] 弹出输入框添加新工作区
 */

import React, { useState } from 'react';
import { Plus } from 'lucide-react';

export default function WorkspaceSwitcher({ workspaces, active, onSwitch, onAdd, onDelete, onReorder }) {
  const [adding, setAdding] = useState(false);   // 是否正在输入新工作区名
  const [newName, setNewName] = useState('');     // 新工作区名称
  const [contextMenu, setContextMenu] = useState(null); // 右键菜单 {x, y, ws}
  const [dragIndex, setDragIndex] = useState(null);      // 拖拽中的索引
  const [dropIndex, setDropIndex] = useState(null);      // 拖拽目标位置

  // 提交新工作区
  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (trimmed) {
      onAdd(trimmed);
    }
    setNewName('');
    setAdding(false);
  };

  // 删除工作区
  const handleDelete = (ws) => {
    onDelete(ws.id);
    setContextMenu(null);
  };

  return (
    <div
      className="flex items-center gap-2 overflow-x-auto pb-1"
      onClick={() => setContextMenu(null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 工作区按钮列表 */}
      {workspaces.map((ws, index) => (
        <button
          key={ws.id}
          draggable
          onClick={() => onSwitch(ws.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ x: e.clientX, y: e.clientY, ws });
          }}
          onDragStart={(e) => {
            setDragIndex(index);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', index.toString());
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
            if (from !== index) {
              onReorder(from, index);
            }
            setDragIndex(null);
            setDropIndex(null);
          }}
          onDragEnd={() => {
            setDragIndex(null);
            setDropIndex(null);
          }}
          className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap transition-all ${
            dragIndex === index ? 'opacity-30' : ''
          } ${
            dropIndex === index && dragIndex !== index ? 'border-l-2 border-blue-400' : ''
          } ${
            active === ws.id
              ? 'bg-white/20 border-b-2 border-blue-400 text-white'
              : 'text-white/50 hover:text-white hover:bg-white/10'
          }`}
        >
          {ws.name}
        </button>
      ))}

      {/* 添加按钮 / 输入框 */}
      {adding ? (
        <form onSubmit={handleSubmit}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={() => { setAdding(false); setNewName(''); }}
            placeholder="名称..."
            className="w-20 px-2 py-1 rounded-full text-xs bg-white/10 text-white placeholder-white/30 border border-white/20 outline-none"
          />
        </form>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="p-1.5 rounded-full text-white/40 hover:text-white hover:bg-white/10 transition-colors"
        >
          <Plus size={14} />
        </button>
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-slate-800/95 backdrop-blur border border-white/10 rounded-lg py-1 shadow-xl min-w-[100px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleDelete(contextMenu.ws)}
            className="w-full text-left text-xs px-3 py-1.5 text-red-400/80 hover:bg-white/10"
          >
            删除 "{contextMenu.ws.name}"
          </button>
        </div>
      )}
    </div>
  );
}
