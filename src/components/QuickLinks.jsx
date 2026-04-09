/**
 * QuickLinks.jsx — 快速入口（手风琴分组文字链）
 *
 * 5层降级命名流水线（带超时保护）:
 *   0层 - 剪贴板智能分割 / URL 参数解析 → 0秒
 *   1层 - electron-store 24h 缓存命中 → 0秒
 *   2层 - Node.js 主进程抓取 OG 元标签 → 0.5-3秒（硬超时）
 *   3层 - URL 路径兜底（超时后跳过 AI，避免二次等待）
 *
 * 超时保护:
 *   - 主进程 Promise.race 3s 硬超时
 *   - 渲染进程 3s 倒计时 + 取消按钮
 *   - 超时后自动进入编辑态，用户可立即输入
 *   - 并发限制：最多 2 个同时识别
 *   - URL 去重：10 秒内禁止重复识别同一 URL
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronRight, ChevronDown, Pencil, Trash2, GripVertical, Loader2, X } from 'lucide-react';

const api = window.desktopAPI;

// ===== 预设分组定义 =====
const DEFAULT_GROUPS = {
  feishu: {
    name: '飞书文档',
    expanded: true,
    links: [
      { id: 'preset-feishu', url: 'https://docs.feishu.cn', title: '飞书文档', addedAt: '2026-04-09', titleSource: 'manual' },
    ],
  },
  tencent: {
    name: '腾讯文档',
    expanded: true,
    links: [
      { id: 'preset-tencent', url: 'https://docs.qq.com', title: '腾讯文档', addedAt: '2026-04-09', titleSource: 'manual' },
    ],
  },
  oa: {
    name: 'OA系统',
    expanded: true,
    links: [],
  },
  thirdParty: {
    name: '第三方工具',
    expanded: true,
    links: [
      { id: 'preset-notion', url: 'https://www.notion.so', title: 'Notion', addedAt: '2026-04-09', titleSource: 'manual' },
      { id: 'preset-yuque', url: 'https://www.yuque.com', title: '语雀', addedAt: '2026-04-09', titleSource: 'manual' },
    ],
  },
  uncategorized: {
    name: '未分类',
    expanded: true,
    links: [],
  },
};

const GROUP_ORDER = ['feishu', 'tencent', 'oa', 'thirdParty', 'uncategorized'];

// ===== 并发控制 =====
const MAX_CONCURRENT = 2;
let activeCount = 0;
const pendingQueue = [];

function acquireSlot() {
  return new Promise((resolve) => {
    if (activeCount < MAX_CONCURRENT) {
      activeCount++;
      resolve();
    } else {
      pendingQueue.push(resolve);
    }
  });
}

function releaseSlot() {
  activeCount--;
  if (pendingQueue.length > 0 && activeCount < MAX_CONCURRENT) {
    activeCount++;
    pendingQueue.shift()();
  }
}

// ===== URL 去重 =====
const recentUrls = new Map(); // url → timestamp

function isDuplicateUrl(url) {
  const now = Date.now();
  const lastTime = recentUrls.get(url);
  if (lastTime && now - lastTime < 10000) return true;
  recentUrls.set(url, now);
  // 清理过期条目
  for (const [k, v] of recentUrls) {
    if (now - v > 30000) recentUrls.delete(k);
  }
  return false;
}

// ===== 工具函数 =====

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function getFaviconUrl(url) {
  const domain = getDomain(url);
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?sz=32&domain=${domain}`;
}

function classifyUrl(hostname, pathname) {
  const h = hostname.toLowerCase();
  const p = (pathname || '').toLowerCase();
  if (h.includes('feishu.cn') || h.includes('feishu.com') || h.includes('larksuite.com') || h.includes('larkoffice.com')) return 'feishu';
  if (h.includes('docs.qq.com') || h.includes('sheets.qq.com') || h.includes('drive.qq.com') || h.includes('slides.qq.com') || h.includes('doc.weixin.qq.com')) return 'tencent';
  if (/\/(docx|wiki|sheets|base|minutes|mindnotes|file|drive)\//i.test(p)) return 'feishu';
  if (/\/(sheet|doc|slide|file)\//i.test(p)) return 'tencent';
  if (h.startsWith('oa.') || h.includes('.oa.')) return 'oa';
  if (h.includes('notion.so') || h.includes('yuque.com')) return 'thirdParty';
  return 'uncategorized';
}

function getPathPrefixHint(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    const h = u.hostname.toLowerCase();
    const isFeishu = h.includes('feishu') || h.includes('larksuite') || h.includes('larkoffice');
    const isTencent = h.includes('qq.com') || h.includes('weixin.qq.com');
    if (isFeishu) {
      if (/\/docx\//.test(p)) return '飞书文档';
      if (/\/sheets?\//.test(p)) return '飞书表格';
      if (/\/wiki\//.test(p)) return '飞书知识库';
      if (/\/base\//.test(p)) return '飞书多维表格';
      if (/\/minutes\//.test(p)) return '飞书会议纪要';
      if (/\/mindnotes\//.test(p)) return '飞书思维导图';
    }
    if (isTencent) {
      if (/\/sheet\//.test(p)) return '腾讯表格';
      if (/\/doc\//.test(p)) return '腾讯文档';
      if (/\/slide\//.test(p)) return '腾讯幻灯片';
    }
  } catch {}
  return null;
}

function getNameFromUrlParams(url) {
  try {
    const u = new URL(url);
    for (const p of ['name', 'title']) {
      const val = u.searchParams.get(p);
      if (val) {
        const decoded = decodeURIComponent(val);
        if (decoded.trim()) return decoded.trim();
      }
    }
  } catch {}
  return null;
}

function guessTitleFromPath(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    if (last && !/^[a-zA-Z0-9_-]{10,}$/.test(last)) {
      return decodeURIComponent(last);
    }
    return u.hostname;
  } catch {
    return url;
  }
}

function splitClipboard(text) {
  const match = text.match(/^(.+?)\s+(https?:\/\/\S+)$/);
  if (match) {
    return { name: match[1].trim(), url: match[2].trim() };
  }
  return null;
}

// ===== 降级命名（超时后跳过 AI，直接兜底） =====
async function resolveTitle(url) {
  // 0层：URL 参数
  const paramTitle = getNameFromUrlParams(url);
  if (paramTitle) {
    return { title: paramTitle, favicon: getFaviconUrl(url), source: 'url-param' };
  }

  // 1+2层：主进程抓取（含缓存，3s 硬超时）
  try {
    const preview = await api.fetchLinkPreview(url);

    // 超时 → 直接兜底，不调 AI（避免二次等待）
    if (preview.error === 'TIMEOUT') {
      return timeoutFallback(url);
    }

    if (preview.cached && preview.title) {
      return { title: preview.title, favicon: preview.favicon || getFaviconUrl(url), source: 'cache' };
    }
    if (preview.source === 'og-meta' && preview.title) {
      return { title: preview.title, favicon: preview.favicon || getFaviconUrl(url), source: 'og-meta' };
    }
    if (preview.error === 'need_login') {
      const prefix = getPathPrefixHint(url);
      return { title: prefix ? `${prefix}（需登录）` : '需要登录查看', favicon: getFaviconUrl(url), source: 'error-need-login' };
    }
    if (preview.error === 'not_found') {
      return { title: '页面不存在', favicon: getFaviconUrl(url), source: 'error-not-found' };
    }
  } catch {
    return timeoutFallback(url);
  }

  // 其他错误 → 路径兜底（不调 AI，省 token）
  return timeoutFallback(url);
}

function timeoutFallback(url) {
  const prefix = getPathPrefixHint(url);
  const pathName = guessTitleFromPath(url);
  const title = prefix || pathName;
  return { title, favicon: getFaviconUrl(url), source: 'fallback' };
}

function genId() {
  return `ql-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ===== 来源标记 =====
function SourceBadge({ source }) {
  const badges = {
    'clipboard-split': ['秒开', 'green'],
    'url-param': ['秒开', 'green'],
    'cache': ['缓存', 'green'],
    'og-meta': ['已抓取', 'blue'],
    'fallback': ['未识别', 'gray'],
    'error-need-login': ['需登录', 'orange'],
    'error-not-found': ['404', 'red'],
  };
  const b = badges[source];
  if (!b) return null;
  const colors = {
    green: ['text-green-400/60', 'bg-green-400/70'],
    blue: ['text-blue-400/60', 'bg-blue-400/70'],
    gray: ['text-white/20', 'bg-white/25'],
    orange: ['text-orange-400/60', 'bg-orange-400/70'],
    red: ['text-red-400/40', 'bg-red-400/50'],
  };
  const [textCls, dotCls] = colors[b[1]] || colors.gray;
  return (
    <span className={`flex items-center gap-0.5 text-[9px] ${textCls} flex-shrink-0`}>
      <span className={`w-1 h-1 rounded-full ${dotCls} inline-block`} />
      {b[0]}
    </span>
  );
}

function SkeletonBar() {
  return <div className="h-3 bg-white/10 rounded animate-pulse" style={{ width: '60%' }} />;
}

export default function QuickLinks({ activeWorkspace }) {
  const [groups, setGroups] = useState(null);
  const [addingStatus, setAddingStatus] = useState('');
  const [contextMenu, setContextMenu] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [dragInfo, setDragInfo] = useState(null);
  const [hoveredLink, setHoveredLink] = useState(null);
  // 识别倒计时：{ linkId: seconds }
  const [countdowns, setCountdowns] = useState({});
  // 正在识别的 linkId 集合（用于显示取消按钮）
  const [loadingIds, setLoadingIds] = useState(new Set());
  const inputRef = useRef(null);
  const timersRef = useRef({}); // linkId → interval
  const cancelledRef = useRef(new Set()); // 已取消的 linkId

  // 存储键按工作区分隔
  const storeKey = `quickLinks:${activeWorkspace}`;

  useEffect(() => {
    // 切换工作区时清理定时器和状态
    Object.values(timersRef.current).forEach(clearInterval);
    timersRef.current = {};
    cancelledRef.current = new Set();
    setLoadingIds(new Set());
    setCountdowns({});

    api.storeGet(storeKey, {}).then((saved) => {
      if (!saved || Object.keys(saved).length === 0) {
        setGroups(DEFAULT_GROUPS);
        api.storeSet(storeKey, DEFAULT_GROUPS);
      } else {
        setGroups(saved);
      }
    });
    return () => {
      Object.values(timersRef.current).forEach(clearInterval);
    };
  }, [storeKey]);

  const saveGroups = useCallback(async (updated) => {
    setGroups(updated);
    await api.storeSet(storeKey, updated);
  }, [storeKey]);

  useEffect(() => {
    const handler = (e) => {
      if (contextMenu && !e.target.closest('.ql-context-menu')) {
        setContextMenu(null);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  const toggleGroup = (groupId) => {
    if (!groups) return;
    const updated = {
      ...groups,
      [groupId]: { ...groups[groupId], expanded: !groups[groupId].expanded },
    };
    saveGroups(updated);
  };

  // 启动倒计时
  const startCountdown = (linkId) => {
    setLoadingIds((prev) => new Set(prev).add(linkId));
    setCountdowns((prev) => ({ ...prev, [linkId]: 3 }));
    timersRef.current[linkId] = setInterval(() => {
      setCountdowns((prev) => {
        const next = (prev[linkId] || 1) - 1;
        if (next <= 0) {
          clearInterval(timersRef.current[linkId]);
          delete timersRef.current[linkId];
          return { ...prev, [linkId]: 0 };
        }
        return { ...prev, [linkId]: next };
      });
    }, 1000);
  };

  // 停止倒计时
  const stopCountdown = (linkId) => {
    if (timersRef.current[linkId]) {
      clearInterval(timersRef.current[linkId]);
      delete timersRef.current[linkId];
    }
    setCountdowns((prev) => { const n = { ...prev }; delete n[linkId]; return n; });
    setLoadingIds((prev) => { const s = new Set(prev); s.delete(linkId); return s; });
  };

  // 取消识别
  const cancelRecognition = (linkId, groupId) => {
    cancelledRef.current.add(linkId);
    stopCountdown(linkId);
    // 将 loading 状态改为可编辑的 fallback
    const updated = {
      ...groups,
      [groupId]: {
        ...groups[groupId],
        links: groups[groupId].links.map((l) =>
          l.id === linkId ? { ...l, title: '未命名链接', titleSource: 'fallback' } : l
        ),
      },
    };
    saveGroups(updated);
    // 自动进入编辑态
    const link = updated[groupId].links.find((l) => l.id === linkId);
    if (link) {
      setEditingId(link.id);
      setEditingTitle('');
    }
  };

  // 更新链接（识别完成后）
  const updateLink = (groupId, tempId, finalData) => {
    setGroups((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [groupId]: {
          ...prev[groupId],
          links: prev[groupId].links.map((l) => l.id === tempId ? { ...l, ...finalData } : l),
        },
      };
    });
    // 异步保存
    api.storeGet(storeKey, {}).then((latest) => {
      if (!latest || !latest[groupId]) return;
      const updated = {
        ...latest,
        [groupId]: {
          ...latest[groupId],
          links: latest[groupId].links.map((l) => l.id === tempId ? { ...l, ...finalData } : l),
        },
      };
      api.storeSet(storeKey, updated);
    });
  };

  // ===== 智能添加 =====
  const handlePaste = async (e) => {
    e.preventDefault();
    const rawText = (e.clipboardData || window.clipboardData).getData('text').trim();
    if (!rawText) return;

    // 0层：剪贴板分割
    const split = splitClipboard(rawText);
    let url, preParsedTitle = null;
    if (split) {
      url = split.url;
      preParsedTitle = split.name;
    } else {
      url = rawText;
      if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    }

    let hostname, pathname;
    try { const u = new URL(url); hostname = u.hostname; pathname = u.pathname; } catch { return; }

    // URL 去重
    if (isDuplicateUrl(url)) return;

    const groupId = classifyUrl(hostname, pathname);
    const tempId = genId();

    // 0层命中
    if (preParsedTitle) {
      const finalLink = {
        id: tempId, url, title: preParsedTitle, addedAt: today(),
        favicon: getFaviconUrl(url), titleSource: 'clipboard-split',
      };
      const updated = {
        ...groups,
        [groupId]: { ...groups[groupId], expanded: true, links: [...(groups[groupId]?.links || []), finalLink] },
      };
      await saveGroups(updated);
      setAddingStatus('done');
      setTimeout(() => { setAddingStatus(''); if (inputRef.current) inputRef.current.value = ''; }, 1500);
      return;
    }

    // 添加骨架屏占位
    const tempLink = {
      id: tempId, url, title: '正在识别...', addedAt: today(),
      favicon: getFaviconUrl(url), titleSource: 'loading',
    };
    const updatedWithTemp = {
      ...groups,
      [groupId]: { ...groups[groupId], expanded: true, links: [...(groups[groupId]?.links || []), tempLink] },
    };
    await saveGroups(updatedWithTemp);
    setAddingStatus('fetching');
    startCountdown(tempId);

    // 并发控制
    await acquireSlot();

    // 检查是否已被取消
    if (cancelledRef.current.has(tempId)) {
      cancelledRef.current.delete(tempId);
      releaseSlot();
      return;
    }

    try {
      const { title, favicon, source } = await resolveTitle(url);

      // 检查是否已被取消
      if (cancelledRef.current.has(tempId)) {
        cancelledRef.current.delete(tempId);
        releaseSlot();
        return;
      }

      stopCountdown(tempId);
      updateLink(groupId, tempId, { title, favicon: favicon || getFaviconUrl(url), titleSource: source });
      setAddingStatus('done');
      setTimeout(() => { setAddingStatus(''); if (inputRef.current) inputRef.current.value = ''; }, 1500);
    } catch {
      stopCountdown(tempId);
      const fallbackTitle = guessTitleFromPath(url);
      updateLink(groupId, tempId, { title: fallbackTitle, titleSource: 'fallback' });
      setAddingStatus('done');
      setTimeout(() => { setAddingStatus(''); if (inputRef.current) inputRef.current.value = ''; }, 1500);
    } finally {
      releaseSlot();
    }
  };

  const handleInputKeydown = (e) => {
    if (e.key === 'Enter' && inputRef.current?.value.trim()) {
      handlePaste({
        preventDefault: () => {},
        clipboardData: { getData: () => inputRef.current.value.trim() },
      });
    }
  };

  const deleteLink = (groupId, linkId) => {
    const updated = {
      ...groups,
      [groupId]: { ...groups[groupId], links: groups[groupId].links.filter((l) => l.id !== linkId) },
    };
    saveGroups(updated);
    setContextMenu(null);
  };

  const startEdit = (link) => {
    setEditingId(link.id);
    setEditingTitle(link.title);
    setContextMenu(null);
  };

  const confirmEdit = (groupId, linkId) => {
    if (!editingTitle.trim()) return;
    const updated = {
      ...groups,
      [groupId]: {
        ...groups[groupId],
        links: groups[groupId].links.map((l) =>
          l.id === linkId ? { ...l, title: editingTitle.trim(), titleSource: 'manual' } : l
        ),
      },
    };
    saveGroups(updated);
    setEditingId(null);
    setEditingTitle('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingTitle('');
  };

  const moveToGroup = (fromGroupId, linkId, toGroupId) => {
    if (fromGroupId === toGroupId) { setContextMenu(null); return; }
    const link = groups[fromGroupId].links.find((l) => l.id === linkId);
    if (!link) return;
    const updated = {
      ...groups,
      [fromGroupId]: { ...groups[fromGroupId], links: groups[fromGroupId].links.filter((l) => l.id !== linkId) },
      [toGroupId]: { ...groups[toGroupId], links: [...groups[toGroupId].links, link] },
    };
    saveGroups(updated);
    setContextMenu(null);
  };

  const handleDragStart = (e, groupId, index) => {
    setDragInfo({ groupId, index });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e, groupId, targetIndex) => {
    e.preventDefault();
    if (!dragInfo || dragInfo.groupId !== groupId) { setDragInfo(null); return; }
    const { index: fromIndex } = dragInfo;
    if (fromIndex === targetIndex) { setDragInfo(null); return; }
    const links = [...groups[groupId].links];
    const [moved] = links.splice(fromIndex, 1);
    links.splice(targetIndex, 0, moved);
    saveGroups({ ...groups, [groupId]: { ...groups[groupId], links } });
    setDragInfo(null);
  };

  if (!groups) return null;

  return (
    <div>
      <div className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">快速入口</div>

      <div className="rounded-xl bg-white/5 border border-white/10 p-3">
        {/* 快速添加输入框 */}
        <div className="mb-3">
          <input
            ref={inputRef}
            type="text"
            placeholder="粘贴文档链接，自动识别分类"
            onPaste={handlePaste}
            onKeyDown={handleInputKeydown}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-white/25 outline-none focus:border-white/20 transition-colors"
          />
          {addingStatus === 'fetching' && (
            <div className="text-[10px] text-blue-400/70 mt-1 px-1">正在获取信息...</div>
          )}
          {addingStatus === 'done' && (
            <div className="text-[10px] text-green-400/70 mt-1 px-1">已添加</div>
          )}
        </div>

        {/* 手风琴分组列表 */}
        {GROUP_ORDER.map((groupId) => {
          const group = groups[groupId];
          if (!group) return null;
          const linkCount = group.links.length;

          return (
            <div key={groupId} className="mb-1">
              <div
                onClick={() => toggleGroup(groupId)}
                className="flex items-center gap-1.5 px-2 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg cursor-pointer transition-colors select-none"
              >
                {group.expanded ? (
                  <ChevronDown size={16} className="text-gray-400 flex-shrink-0" />
                ) : (
                  <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />
                )}
                <span className="text-[13px] font-semibold text-white flex-1 truncate">{group.name}</span>
                <span className="text-[10px] text-white/25 flex-shrink-0">{linkCount}</span>
              </div>

              {group.expanded && (
                <div className="ml-4 mt-0.5">
                  {linkCount === 0 ? (
                    <div className="text-[10px] text-white/20 py-2 px-2">
                      暂无快捷方式，粘贴链接即可添加
                    </div>
                  ) : (
                    group.links.map((link, index) => {
                      const isLoading = link.titleSource === 'loading';
                      const cd = countdowns[link.id];
                      const isTimedOut = cd !== undefined && cd <= 0;

                      return (
                        <div
                          key={link.id}
                          draggable={!isLoading}
                          onDragStart={(e) => handleDragStart(e, groupId, index)}
                          onDragOver={handleDragOver}
                          onDrop={(e) => handleDrop(e, groupId, index)}
                          onMouseEnter={() => setHoveredLink(link.id)}
                          onMouseLeave={() => setHoveredLink(null)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setContextMenu({ x: e.clientX, y: e.clientY, groupId, link });
                          }}
                          className="group flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/5 transition-colors cursor-pointer relative"
                          onDoubleClick={() => !isLoading && api.openExternal(link.url)}
                          title={link.url}
                        >
                          <GripVertical
                            size={10}
                            className={`flex-shrink-0 transition-opacity ${hoveredLink === link.id && !isLoading ? 'opacity-30' : 'opacity-0'}`}
                          />

                          {/* Favicon */}
                          <img
                            src={link.favicon || getFaviconUrl(link.url)}
                            alt=""
                            className="w-4 h-4 flex-shrink-0 rounded-sm"
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />

                          {/* 标题区域 */}
                          {isLoading && !isTimedOut ? (
                            <>
                              <SkeletonBar />
                              <span className="text-[9px] text-blue-400/50 flex-shrink-0">
                                {cd !== undefined ? `${cd}s` : '...'}
                              </span>
                              <button
                                onClick={(e) => { e.stopPropagation(); cancelRecognition(link.id, groupId); }}
                                className="p-0.5 rounded hover:bg-white/10 text-white/30 hover:text-red-400/60 transition-colors flex-shrink-0"
                                title="取消识别"
                              >
                                <X size={10} />
                              </button>
                            </>
                          ) : editingId === link.id ? (
                            <input
                              type="text"
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') confirmEdit(groupId, link.id);
                                if (e.key === 'Escape') cancelEdit();
                              }}
                              onBlur={() => confirmEdit(groupId, link.id)}
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                              placeholder="输入名称..."
                              className="flex-1 bg-white/10 border border-white/20 rounded px-1 py-0.5 text-sm text-white placeholder-white/30 outline-none min-w-0"
                            />
                          ) : (
                            <>
                              <span className={`flex-1 text-sm truncate min-w-0 ${
                                link.titleSource === 'error-not-found' ? 'text-red-400/50 line-through' : 'text-gray-300'
                              }`}>
                                {link.title}
                              </span>
                              <SourceBadge source={link.titleSource} />
                            </>
                          )}

                          {/* 悬停操作按钮 */}
                          {hoveredLink === link.id && editingId !== link.id && !isLoading && (
                            <div className="flex items-center gap-0.5 flex-shrink-0 ml-0.5">
                              <button
                                onClick={(e) => { e.stopPropagation(); startEdit(link); }}
                                className="p-0.5 rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors"
                              >
                                <Pencil size={10} />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteLink(groupId, link.id); }}
                                className="p-0.5 rounded hover:bg-white/10 text-white/30 hover:text-red-400/60 transition-colors"
                              >
                                <Trash2 size={10} />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* 右键上下文菜单 */}
        {contextMenu && (
          <div
            className="ql-context-menu fixed z-50 bg-slate-800/95 backdrop-blur border border-white/10 rounded-lg shadow-xl py-1 min-w-[130px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              onClick={() => startEdit(contextMenu.link)}
              className="w-full text-left px-3 py-1.5 text-xs text-white/60 hover:bg-white/10 transition-colors"
            >
              编辑名称
            </button>
            <div className="border-t border-white/10 my-1" />
            <div className="px-3 py-1 text-[10px] text-white/30">移动到</div>
            {GROUP_ORDER.filter((id) => id !== contextMenu.groupId).map((id) => (
              <button
                key={id}
                onClick={() => moveToGroup(contextMenu.groupId, contextMenu.link.id, id)}
                className="w-full text-left px-3 py-1.5 text-xs text-white/50 hover:bg-white/10 transition-colors"
              >
                {groups[id]?.name}
              </button>
            ))}
            <div className="border-t border-white/10 my-1" />
            <button
              onClick={() => deleteLink(contextMenu.groupId, contextMenu.link.id)}
              className="w-full text-left px-3 py-1.5 text-xs text-red-400/80 hover:bg-white/10 transition-colors"
            >
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
