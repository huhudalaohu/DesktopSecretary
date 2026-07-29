/**
 * FileTypeIcon.jsx — 按路径扩展名渲染对应类型的文件图标
 *
 * 供 FileNavigator 与 FolderCascadeMenu 共用。
 */

import React from 'react';
import {
  Folder,
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

export function getFileKind(path) {
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

export default function FileTypeIcon({ path, size = 18 }) {
  const kind = getFileKind(path);
  const props = { size, className: 'flex-shrink-0' };
  switch (kind) {
    case 'folder': return <Folder {...props} className={`${props.className} text-fluent-accent`} />;
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
