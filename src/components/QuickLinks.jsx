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
import { ChevronRight, ChevronDown, Pencil, Trash2, GripVertical, Loader2, X, Circle, Plus } from 'lucide-react';
import { MODEL_PROVIDERS, URL_TITLE_SYSTEM_PROMPT, extractTokens, recordTokenUsage } from '../ai-config';

const api = window.desktopAPI;

// ===== 预设分组定义 =====
const DEFAULT_GROUPS = {
  docs: {
    name: '文档',
    expanded: true,
    links: [],
  },
  workflow: {
    name: '流程系统',
    expanded: true,
    links: [],
  },
  dataPlatform: {
    name: '数据平台',
    expanded: true,
    links: [],
  },
  thirdParty: {
    name: '第三方工具',
    expanded: true,
    links: [],
  },
  social: {
    name: '社交媒体',
    expanded: true,
    links: [],
  },
  uncategorized: {
    name: '未分类',
    expanded: true,
    links: [],
  },
};

const GROUP_ORDER = ['docs', 'workflow', 'dataPlatform', 'thirdParty', 'social', 'uncategorized'];

// 分组色条颜色（用于左侧 2px 色条区分）
const GROUP_ACCENT = {
  docs: 'bg-blue-400',
  workflow: 'bg-amber-400',
  dataPlatform: 'bg-cyan-400',
  thirdParty: 'bg-purple-400',
  social: 'bg-pink-400',
  uncategorized: 'bg-gray-300',
};

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

  // ===== 文档类 =====
  // 飞书 / Lark
  if (h.includes('feishu.cn') || h.includes('feishu.com') || h.includes('larksuite.com') || h.includes('larkoffice.com')) return 'docs';
  // 腾讯文档
  if (h.includes('docs.qq.com') || h.includes('sheets.qq.com') || h.includes('drive.qq.com') || h.includes('slides.qq.com') || h.includes('doc.weixin.qq.com')) return 'docs';
  // Google Docs / Drive
  if (h.includes('docs.google.com') || h.includes('drive.google.com') || h.includes('docs.googleusercontent.com')) return 'docs';
  // Microsoft Office / OneDrive / SharePoint
  if (h.includes('office.com') || h.includes('sharepoint.com') || h.includes('onedrive.live.com') || h.includes('live.com')) return 'docs';
  // 石墨文档
  if (h.includes('shimo.im')) return 'docs';
  // WPS / 金山文档
  if (h.includes('kdocs.cn') || h.includes('wps.cn') || h.includes('365docs.cn') || h.includes('docer.wps.cn')) return 'docs';
  // Confluence / Atlassian
  if (h.includes('confluence.') || h.includes('atlassian.net') || h.includes('jira.')) return 'docs';
  // Notion
  if (h.includes('notion.so') || h.includes('notion.site')) return 'docs';
  // 语雀
  if (h.includes('yuque.com') || h.includes('yuque.antgroup.com')) return 'docs';
  // Coda
  if (h.includes('coda.io')) return 'docs';
  // Dropbox Paper
  if (h.includes('paper.dropbox.com') || h.includes('dropbox.com/paper')) return 'docs';
  // HackMD
  if (h.includes('hackmd.io')) return 'docs';
  // 腾讯乐享
  if (h.includes('lexiangla.com')) return 'docs';
  // 钉钉文档
  if (h.includes('alidocs.dingtalk.com') || h.includes('docs.dingtalk.com')) return 'docs';
  // 百度文库/百度网盘文档
  if (h.includes('wenku.baidu.com') || h.includes('pan.baidu.com')) return 'docs';
  // 有道云笔记
  if (h.includes('note.youdao.com')) return 'docs';
  // 印象笔记 / Evernote
  if (h.includes('evernote.com') || h.includes('yinxiang.com')) return 'docs';
  // 腾讯微云
  if (h.includes('weiyun.com')) return 'docs';
  // 阿里云盘
  if (h.includes('aliyundrive.com') || h.includes('alipan.com')) return 'docs';
  // 飞书多维表格 / 知识库 等路径特征
  if (/\/(docx|wiki|sheets?|base|minutes|mindnotes|file|drive|doc|slide|document|spreadsheets?|presentation|白板|whiteboard)\//i.test(p)) return 'docs';

  // ===== 流程系统 =====
  if (h.startsWith('oa.') || h.includes('.oa.')) return 'workflow';
  if (h.includes('bpm.') || h.includes('.bpm.')) return 'workflow';
  if (h.includes('approval') || h.includes('审批') || h.includes('shenpi')) return 'workflow';
  if (h.includes('workflow') || h.includes('.workflow.')) return 'workflow';
  if (h.includes('process') || h.includes('.process.')) return 'workflow';
  if (h.includes('flow') || h.includes('.flow.')) return 'workflow';

  // ===== 数据平台 =====
  if (h.includes('bi.') || h.includes('.bi.')) return 'dataPlatform';
  if (h.includes('data.') || h.includes('.data.')) return 'dataPlatform';
  if (h.includes('dashboard') || h.includes('.dashboard.')) return 'dataPlatform';
  if (h.includes('grafana') || h.includes('kibana') || h.includes('metabase')) return 'dataPlatform';
  if (h.includes('superset') || h.includes('tableau') || h.includes('powerbi') || h.includes('power-bi')) return 'dataPlatform';
  if (h.includes('dataplat') || h.includes('data-platform') || h.includes('data_platform')) return 'dataPlatform';
  if (h.includes('analytics') || h.includes('.analytics.')) return 'dataPlatform';
  if (h.includes('report') || h.includes('.report.')) return 'dataPlatform';
  if (h.includes('clickhouse') || h.includes('hive') || h.includes('presto') || h.includes('spark')) return 'dataPlatform';
  if (h.includes('dolphinscheduler') || h.includes('airflow') || h.includes('azkaban')) return 'dataPlatform';

  // ===== 第三方工具 / 内容平台 =====
  // 社交媒体
  if (h.includes('bilibili.com') || h.includes('bilibili.cn') || h.includes('b23.tv')) return 'social';
  if (h.includes('xiaohongshu.com') || h.includes('xhslink.com')) return 'social';
  if (h.includes('zhihu.com')) return 'social';
  if (h.includes('douyin.com') || h.includes('iesdouyin.com')) return 'social';
  if (h.includes('weibo.com') || h.includes('weibo.cn')) return 'social';
  // 第三方工具 / 内容平台
  if (h.includes('csdn.net') || h.includes('csdn.com')) return 'thirdParty';
  if (h.includes('github.com')) return 'thirdParty';
  if (h.includes('juejin.cn')) return 'thirdParty';
  if (h.includes('youku.com')) return 'thirdParty';
  if (h.includes('iqiyi.com')) return 'thirdParty';
  if (h.includes('v.qq.com')) return 'thirdParty';
  if (h.includes('taobao.com') || h.includes('tmall.com')) return 'thirdParty';
  if (h.includes('jd.com')) return 'thirdParty';
  if (h.includes('moonshot.cn') || h.includes('kimi.moonshot.cn')) return 'thirdParty';

  return 'uncategorized';
}

function getPathPrefixHint(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    const h = u.hostname.toLowerCase();
    const isDoc =
      h.includes('feishu') || h.includes('larksuite') || h.includes('larkoffice') ||
      h.includes('qq.com') || h.includes('weixin.qq.com') ||
      h.includes('docs.google') || h.includes('drive.google') ||
      h.includes('office.com') || h.includes('sharepoint') ||
      h.includes('shimo.im') || h.includes('kdocs') || h.includes('wps') ||
      h.includes('confluence') || h.includes('atlassian') ||
      h.includes('notion') || h.includes('yuque');
    if (isDoc) {
      if (/\/docx?\//.test(p)) return '文档';
      if (/\/sheets?\//.test(p)) return '表格';
      if (/\/wiki\//.test(p)) return '知识库';
      if (/\/base\//.test(p)) return '多维表格';
      if (/\/minutes\//.test(p)) return '会议纪要';
      if (/\/mindnotes\//.test(p)) return '思维导图';
      if (/\/slide\//.test(p)) return '幻灯片';
      if (/\/file\//.test(p)) return '文件';
      if (/\/document\//.test(p)) return '文档';
      if (/\/spreadsheets?\//.test(p)) return '表格';
      if (/\/presentation\//.test(p)) return '演示文稿';
    }
    // Kimi
    if (h.includes('moonshot') || h.includes('kimi')) return 'Kimi';
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
    const h = u.hostname.toLowerCase();
    const p = u.pathname;
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';

    // 哔哩哔哩
    if (h.includes('bilibili') || h.includes('b23.tv')) {
      const bvMatch = p.match(/\/video\/(BV\w+)/);
      if (bvMatch) return `哔哩哔哩视频 ${bvMatch[1]}`;
      return '哔哩哔哩';
    }
    // 小红书
    if (h.includes('xiaohongshu') || h.includes('xhslink')) return '小红书';
    // 知乎
    if (h.includes('zhihu')) {
      const qMatch = p.match(/\/question\/(\d+)/);
      if (qMatch) return `知乎问题 ${qMatch[1]}`;
      return '知乎';
    }
    // 抖音
    if (h.includes('douyin')) return '抖音';
    // CSDN
    if (h.includes('csdn')) {
      if (last) return decodeURIComponent(last).trim();
      return 'CSDN';
    }
    // GitHub
    if (h.includes('github')) {
      const match = p.match(/^\/([^\/]+)\/([^\/]+)/);
      if (match) return `GitHub: ${match[2]}`;
      return 'GitHub';
    }
    // 掘金
    if (h.includes('juejin')) return '掘金';
    // Kimi
    if (h.includes('moonshot') || h.includes('kimi')) return 'Kimi';

    // 通用规则
    if (last && !/^[a-zA-Z0-9_-]{10,}$/.test(last)) {
      return decodeURIComponent(last).trim();
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

/**
 * 从分享文本中提取 URL 和标题
 * 支持 URL 在文本中间的情况（抖音/小红书/微信分享格式）
 */
function extractShareInfo(text) {
  // 1. 先尝试标准格式：标题在前，URL 在后
  const simpleMatch = text.match(/^(.+?)\s+(https?:\/\/\S+)$/);
  if (simpleMatch) {
    return { name: cleanShareTitle(simpleMatch[1]), url: simpleMatch[2].trim() };
  }

  // 2. URL 在中间的通用提取
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
  if (!urlMatch) return null;

  const url = urlMatch[1].trim();
  // URL 前面的文字作为标题候选
  const beforeUrl = text.slice(0, text.indexOf(urlMatch[0])).trim();
  // URL 后面的文字（通常是引导语，优先级低）
  const afterUrl = text.slice(text.indexOf(urlMatch[0]) + urlMatch[0].length).trim();

  // 优先用 URL 前面的文字，如果前面没有再用后面
  const name = beforeUrl || afterUrl;
  return { name: cleanShareTitle(name), url };
}

/** 清理分享文本中的格式标记和引导语 */
function cleanShareTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/复制此链接，打开.*?搜索，直接观看视频！/g, '')
    .replace(/复制此链接，打开.*?搜索.*?查看/g, '')
    .replace(/点击.*?链接.*?查看/g, '')
    .replace(/#[^\s#]+/g, '') // 移除 hashtag
    .replace(/\d+\.\d+\s+[a-zA-Z]+:\//g, '') // 移除 "1.28 Cho:/" 抖音格式标记
    .replace(/\d{2}\/\d{2}\s+/g, '') // 移除 "07/26 " 日期前缀
    .replace(/[a-zA-Z]@[a-zA-Z]\.[a-zA-Z]{2}\s+/g, '') // 移除 "f@O.Xz " 类标记
    .replace(/\s+/g, ' ')
    .trim();
}

// ===== 四层渐进式识别 =====
async function resolveTitle(url, aiSettings) {
  // 0层：URL 参数
  const paramTitle = getNameFromUrlParams(url);
  if (paramTitle) {
    return { title: paramTitle, favicon: getFaviconUrl(url), source: 'url-param' };
  }

  // 1+2层：主进程 HTTP 抓取（含缓存，3s 硬超时）
  let httpResult = null;
  try {
    const preview = await api.fetchLinkPreview(url);
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
    httpResult = preview;
  } catch {
    httpResult = { error: 'exception' };
  }

  // 3层：Electron 隐藏窗口渲染（HTTP 失败/超时/反爬时启用，约 3-5s）
  if (!httpResult?.title || httpResult?.error === 'TIMEOUT' || httpResult?.error === 'captcha') {
    try {
      const renderResult = await api.fetchRenderedTitle(url);
      if (renderResult.title) {
        return { title: renderResult.title, favicon: renderResult.favicon || getFaviconUrl(url), source: 'render' };
      }
    } catch (err) {
      console.error('[Render] 渲染提取失败:', err);
    }
  }

  // 4层：AI 兜底（根据 URL 生成标题）
  if (aiSettings?.apiKey) {
    const aiResult = await resolveTitleWithAI(url, aiSettings);
    if (aiResult) return aiResult;
  }

  // 5层：本地路径规则兜底
  return timeoutFallback(url);
}

async function resolveTitleWithAI(url, aiSettings) {
  if (!aiSettings || !aiSettings.apiKey) return null;
  const provider = MODEL_PROVIDERS[aiSettings.provider];
  const baseUrl = aiSettings.provider === 'custom' ? aiSettings.customBaseUrl : provider.baseUrl;
  if (!baseUrl) return null;

  const messages = [
    { role: 'system', content: URL_TITLE_SYSTEM_PROMPT },
    { role: 'user', content: `URL: ${url}` },
  ];

  const body = aiSettings.provider === 'custom'
    ? { ...provider.buildBody(messages), model: aiSettings.customModel || '' }
    : provider.buildBody(messages);
  const headers = provider.headers(aiSettings.apiKey);

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    const content = provider.extractContent(data);
    if (content) {
      const tokensUsed = extractTokens(data, content);
      await recordTokenUsage(api, tokensUsed);
      return { title: content.trim().replace(/^["']|["']$/g, ''), favicon: getFaviconUrl(url), source: 'ai' };
    }
  } catch (err) {
    console.error('[AI Title] 识别失败:', err);
  }
  return null;
}

function timeoutFallback(url) {
  const prefix = getPathPrefixHint(url);
  const pathName = guessTitleFromPath(url);
  const title = (prefix || pathName).trim();
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
    'render': ['渲染抓取', 'blue'],
    'ai': ['AI识别', 'purple'],
    'fallback': ['未识别', 'gray'],
    'error-need-login': ['需登录', 'orange'],
    'error-not-found': ['404', 'red'],
  };
  const b = badges[source];
  if (!b) return null;
  const colors = {
    green: ['text-green-500', 'bg-green-500'],
    blue: ['text-blue-500', 'bg-blue-500'],
    purple: ['text-purple-500', 'bg-purple-500'],
    gray: ['text-gray-400', 'bg-gray-400'],
    orange: ['text-orange-500', 'bg-orange-500'],
    red: ['text-red-500', 'bg-red-500'],
  };
  const [textCls, dotCls] = colors[b[1]] || colors.gray;
  return (
    <span className={`flex items-center gap-0.5 text-[11px] font-normal text-[#999] flex-shrink-0`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotCls} inline-block`} />
      {b[0]}
    </span>
  );
}

function SkeletonBar() {
  return <div className="h-3 bg-[#E5E5E5] rounded animate-pulse" style={{ width: '60%' }} />;
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

  // ===== 全局快捷图标栏状态 =====
  const [globalIcons, setGlobalIcons] = useState([]);
  const [editingGlobalId, setEditingGlobalId] = useState(null);
  const [editingGlobalTitle, setEditingGlobalTitle] = useState('');
  const [globalDragIndex, setGlobalDragIndex] = useState(null);
  const [globalDropIndex, setGlobalDropIndex] = useState(null);
  const [addingGlobal, setAddingGlobal] = useState(false);
  const [addingGlobalInput, setAddingGlobalInput] = useState('');
  const [dropHighlight, setDropHighlight] = useState(false);
  const [globalNotice, setGlobalNotice] = useState('');
  // 全局图标识别倒计时：{ iconId: seconds }
  const [globalCountdowns, setGlobalCountdowns] = useState({});
  // 正在识别的全局图标 id 集合
  const [globalLoadingIds, setGlobalLoadingIds] = useState(new Set());
  const globalTimersRef = useRef({}); // iconId → interval
  const globalCancelledRef = useRef(new Set()); // 已取消的全局图标 id

  // AI 配置（用于 URL 标题识别兜底）
  const [aiSettings, setAiSettings] = useState(null);
  useEffect(() => {
    api.storeGet('aiSettings', {}).then((saved) => {
      if (saved && saved.apiKey) setAiSettings(saved);
    });
  }, []);

  // 存储键按工作区分隔
  const storeKey = `quickLinks:${activeWorkspace}`;

  // 旧数据迁移：把 feishu+tencent → docs，oa → workflow
  function migrateGroups(saved) {
    if (!saved) return null;
    const hasOldKeys = saved.feishu || saved.tencent || saved.oa;
    if (!hasOldKeys) return saved;
    const migrated = { ...DEFAULT_GROUPS };
    const docsLinks = [
      ...(saved.feishu?.links || []),
      ...(saved.tencent?.links || []),
      ...(saved.thirdParty?.links || []),
    ];
    if (docsLinks.length > 0) {
      migrated.docs = { ...migrated.docs, links: docsLinks };
    }
    if (saved.oa?.links?.length > 0) {
      migrated.workflow = { ...migrated.workflow, links: saved.oa.links };
    }
    if (saved.uncategorized?.links?.length > 0) {
      migrated.uncategorized = { ...migrated.uncategorized, links: saved.uncategorized.links };
    }
    return migrated;
  }

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
        const migrated = migrateGroups(saved);
        let final = migrated !== saved ? migrated : saved;
        // 补齐新增分组（如社交媒体）
        let needsUpdate = false;
        for (const [key, def] of Object.entries(DEFAULT_GROUPS)) {
          if (!final[key]) {
            final = { ...final, [key]: def };
            needsUpdate = true;
          }
        }
        setGroups(final);
        if (needsUpdate || migrated !== saved) {
          api.storeSet(storeKey, final);
        }
      }
    });
    return () => {
      Object.values(timersRef.current).forEach(clearInterval);
    };
  }, [storeKey]);

  // 加载全局快捷图标（不随工作区变化）
  useEffect(() => {
    api.storeGet('globalQuickIcons', []).then((data) => {
      // 清理可能残留的 loading 项（上次异常退出）
      const cleaned = (data || []).filter((i) => i.titleSource !== 'loading');
      setGlobalIcons(cleaned);
    });
    return () => {
      Object.values(globalTimersRef.current).forEach(clearInterval);
    };
  }, []);

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

    // 0层：剪贴板分割 / 分享文本提取
    const split = splitClipboard(rawText);
    const extracted = extractShareInfo(rawText);
    let url, preParsedTitle = null;
    if (split) {
      url = split.url;
      preParsedTitle = split.name;
    } else if (extracted) {
      url = extracted.url;
      preParsedTitle = extracted.name;
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
      const { title, favicon, source } = await resolveTitle(url, aiSettings);

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
    const trimmed = editingTitle.trim();
    if (!trimmed) return;
    const updated = {
      ...groups,
      [groupId]: {
        ...groups[groupId],
        links: groups[groupId].links.map((l) =>
          l.id === linkId ? { ...l, title: trimmed, titleSource: 'manual' } : l
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
    const raw = e.dataTransfer.getData('x-quicklink-drag');
    if (!raw) { setDragInfo(null); return; }
    let fromGroupId, fromIndex;
    try {
      const data = JSON.parse(raw);
      fromGroupId = data.groupId;
      fromIndex = data.index;
    } catch { setDragInfo(null); return; }

    if (fromGroupId === groupId) {
      // 同组内排序
      if (fromIndex === targetIndex) { setDragInfo(null); return; }
      const links = [...groups[groupId].links];
      const [moved] = links.splice(fromIndex, 1);
      links.splice(targetIndex, 0, moved);
      saveGroups({ ...groups, [groupId]: { ...groups[groupId], links } });
    } else {
      // 跨组移动
      const link = groups[fromGroupId].links[fromIndex];
      if (!link) { setDragInfo(null); return; }
      const fromLinks = [...groups[fromGroupId].links];
      fromLinks.splice(fromIndex, 1);
      const toLinks = [...groups[groupId].links];
      toLinks.splice(targetIndex, 0, link);
      saveGroups({
        ...groups,
        [fromGroupId]: { ...groups[fromGroupId], links: fromLinks },
        [groupId]: { ...groups[groupId], links: toLinks },
      });
    }
    setDragInfo(null);
  };

  // 拖到组标题上 → 跨组移动并追加到末尾
  const handleGroupDrop = (e, groupId) => {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData('x-quicklink-drag');
    if (!raw) { setDragInfo(null); return; }
    let fromGroupId, fromIndex;
    try {
      const data = JSON.parse(raw);
      fromGroupId = data.groupId;
      fromIndex = data.index;
    } catch { setDragInfo(null); return; }
    if (fromGroupId === groupId) { setDragInfo(null); return; }
    const link = groups[fromGroupId]?.links[fromIndex];
    if (!link) { setDragInfo(null); return; }
    const fromLinks = [...groups[fromGroupId].links];
    fromLinks.splice(fromIndex, 1);
    const toLinks = [...groups[groupId].links, link];
    saveGroups({
      ...groups,
      [fromGroupId]: { ...groups[fromGroupId], links: fromLinks },
      [groupId]: { ...groups[groupId], links: toLinks, expanded: true },
    });
    setDragInfo(null);
  };

  // ===== 全局快捷图标栏逻辑 =====
  const saveGlobalIcons = async (updated) => {
    setGlobalIcons(updated);
    await api.storeSet('globalQuickIcons', updated);
  };

  const addGlobalIcon = async (data) => {
    const url = data.url;
    if (globalIcons.find((i) => i.url === url)) {
      setGlobalNotice('该链接已存在');
      setTimeout(() => setGlobalNotice(''), 1500);
      return false;
    }
    if (globalIcons.length >= 15) {
      setGlobalNotice('最多 3 行，请先删除部分图标');
      setTimeout(() => setGlobalNotice(''), 1500);
      return false;
    }

    // 0层：剪贴板分割或传入的标题直接命中
    const split = data.title ? { name: data.title, url } : splitClipboard(url);
    if (split) {
      const newIcon = {
        id: `gicon-${Date.now()}`,
        url: split.url,
        title: split.name,
        favicon: getFaviconUrl(split.url),
        titleSource: 'clipboard-split',
      };
      await saveGlobalIcons([...globalIcons, newIcon]);
      return true;
    }

    // 带数据也直接添加（如拖拽已识别好的链接）
    if (data.title && data.title !== '正在识别...') {
      const newIcon = {
        id: `gicon-${Date.now()}`,
        url,
        title: data.title,
        favicon: data.favicon || getFaviconUrl(url),
        titleSource: data.titleSource || 'manual',
      };
      await saveGlobalIcons([...globalIcons, newIcon]);
      return true;
    }

    // 进入自动识别流程
    const tempId = `gicon-loading-${Date.now()}`;
    const tempIcon = {
      id: tempId,
      url,
      title: '正在识别...',
      favicon: getFaviconUrl(url),
      titleSource: 'loading',
    };
    const withTemp = [...globalIcons, tempIcon];
    await saveGlobalIcons(withTemp);
    startGlobalCountdown(tempId);

    await acquireSlot();
    if (globalCancelledRef.current.has(tempId)) {
      globalCancelledRef.current.delete(tempId);
      releaseSlot();
      return false;
    }

    try {
      const { title, favicon, source } = await resolveTitle(url, aiSettings);
      if (globalCancelledRef.current.has(tempId)) {
        globalCancelledRef.current.delete(tempId);
        releaseSlot();
        return false;
      }
      stopGlobalCountdown(tempId);
      const finalIcon = {
        id: tempId.replace('gicon-loading-', 'gicon-'),
        url,
        title,
        favicon: favicon || getFaviconUrl(url),
        titleSource: source,
      };
      const latest = await api.storeGet('globalQuickIcons', []);
      await saveGlobalIcons(latest.map((i) => (i.id === tempId ? finalIcon : i)));
      return true;
    } catch {
      stopGlobalCountdown(tempId);
      const fallbackTitle = timeoutFallback(url).title;
      const finalIcon = {
        id: tempId.replace('gicon-loading-', 'gicon-'),
        url,
        title: fallbackTitle,
        favicon: getFaviconUrl(url),
        titleSource: 'fallback',
      };
      const latest = await api.storeGet('globalQuickIcons', []);
      await saveGlobalIcons(latest.map((i) => (i.id === tempId ? finalIcon : i)));
      return true;
    } finally {
      releaseSlot();
    }
  };

  const startGlobalCountdown = (iconId) => {
    setGlobalLoadingIds((prev) => new Set(prev).add(iconId));
    setGlobalCountdowns((prev) => ({ ...prev, [iconId]: 3 }));
    globalTimersRef.current[iconId] = setInterval(() => {
      setGlobalCountdowns((prev) => {
        const next = (prev[iconId] || 1) - 1;
        if (next <= 0) {
          clearInterval(globalTimersRef.current[iconId]);
          delete globalTimersRef.current[iconId];
          return { ...prev, [iconId]: 0 };
        }
        return { ...prev, [iconId]: next };
      });
    }, 1000);
  };

  const stopGlobalCountdown = (iconId) => {
    if (globalTimersRef.current[iconId]) {
      clearInterval(globalTimersRef.current[iconId]);
      delete globalTimersRef.current[iconId];
    }
    setGlobalCountdowns((prev) => { const n = { ...prev }; delete n[iconId]; return n; });
    setGlobalLoadingIds((prev) => { const s = new Set(prev); s.delete(iconId); return s; });
  };

  const cancelGlobalRecognition = async (iconId) => {
    globalCancelledRef.current.add(iconId);
    stopGlobalCountdown(iconId);
    await saveGlobalIcons(globalIcons.filter((i) => i.id !== iconId));
  };

  const deleteGlobalIcon = async (id) => {
    await saveGlobalIcons(globalIcons.filter((i) => i.id !== id));
    setContextMenu(null);
  };

  const confirmEditGlobalIcon = async () => {
    const trimmed = editingGlobalTitle.trim();
    if (!trimmed) { setEditingGlobalId(null); return; }
    await saveGlobalIcons(globalIcons.map((i) =>
      i.id === editingGlobalId ? { ...i, title: trimmed } : i
    ));
    setEditingGlobalId(null);
    setEditingGlobalTitle('');
  };

  const reorderGlobalIcons = async (fromIndex, toIndex) => {
    const updated = [...globalIcons];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    await saveGlobalIcons(updated);
  };

  const handleGlobalDrop = async (e) => {
    e.preventDefault();
    setDropHighlight(false);
    const raw = e.dataTransfer.getData('application/json');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data && data.url) {
          const ok = await addGlobalIcon(data);
          if (ok && data.fromGroupId && data.fromLinkId) {
            deleteLink(data.fromGroupId, data.fromLinkId);
          }
        }
      } catch {}
    }
  };

  if (!groups) return null;

  return (
    <div>
      <div className="text-[15px] font-semibold text-[#333] mb-2">快速入口</div>

      <div className="rounded-lg bg-white border border-[#E5E5E5] p-2.5 shadow-sm">
        {/* 全局快捷图标栏 */}
        {globalNotice && <div className="mb-1 text-[11px] font-normal text-amber-500">{globalNotice}</div>}
        <div className="mb-2">
          <div className="flex flex-wrap gap-2 content-start max-h-[102px] overflow-hidden">
            {globalIcons.map((icon, index) => {
              const isLoading = icon.titleSource === 'loading';
              const cd = globalCountdowns[icon.id];
              const isTimedOut = cd !== undefined && cd <= 0;

              if (editingGlobalId === icon.id) {
                return (
                  <input
                    key={icon.id}
                    autoFocus
                    value={editingGlobalTitle}
                    onChange={(e) => setEditingGlobalTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmEditGlobalIcon();
                      if (e.key === 'Escape') { setEditingGlobalId(null); setEditingGlobalTitle(''); }
                    }}
                    onBlur={confirmEditGlobalIcon}
                    onClick={(e) => e.stopPropagation()}
                    className="w-24 px-2 py-1 rounded-md text-[14px] font-normal text-[#333] bg-white border border-[#0099FF] outline-none flex-shrink-0"
                  />
                );
              }

              if (isLoading && !isTimedOut) {
                return (
                  <div
                    key={icon.id}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-[#E5E5E5] flex-shrink-0 min-w-[80px]"
                  >
                    <SkeletonBar />
                    <span className="text-[11px] font-normal text-[#0099FF] flex-shrink-0">
                      {cd !== undefined ? `${cd}s` : '...'}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); cancelGlobalRecognition(icon.id); }}
                      className="p-0.5 rounded hover:bg-[#EBEBEB] text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"
                      title="取消识别"
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              }

              return (
                <div
                  key={icon.id}
                  draggable={!isLoading}
                  onDragStart={(e) => {
                    setGlobalDragIndex(index);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', index.toString());
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setGlobalDropIndex(index);
                  }}
                  onDragLeave={() => {
                    if (globalDropIndex === index) setGlobalDropIndex(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
                    if (!Number.isNaN(from) && from !== index) {
                      reorderGlobalIcons(from, index);
                    }
                    setGlobalDragIndex(null);
                    setGlobalDropIndex(null);
                  }}
                  onDragEnd={() => {
                    setGlobalDragIndex(null);
                    setGlobalDropIndex(null);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, type: 'globalIcon', icon });
                  }}
                  onClick={() => !isLoading && api.openExternal(icon.url)}
                  className={`group flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-[#E5E5E5] hover:bg-[#EBEBEB] cursor-pointer transition-colors flex-shrink-0 ${
                    globalDragIndex === index ? 'opacity-30' : ''
                  } ${globalDropIndex === index && globalDragIndex !== index ? 'border-l-2 border-blue-400' : ''}`}
                  title={icon.url}
                >
                  <img
                    src={icon.favicon || getFaviconUrl(icon.url)}
                    alt=""
                    className="w-4 h-4 rounded-sm flex-shrink-0"
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                  <span className={`text-xs truncate max-w-[80px] ${icon.titleSource === 'error-not-found' ? 'text-red-400 line-through' : 'text-gray-700'}`}>
                    {icon.title}
                  </span>
                </div>
              );
            })}

            {addingGlobal ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const raw = addingGlobalInput.trim();
                  if (!raw) { setAddingGlobal(false); return; }
                  let url = raw;
                  if (!/^https?:\/\//.test(url)) url = 'https://' + url;
                  addGlobalIcon({ url });
                  setAddingGlobalInput('');
                  setAddingGlobal(false);
                }}
                className="flex-shrink-0"
              >
                <input
                  autoFocus
                  value={addingGlobalInput}
                  onChange={(e) => setAddingGlobalInput(e.target.value)}
                  onBlur={() => {
                    const raw = addingGlobalInput.trim();
                    if (raw) {
                      let url = raw;
                      if (!/^https?:\/\//.test(url)) url = 'https://' + url;
                      addGlobalIcon({ url });
                    }
                    setAddingGlobalInput('');
                    setAddingGlobal(false);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="输入链接..."
                  className="w-28 px-2 py-1 rounded-md text-[14px] font-normal text-[#333] bg-white border border-[#0099FF] outline-none flex-shrink-0"
                />
              </form>
            ) : (
              <button
                onClick={() => {
                  if (globalIcons.length >= 15) {
                    setGlobalNotice('最多 3 行，请先删除部分图标');
                    setTimeout(() => setGlobalNotice(''), 1500);
                    return;
                  }
                  setAddingGlobal(true);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (globalIcons.length < 15) setDropHighlight(true);
                }}
                onDragLeave={() => setDropHighlight(false)}
                onDrop={(e) => {
                  if (globalIcons.length >= 15) return;
                  handleGlobalDrop(e);
                }}
                disabled={globalIcons.length >= 15}
                className={`flex-shrink-0 flex items-center justify-center h-[28px] px-2 min-w-[60px] rounded-md border border-dashed transition-colors ${
                  globalIcons.length >= 15
                    ? 'bg-[#F5F5F5] border-[#E5E5E5] text-gray-300 cursor-not-allowed'
                    : dropHighlight
                      ? 'bg-blue-50 border-blue-400 text-blue-500'
                      : 'bg-white border-[#D4D4D4] text-gray-400 hover:border-[#0099FF] hover:text-[#0099FF]'
                }`}
                title={globalIcons.length >= 15 ? '最多 3 行，请先删除部分图标' : '点击添加或拖拽链接至此'}
              >
                <Plus size={14} />
              </button>
            )}
          </div>
          <div className="border-b border-[#E5E5E5] mt-1" />
        </div>

        {/* 快速添加输入框 */}
        <div className="mb-2">
          <input
            ref={inputRef}
            type="text"
            placeholder="粘贴链接，自动识别并命名"
            onPaste={handlePaste}
            onKeyDown={handleInputKeydown}
            className="w-full bg-white border border-[#E5E5E5] rounded-md px-2.5 py-1.5 text-[14px] font-normal text-[#333] placeholder-[#999] outline-none focus:border-[#0099FF] transition-colors"
          />
          {addingStatus === 'fetching' && (
            <div className="text-[11px] font-normal text-blue-500 mt-1 px-1">正在获取信息...</div>
          )}
          {addingStatus === 'done' && (
            <div className="text-[11px] font-normal text-green-500 mt-1 px-1">已添加</div>
          )}
        </div>

        {/* 手风琴分组列表 */}
        {GROUP_ORDER.map((groupId) => {
          const group = groups[groupId];
          if (!group) return null;
          const linkCount = group.links.length;
          const accent = GROUP_ACCENT[groupId] || GROUP_ACCENT.uncategorized;

          return (
            <div key={groupId} className="mb-0.5">
              {/* 紧凑分组标题：左侧色点 + 小字标签 + 箭头，hover 才显示完整背景 */}
              <div
                onClick={() => toggleGroup(groupId)}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => handleGroupDrop(e, groupId)}
                className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-[#EBEBEB] cursor-pointer transition-colors select-none group/header"
              >
                <span className={`w-1.5 h-1.5 rounded-full ${accent} flex-shrink-0`} />
                {group.expanded ? (
                  <ChevronDown size={11} className="text-gray-400 flex-shrink-0" />
                ) : (
                  <ChevronRight size={11} className="text-gray-400 flex-shrink-0" />
                )}
                <span className="text-[13px] font-semibold text-[#555] flex-1 truncate">{group.name}</span>
                <span className="text-[11px] font-normal text-[#bbb] flex-shrink-0">{linkCount}</span>
              </div>

              {group.expanded && (
                <div className="ml-3 border-l border-[#E5E5E5]">
                  {linkCount === 0 ? (
                    <div className="text-[12px] font-normal text-[#ccc] py-1 px-2 ml-1">
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
                          onDragStart={(e) => {
                            handleDragStart(e, groupId, index);
                            e.dataTransfer.setData('x-quicklink-drag', JSON.stringify({ groupId, index }));
                            e.dataTransfer.setData('application/json', JSON.stringify({ url: link.url, title: link.title, favicon: link.favicon, fromGroupId: groupId, fromLinkId: link.id }));
                          }}
                          onDragOver={handleDragOver}
                          onDrop={(e) => handleDrop(e, groupId, index)}
                          onMouseEnter={() => setHoveredLink(link.id)}
                          onMouseLeave={() => setHoveredLink(null)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setContextMenu({ x: e.clientX, y: e.clientY, groupId, link });
                          }}
                          className="group flex items-center gap-1.5 px-1.5 py-[3px] rounded hover:bg-[#EBEBEB] transition-colors cursor-pointer relative"
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
                              <span className="text-[11px] font-normal text-[#0099FF] flex-shrink-0">
                                {cd !== undefined ? `${cd}s` : '...'}
                              </span>
                              <button
                                onClick={(e) => { e.stopPropagation(); cancelRecognition(link.id, groupId); }}
                                className="p-0.5 rounded hover:bg-[#EBEBEB] text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"
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
                              className="flex-1 bg-white border border-[#0099FF] rounded px-1 py-0.5 text-sm text-gray-800 placeholder-gray-400 outline-none min-w-0"
                            />
                          ) : (
                            <>
                              <span className={`flex-1 text-sm truncate min-w-0 ${
                                link.titleSource === 'error-not-found' ? 'text-red-400 line-through' : 'text-gray-700'
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
                                className="p-0.5 rounded hover:bg-[#EBEBEB] text-gray-300 hover:text-blue-500 transition-colors"
                              >
                                <Pencil size={10} />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteLink(groupId, link.id); }}
                                className="p-0.5 rounded hover:bg-[#EBEBEB] text-gray-300 hover:text-red-500 transition-colors"
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
            className="ql-context-menu fixed z-50 bg-white border border-[#E5E5E5] rounded-lg shadow-lg py-1 min-w-[130px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.type === 'globalIcon' ? (
              contextMenu.icon.titleSource === 'loading' ? (
                <>
                  <button
                    onClick={() => { cancelGlobalRecognition(contextMenu.icon.id); setContextMenu(null); }}
                    className="w-full text-left px-3 py-1.5 text-[13px] text-red-500 hover:bg-[#EBEBEB] transition-colors"
                  >
                    取消识别
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => { setEditingGlobalId(contextMenu.icon.id); setEditingGlobalTitle(contextMenu.icon.title); setContextMenu(null); }}
                    className="w-full text-left px-3 py-1.5 text-[13px] text-[#555] hover:bg-[#EBEBEB] transition-colors"
                  >
                    编辑名称
                  </button>
                  <div className="border-t border-[#E5E5E5] my-1" />
                  <button
                    onClick={() => deleteGlobalIcon(contextMenu.icon.id)}
                    className="w-full text-left px-3 py-1.5 text-xs text-red-500 hover:bg-[#EBEBEB] transition-colors"
                  >
                    删除
                  </button>
                </>
              )
            ) : (
              <>
                <button
                  onClick={() => startEdit(contextMenu.link)}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-[#EBEBEB] transition-colors"
                >
                  编辑名称
                </button>
                <div className="border-t border-[#E5E5E5] my-1" />
                <button
                  onClick={() => deleteLink(contextMenu.groupId, contextMenu.link.id)}
                  className="w-full text-left px-3 py-1.5 text-xs text-red-500 hover:bg-[#EBEBEB] transition-colors"
                >
                  删除
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
