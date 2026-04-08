/**
 * WorkspaceSwitcher.jsx — 工作区切换模块
 *
 * 顶部横向排列胶囊按钮: [项目A] [项目B] [日常] [+]
 * 选中状态: bg-white/20 + border-b-2 border-blue-400
 * 点击 [+] 弹出输入框添加新工作区
 */

import React, { useState } from 'react';
import { Plus } from 'lucide-react';

export default function WorkspaceSwitcher({ workspaces, active, onSwitch, onAdd }) {
  const [adding, setAdding] = useState(false);   // 是否正在输入新工作区名
  const [newName, setNewName] = useState('');     // 新工作区名称

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

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      {/* 工作区按钮列表 */}
      {workspaces.map((ws) => (
        <button
          key={ws.id}
          onClick={() => onSwitch(ws.id)}
          className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap transition-all ${
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
    </div>
  );
}
