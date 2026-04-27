/**
 * FileNavigator.jsx — 文件导航模块
 *
 * 支持从系统文件资源管理器拖拽文件、文件夹或应用快捷方式建立快捷入口。
 * 提供两种视图：大图标和详细信息列表。
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Folder,
  LayoutGrid,
  List,
  Trash2,
  File,
  FileImage,
  FileVideo,
  FileMusic,
  FileText,
  FileSpreadsheet,
  FileCode2,
  Package,
  AppWindow,
  Database,
  Link,
} from 'lucide-react';

const api = window.desktopAPI;

function getFileKind(path) {
  const last = path.replace(/\\/g, '/').split('/').pop() || '';
  if (!last.includes('.')) return 'folder';
  const ext = last.split('.').pop().toLowerCase();
  const map = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'heic'],
    video: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a'],
    doc: ['txt', 'md', 'doc', 'docx', 'pdf', 'rtf', 'odt', 'pages'],
    sheet: ['xls', 'xlsx', 'csv', 'ods', 'numbers'],
    code: ['js', 'jsx', 'ts', 'tsx', 'html', 'htm', 'css', 'scss', 'less', 'py', 'java', 'cpp', 'c', 'cc', 'h', 'hpp', 'go', 'rs', 'swift', 'kt', 'json', 'xml', 'yaml', 'yml', 'sql', 'php', 'rb', 'lua', 'sh', 'ps1', 'bat', 'cmd', 'dockerfile', 'vue', 'svelte'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
    app: ['exe', 'msi', 'appimage', 'dmg'],
    db: ['db', 'sqlite', 'mdb', 'accdb'],
    link: ['lnk', 'url'],
  };
  for (const [kind, exts] of Object.entries(map)) {
    if (exts.includes(ext)) return kind;
  }
  return 'file';
}

function FileTypeIcon({ path, size = 18 }) {
  const kind = getFileKind(path);
  const props = { size, className: 'flex-shrink-0' };
  switch (kind) {
    case 'folder': return <Folder {...props} className={`${props.className} text-[#0099FF]`} />;
    case 'image': return <FileImage {...props} className={`${props.className} text-pink-400`} />;
    case 'video': return <FileVideo {...props} className={`${props.className} text-purple-400`} />;
    case 'audio': return <FileMusic {...props} className={`${props.className} text-amber-400`} />;
    case 'doc': return <FileText {...props} className={`${props.className} text-blue-400`} />;
    case 'sheet': return <FileSpreadsheet {...props} className={`${props.className} text-green-500`} />;
    case 'code': return <FileCode2 {...props} className={`${props.className} text-cyan-500`} />;
    case 'archive': return <Package {...props} className={`${props.className} text-orange-400`} />;
    case 'app': return <AppWindow {...props} className={`${props.className} text-indigo-400`} />;
    case 'db': return <Database {...props} className={`${props.className} text-teal-500`} />;
    case 'link': return <Link {...props} className={`${props.className} text-sky-400`} />;
    default: return <File {...props} className={`${props.className} text-gray-400`} />;
  }
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

  // 加载数据 + 一次性迁移旧数据
  useEffect(() => {
    (async () => {
      // 视图模式
      const savedView = await api.storeGet(viewKey, 'icons');
      setViewMode(['icons', 'details'].includes(savedView) ? savedView : 'icons');

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
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">文件导航</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleViewChange('icons')}
            className={`p-1 rounded transition-colors ${
              viewMode === 'icons'
                ? 'bg-[#E6F4FF] text-[#0099FF]'
                : 'text-gray-400 hover:text-gray-600 hover:bg-[#EBEBEB]'
            }`}
            title="大图标"
          >
            <LayoutGrid size={14} />
          </button>
          <button
            onClick={() => handleViewChange('details')}
            className={`p-1 rounded transition-colors ${
              viewMode === 'details'
                ? 'bg-[#E6F4FF] text-[#0099FF]'
                : 'text-gray-400 hover:text-gray-600 hover:bg-[#EBEBEB]'
            }`}
            title="详细信息"
          >
            <List size={14} />
          </button>
        </div>
      </div>

      {/* 内容区域（拖拽接收区） */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`rounded-lg border p-3 transition-colors ${
          dropHighlight
            ? 'bg-blue-50 border-blue-300'
            : 'bg-white border-[#E5E5E5]'
        } shadow-sm`}
      >
        {shortcuts.length === 0 ? (
          <div className="text-xs text-gray-300 py-4 text-center">
            从文件资源管理器拖拽文件、文件夹或快捷方式到此处添加
          </div>
        ) : viewMode === 'icons' ? (
          <div className="grid grid-cols-4 gap-2">
            {shortcuts.map((item, index) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOverReorder(e, index)}
                onDragLeave={handleDragLeaveReorder}
                onDrop={(e) => handleDropReorder(e, index)}
                onClick={() => handleOpenFolder(item.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, item });
                }}
                className={`relative flex flex-col items-center justify-center gap-1 rounded-lg border p-2 cursor-pointer transition-all ${
                  draggingIndex === index
                    ? 'opacity-40 bg-gray-100 border-dashed border-gray-300'
                    : 'bg-white border-[#E5E5E5] hover:bg-[#EBEBEB]'
                }`}
              >
                {dragOverIndex === index && draggingIndex !== index && (
                  <div className="absolute -left-1 top-2 bottom-2 w-0.5 bg-blue-500 rounded-full shadow-[0_0_10px_rgba(59,130,246,1)] z-10 pointer-events-none" />
                )}
                <FileTypeIcon path={item.path} size={24} />
                <span className="text-[10px] text-gray-600 truncate w-full text-center">
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
                <div className="absolute left-0 top-2 bottom-2 w-0.5 bg-blue-500 rounded-full shadow-[0_0_10px_rgba(59,130,246,1)] z-10 pointer-events-none" />
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {shortcuts.map((item, index) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOverReorder(e, index)}
                onDragLeave={handleDragLeaveReorder}
                onDrop={(e) => handleDropReorder(e, index)}
                onClick={() => handleOpenFolder(item.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, item });
                }}
                className={`relative flex items-center gap-2 h-[44px] px-2 rounded-md border cursor-pointer transition-colors ${
                  draggingIndex === index
                    ? 'opacity-40 bg-gray-100 border-dashed border-gray-300'
                    : 'bg-white border-[#E5E5E5] hover:bg-[#EBEBEB]'
                }`}
              >
                {dragOverIndex === index && draggingIndex !== index && (
                  <div className="absolute -left-1 top-1.5 bottom-1.5 w-0.5 bg-blue-500 rounded-full shadow-[0_0_10px_rgba(59,130,246,1)] z-10 pointer-events-none" />
                )}
                <FileTypeIcon path={item.path} size={18} />
                <span className="text-xs text-gray-700 truncate w-24 flex-shrink-0">{item.name}</span>
                <span className="text-[10px] text-gray-400 truncate flex-1 min-w-0">{truncatePath(item.path)}</span>
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
                <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500 rounded-full shadow-[0_0_10px_rgba(59,130,246,1)] z-10 pointer-events-none" />
              )}
            </div>
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-white border border-[#E5E5E5] rounded-lg py-1 shadow-lg min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleDelete(contextMenu.item.id)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-500 hover:bg-[#EBEBEB]"
          >
            <Trash2 size={12} /> 删除快捷方式
          </button>
        </div>
      )}
    </div>
  );
}
