/**
 * App.jsx — 主布局组件
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import WorkspaceSwitcher from './components/WorkspaceSwitcher';
import FileNavigator from './components/FileNavigator';
import TodoList from './components/TodoList';
import AIAssistant from './components/AIAssistant';
import QuickLinks from './components/QuickLinks';
import Timeline from './components/Timeline';
import ReminderLevelSettings, { DEFAULT_REMINDER_LEVELS } from './components/ReminderLevelSettings';
import {
  MODEL_PROVIDERS,
  PROVIDER_KEYS,
  DEFAULT_AI_SETTINGS,
  SCREENSHOT_PROMPT,
  MEMORY_SUMMARY_PROMPT,
} from './ai-config';
import { X, Pin, PinOff, Settings, Key, Eye, EyeOff, ChevronDown, Trash2 } from 'lucide-react';

const api = window.desktopAPI;

/**
 * 将 AI 返回的 deadline 字符串解析为时间戳
 * 支持格式：YYYY-MM-DD HH:mm 或 YYYY-MM-DD（默认补 09:00）
 */
function parseDeadlineToTimestamp(deadlineStr) {
  if (!deadlineStr || deadlineStr === '尽快') return null;
  const trimmed = deadlineStr.trim();
  // 匹配 YYYY-MM-DD HH:mm
  const fullMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (fullMatch) {
    const [, y, m, d, h, min] = fullMatch;
    const ts = new Date(`${y}-${m}-${d}T${h}:${min}:00`).getTime();
    return isNaN(ts) ? null : ts;
  }
  // 匹配 YYYY-MM-DD，默认补 09:00
  const dateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    const ts = new Date(`${y}-${m}-${d}T09:00:00`).getTime();
    return isNaN(ts) ? null : ts;
  }
  return null;
}

export default function App() {
  const [activeWorkspace, setActiveWorkspace] = useState('project-a');
  const [workspaces, setWorkspaces] = useState([]);
  const [docked, setDocked] = useState(true);
  const [pinned, setPinned] = useState(false);

  // 设置面板
  const [showSettings, setShowSettings] = useState(false);
  const settingsPanelRef = useRef(null);
  const settingsButtonRef = useRef(null);
  const [showKey, setShowKey] = useState(false);
  const [aiSettings, setAiSettings] = useState(DEFAULT_AI_SETTINGS);
  const [editingShortcut, setEditingShortcut] = useState(false);
  const [shortcutInput, setShortcutInput] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [textTestResult, setTextTestResult] = useState(null);
  const [textTesting, setTextTesting] = useState(false);
  const [snapHintEdge, setSnapHintEdge] = useState(null);
  const [settingsSaveMsg, setSettingsSaveMsg] = useState(null);
  const [autoLaunch, setAutoLaunch] = useState(false);

  // 时间提醒层级配置
  const [reminderLevels, setReminderLevels] = useState(DEFAULT_REMINDER_LEVELS);



  // 数据管理
  const [dataStats, setDataStats] = useState(null);
  const [dataActionMsg, setDataActionMsg] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  // ========== 截图工作流状态（从 AIAssistant 提升） ==========
  const [screenshot, setScreenshot] = useState(null);
  const [screenshotStatus, setScreenshotStatus] = useState('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [aiResult, setAiResult] = useState(null);
  const [tokenStats, setTokenStats] = useState({ today: 0, month: 0, lastRequest: 0 });
  const [focusTodoId, setFocusTodoId] = useState(null);

  // 回收站
  const [showTrash, setShowTrash] = useState(false);
  const [trashedWorkspaces, setTrashedWorkspaces] = useState([]);
  const [trashedTodos, setTrashedTodos] = useState([]);

  const recentScreenshots = useRef({});
  const DAILY_LIMIT = 100000;

  const SCREENSHOT_STATUS = {
    IDLE: 'idle',
    CAPTURING: 'capturing',
    ANALYZING: 'analyzing',
    SUCCESS: 'success',
    ERROR: 'error',
  };

  function extractTokens(data, content) {
    if (data?.usage?.total_tokens) return data.usage.total_tokens;
    if (data?.usage) {
      const u = data.usage;
      return (u.prompt_tokens || 0) + (u.completion_tokens || 0) + (u.total_tokens || 0);
    }
    if (!content) return 0;
    const cjk = (content.match(/[\u4e00-\u9fff]/g) || []).length;
    const ascii = (content.match(/[a-zA-Z0-9]+/g) || []).length;
    return cjk * 2 + ascii;
  }

  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function monthStr() { return new Date().toISOString().slice(0, 7); }

  async function loadTokenStats() {
    const saved = await api.storeGet('tokenStats', null);
    if (!saved) return { today: 0, month: 0, lastRequest: 0, date: todayStr(), monthKey: monthStr() };
    const t = todayStr();
    const m = monthStr();
    return {
      today: saved.date === t ? (saved.today || 0) : 0,
      month: saved.monthKey === m ? (saved.month || 0) : 0,
      lastRequest: saved.lastRequest || 0,
      date: t,
      monthKey: m,
    };
  }

  async function recordTokenUsage(tokens) {
    const stats = await loadTokenStats();
    stats.today += tokens;
    stats.month += tokens;
    stats.lastRequest = tokens;
    stats.date = todayStr();
    stats.monthKey = monthStr();
    await api.storeSet('tokenStats', stats);
    setTokenStats({ today: stats.today, month: stats.month, lastRequest: stats.lastRequest });
  }

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function hashDataUrl(dataUrl) {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return base64.slice(0, 200);
  }

  useEffect(() => {
    loadTokenStats().then((s) => setTokenStats({ today: s.today, month: s.month, lastRequest: s.lastRequest }));
  }, []);

  const handleScreenshotAndAnalyze = useCallback(async () => {
    console.log('[App] handleScreenshotAndAnalyze called');
    setScreenshotStatus(SCREENSHOT_STATUS.CAPTURING);
    setStatusMessage('请选择截图区域...');
    setAiResult(null);
    setScreenshot(null);

    let croppedDataUrl;
    try {
      croppedDataUrl = await api.startScreenshotOverlay();
    } catch (err) {
      setScreenshotStatus(SCREENSHOT_STATUS.IDLE);
      setStatusMessage('');
      return;
    }

    if (!croppedDataUrl) {
      setScreenshotStatus(SCREENSHOT_STATUS.IDLE);
      setStatusMessage('');
      return;
    }

    setScreenshot(croppedDataUrl);

    if (!aiSettings.apiKey) {
      setScreenshotStatus(SCREENSHOT_STATUS.ERROR);
      setStatusMessage('请先在 API 设置中填写 API Key');
      return;
    }

    setScreenshotStatus(SCREENSHOT_STATUS.ANALYZING);
    setStatusMessage('AI 识别中...');

    try {
      const provider = MODEL_PROVIDERS[aiSettings.provider];
      const baseUrl = aiSettings.provider === 'custom' ? aiSettings.customBaseUrl : provider.baseUrl;

      if (!baseUrl) {
        setScreenshotStatus(SCREENSHOT_STATUS.ERROR);
        setStatusMessage('请填写 Base URL');
        return;
      }

      const supportsImage = ['kimi', 'tongyi', 'custom'].includes(aiSettings.provider);
      const messages = supportsImage
        ? [{
            role: 'user',
            content: [
              { type: 'text', text: SCREENSHOT_PROMPT },
              { type: 'image_url', image_url: { url: croppedDataUrl } },
            ],
          }]
        : [{
            role: 'user',
            content: SCREENSHOT_PROMPT + '\n（注：当前模型不支持图片输入，请根据文字提示返回格式）',
          }];

      const body = aiSettings.provider === 'custom'
        ? { ...provider.buildBody(messages), model: aiSettings.customModel || '' }
        : provider.buildBody(messages);

      const url = provider.buildUrl ? provider.buildUrl(baseUrl, aiSettings.apiKey) : `${baseUrl}/chat/completions`;
      const headers = provider.headers(aiSettings.apiKey);

      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const respText = await resp.text().catch(() => '');

      if (!resp.ok) {
        if (resp.status === 403) throw new Error(`API Key 无效或模型无权限 (${resp.status})。请求URL: ${url}`);
        if (resp.status === 404) throw new Error(`模型名称错误 (${resp.status})，当前模型: ${body.model}，请尝试 mimo-v2-pro`);
        if (resp.status === 429) throw new Error('请求过于频繁，请稍后再试');
        if (resp.status === 401) throw new Error(`认证失败 (${resp.status})：API Key 格式可能不对。响应: ${respText.slice(0, 200)}`);
        throw new Error(`API 返回 ${resp.status}: ${respText.slice(0, 200)}`);
      }

      let data;
      try { data = JSON.parse(respText); } catch (parseErr) {
        throw new Error(`API 返回了非 JSON 格式的内容: ${respText.slice(0, 200)}`);
      }

      const content = provider.extractContent(data);
      if (!content) {
        if (data.choices && data.choices.length === 0) {
          throw new Error('API 返回了空的 choices 数组，可能是图片过大或模型不支持当前请求格式');
        }
        if (data.error) throw new Error(`API 返回错误: ${JSON.stringify(data.error).slice(0, 200)}`);
        throw new Error(`API 返回内容为空。完整响应: ${JSON.stringify(data).slice(0, 300)}`);
      }

      let result;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        result = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: content };
      } catch {
        result = { raw: content };
      }

      const tokensUsed = extractTokens(data, content);
      await recordTokenUsage(tokensUsed);
      setAiResult(result);

      if (result.tasks && result.tasks.length > 0) {
        const imgHash = hashDataUrl(croppedDataUrl);
        const cached = recentScreenshots.current[imgHash];
        if (cached && (Date.now() - cached.timestamp < 60 * 60 * 1000)) {
          setScreenshotStatus(SCREENSHOT_STATUS.SUCCESS);
          setStatusMessage('该截图 1 小时内已提交过，已返回上次结果');
          return;
        }

        const firstTask = result.tasks[0];
        const todoText = firstTask.title || '未识别标题';
        const reminderTime = parseDeadlineToTimestamp(firstTask.deadline);
        const newTodo = {
          id: `todo-${Date.now()}`,
          text: todoText,
          done: false,
          priority: firstTask.priority || 'medium',
          isNew: true,
          createdAt: Date.now(),
          reminderTime,
          reminderTriggered: false,
        };

        const currentTodos = await api.storeGet('todosGlobal', []);
        const migrated = currentTodos.map((t) => ({ ...t, priority: t.priority || 'medium' }));
        await api.storeSet('todosGlobal', [newTodo, ...migrated]);
        window.dispatchEvent(new Event('todos-updated'));

        recentScreenshots.current[imgHash] = { todoId: newTodo.id, timestamp: Date.now() };

        // 顺带清理 1 小时前的截图缓存，防止内存无限累积
        const now = Date.now();
        for (const [k, v] of Object.entries(recentScreenshots.current)) {
          if (now - v.timestamp > 60 * 60 * 1000) {
            delete recentScreenshots.current[k];
          }
        }

        setScreenshotStatus(SCREENSHOT_STATUS.SUCCESS);
        setStatusMessage(`已创建待办: ${newTodo.text}`);
        api.dockExpand(5000);
      } else {
        setScreenshotStatus(SCREENSHOT_STATUS.SUCCESS);
        setStatusMessage('未识别到待办事项，请尝试文字更清晰的截图');
        api.dockExpand(5000);
      }
    } catch (err) {
      setScreenshotStatus(SCREENSHOT_STATUS.ERROR);
      setStatusMessage(`API 连接失败: ${err.message}`);
    }
  }, [aiSettings]);

  // 监听全局快捷键触发
  useEffect(() => {
    const cleanup = api.onShortcutTriggered(() => {
      handleScreenshotAndAnalyze();
    });
    return cleanup;
  }, [handleScreenshotAndAnalyze]);

  // 设置面板：点击面板/按钮之外任意处自动收起
  useEffect(() => {
    if (!showSettings) return;
    const onMouseDown = (e) => {
      const panel = settingsPanelRef.current;
      const btn = settingsButtonRef.current;
      if (panel && panel.contains(e.target)) return;
      if (btn && btn.contains(e.target)) return;
      setShowSettings(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showSettings]);

  useEffect(() => {
    api.storeGet('workspaces', []).then((ws) => {
      if (ws.length > 0) {
        setWorkspaces(ws);
        setActiveWorkspace(ws[0].id);
      }
    });
    api.storeGet('aiSettings', DEFAULT_AI_SETTINGS).then((saved) => {
      const merged = { ...DEFAULT_AI_SETTINGS, ...saved };
      setAiSettings(merged);
      setShortcutInput(merged.shortcutKey || 'CmdOrCtrl+Shift+A');
    });

    api.getAutoLaunch().then((enabled) => setAutoLaunch(!!enabled));

    // 加载时间提醒层级配置
    api.storeGet('reminderLevels', null).then((saved) => {
      if (saved && Array.isArray(saved) && saved.length > 0) {
        setReminderLevels(saved);
      }
    });

    // 加载回收站
    api.storeGet('trashedWorkspaces', []).then((saved) => setTrashedWorkspaces(saved || []));
    api.storeGet('trashedTodos', []).then((saved) => setTrashedTodos(saved || []));



    // 加载存储统计
    api.getDataStats().then((stats) => {
      if (stats?.success) setDataStats(stats);
    });

    // 主动拉取当前 Dock 状态（防止启动时 state-changed 事件在 React 挂载前丢失）
    api.dockGetState?.().then((s) => {
      if (!s) return;
      setDocked(!!s.expanded);
      setPinned(!!s.pinned);
    });

    const cleanupState = api.onDockStateChanged((data) => {
      setDocked(data.expanded);
      if (data.pinned !== undefined) setPinned(data.pinned);
    });
    const cleanupHint = api.onDockSnapHint?.((data) => {
      setSnapHintEdge(data?.edge ?? null);
    }) || (() => {});
    return () => { cleanupState(); cleanupHint(); };
  }, []);

  const handleTogglePin = useCallback(async () => {
    const result = await api.dockTogglePin();
    setPinned(result.pinned);
  }, []);

  const addWorkspace = async (name) => {
    const id = `ws-${Date.now()}`;
    const updated = [...workspaces, { id, name }];
    setWorkspaces(updated);
    setActiveWorkspace(id);
    await api.storeSet('workspaces', updated);
  };

  const deleteWorkspace = async (id) => {
    if (workspaces.length <= 1) return;
    const wsToTrash = workspaces.find((ws) => ws.id === id);
    if (wsToTrash) {
      const trashed = await api.storeGet('trashedWorkspaces', []);
      await api.storeSet('trashedWorkspaces', [{ ...wsToTrash, trashedAt: Date.now() }, ...trashed]);
    }
    const updated = workspaces.filter((ws) => ws.id !== id);
    setWorkspaces(updated);
    if (activeWorkspace === id) {
      setActiveWorkspace(updated[0].id);
    }
    await api.storeSet('workspaces', updated);
  };

  const renameWorkspace = async (id, newName) => {
    const updated = workspaces.map((ws) => ws.id === id ? { ...ws, name: newName } : ws);
    setWorkspaces(updated);
    await api.storeSet('workspaces', updated);
  };

  const reorderWorkspaces = async (fromIndex, toIndex) => {
    const updated = [...workspaces];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    setWorkspaces(updated);
    await api.storeSet('workspaces', updated);
  };

  const handleSaveSettings = async () => {
    try {
      await api.storeSet('aiSettings', aiSettings);
      setSettingsSaveMsg({ type: 'success', text: '保存成功' });
    } catch (err) {
      setSettingsSaveMsg({ type: 'error', text: `保存失败: ${err?.message || '未知错误'}` });
    }
    setTimeout(() => setSettingsSaveMsg(null), 2000);
  };

  const handleExportData = async () => {
    setExporting(true);
    setDataActionMsg(null);
    let msgType = null;
    try {
      const result = await api.exportData();
      if (result.success) {
        msgType = 'success';
        setDataActionMsg({
          type: 'success',
          text: `导出成功: ${result.excelPath?.split?.(/[\\/]/)?.pop?.() || ''} + 备份.json`,
        });
        // 刷新统计
        const stats = await api.getDataStats();
        if (stats?.success) setDataStats(stats);
      } else if (result.cancelled) {
        // 用户取消，不提示
      } else {
        msgType = 'error';
        setDataActionMsg({ type: 'error', text: `导出失败: ${result.error}` });
      }
    } catch (err) {
      msgType = 'error';
      setDataActionMsg({ type: 'error', text: `导出失败: ${err?.message || '未知错误'}` });
    } finally {
      setExporting(false);
      if (msgType !== 'success') {
        setTimeout(() => setDataActionMsg(null), 3000);
      }
    }
  };

  // 回收站操作
  const restoreWorkspace = async (ws) => {
    const updated = [...workspaces, ws];
    setWorkspaces(updated);
    await api.storeSet('workspaces', updated);
    const remaining = trashedWorkspaces.filter((w) => w.id !== ws.id);
    setTrashedWorkspaces(remaining);
    await api.storeSet('trashedWorkspaces', remaining);
  };

  const restoreTodo = async (todo) => {
    const current = await api.storeGet('todosGlobal', []);
    const updated = [...current, todo];
    await api.storeSet('todosGlobal', updated);
    window.dispatchEvent(new Event('todos-updated'));
    const remaining = trashedTodos.filter((t) => t.id !== todo.id);
    setTrashedTodos(remaining);
    await api.storeSet('trashedTodos', remaining);
  };

  const permanentlyDeleteWorkspace = async (id) => {
    const remaining = trashedWorkspaces.filter((w) => w.id !== id);
    setTrashedWorkspaces(remaining);
    await api.storeSet('trashedWorkspaces', remaining);
  };

  const permanentlyDeleteTodo = async (id) => {
    const remaining = trashedTodos.filter((t) => t.id !== id);
    setTrashedTodos(remaining);
    await api.storeSet('trashedTodos', remaining);
  };

  const clearTrash = async () => {
    setTrashedWorkspaces([]);
    setTrashedTodos([]);
    await api.storeSet('trashedWorkspaces', []);
    await api.storeSet('trashedTodos', []);
  };

  const handleImportData = async () => {
    setImporting(true);
    setDataActionMsg(null);
    let msgType = null;
    try {
      const result = await api.importData();
      if (result.success) {
        msgType = 'success';
        setDataActionMsg({ type: 'success', text: result.message || '数据已恢复' });
        // 刷新统计
        const stats = await api.getDataStats();
        if (stats?.success) setDataStats(stats);
      } else if (result.cancelled) {
        // 用户取消，不提示
      } else {
        msgType = 'error';
        setDataActionMsg({ type: 'error', text: `导入失败: ${result.error}` });
      }
    } catch (err) {
      msgType = 'error';
      setDataActionMsg({ type: 'error', text: `导入失败: ${err?.message || '未知错误'}` });
    } finally {
      setImporting(false);
      if (msgType !== 'success') {
        setTimeout(() => setDataActionMsg(null), 3000);
      }
    }
  };

  const handleSaveShortcut = async () => {
    const key = shortcutInput.trim();
    if (!key) {
      await api.unregisterShortcut();
      const updated = { ...aiSettings, shortcutKey: '' };
      setAiSettings(updated);
      await api.storeSet('aiSettings', updated);
      setEditingShortcut(false);
      return;
    }
    const result = await api.registerShortcut(key);
    if (result.success) {
      const updated = { ...aiSettings, shortcutKey: key };
      setAiSettings(updated);
      await api.storeSet('aiSettings', updated);
      setEditingShortcut(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const provider = MODEL_PROVIDERS[aiSettings.provider];
    const baseUrl = aiSettings.provider === 'custom' ? aiSettings.customBaseUrl : provider.baseUrl;
    if (!baseUrl) {
      setTestResult({ success: false, message: '请填写 Base URL' });
      setTesting(false);
      return;
    }
    if (!aiSettings.apiKey) {
      setTestResult({ success: false, message: '请填写 API Key' });
      setTesting(false);
      return;
    }
    const testMessages = [{ role: 'user', content: 'Hello, reply with "OK" only.' }];
    const body = aiSettings.provider === 'custom'
      ? { ...provider.buildBody(testMessages), model: aiSettings.customModel || '' }
      : provider.buildBody(testMessages);
    const url = provider.buildUrl ? provider.buildUrl(baseUrl, aiSettings.apiKey) : `${baseUrl}/chat/completions`;
    const headers = provider.headers(aiSettings.apiKey);
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => '');
        if (resp.status === 403) setTestResult({ success: false, message: `403 Forbidden: API Key 无效或模型无权限。请求URL: ${url}` });
        else if (resp.status === 404) setTestResult({ success: false, message: `404 Not Found: 模型名称错误，当前模型: ${body.model}，请尝试 mimo-v2-pro` });
        else if (resp.status === 429) setTestResult({ success: false, message: '429 Too Many Requests: 请求频繁，请稍后再试' });
        else if (resp.status === 401) setTestResult({ success: false, message: `401 Unauthorized: 认证失败，请检查 Authorization 头格式。当前: ${headers.Authorization?.slice(0, 20)}...` });
        else setTestResult({ success: false, message: `${resp.status} ${resp.statusText}: ${errorText.slice(0, 200)}` });
      } else {
        const data = await resp.json();
        const content = provider.extractContent(data);
        setTestResult({ success: true, message: `连接成功! 模型: ${body.model}, 回复: ${content.slice(0, 50)}` });
      }
    } catch (err) {
      setTestResult({ success: false, message: `网络错误: ${err.message}` });
    } finally {
      setTesting(false);
    }
  };

  const handleTextTest = async () => {
    setTextTesting(true);
    setTextTestResult(null);
    const provider = MODEL_PROVIDERS[aiSettings.provider];
    const baseUrl = aiSettings.provider === 'custom' ? aiSettings.customBaseUrl : provider.baseUrl;
    if (!baseUrl) {
      setTextTestResult({ success: false, message: '请填写 Base URL' });
      setTextTesting(false);
      return;
    }
    if (!aiSettings.apiKey) {
      setTextTestResult({ success: false, message: '请填写 API Key' });
      setTextTesting(false);
      return;
    }
    const testMessages = [{
      role: 'user',
      content: '请分析这个需求，提取待办事项。需求：完成项目v2.0的登录模块开发，截止周五。返回JSON格式：{tasks:[{title, deadline, priority}]}',
    }];
    const body = aiSettings.provider === 'custom'
      ? { ...provider.buildBody(testMessages), model: aiSettings.customModel || '' }
      : provider.buildBody(testMessages);
    const url = provider.buildUrl ? provider.buildUrl(baseUrl, aiSettings.apiKey) : `${baseUrl}/chat/completions`;
    const headers = provider.headers(aiSettings.apiKey);
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const respText = await resp.text();
      if (!resp.ok) {
        setTextTestResult({ success: false, message: `HTTP ${resp.status}: ${respText.slice(0, 300)}` });
      } else {
        let data;
        try { data = JSON.parse(respText); } catch { data = null; }
        if (data) {
          const content = provider.extractContent(data);
          setTextTestResult({ success: true, message: `成功! 回复: ${content.slice(0, 150)}` });
        } else {
          setTextTestResult({ success: false, message: `非JSON响应: ${respText.slice(0, 300)}` });
        }
      }
    } catch (err) {
      setTextTestResult({ success: false, message: `网络错误: ${err.message}` });
    } finally {
      setTextTesting(false);
    }
  };

  const currentProvider = MODEL_PROVIDERS[aiSettings.provider];

  return (
    <div className="h-full flex flex-col bg-white rounded-xl border border-[#E5E5E5] shadow-sm overflow-hidden relative">
      {/* 边缘吸附高亮提示 */}
      {snapHintEdge && (
        <div className={`snap-hint snap-hint--${snapHintEdge}`} aria-hidden="true" />
      )}

      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-2 drag-region">
        <span className="text-sm font-medium text-gray-800">DesktopSecretary</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleTogglePin}
            className={`p-1 rounded transition-colors ${
              pinned
                ? 'bg-[#E6F4FF] text-[#0099FF] hover:bg-[#D6EEFF]'
                : 'hover:bg-[#EBEBEB] text-gray-400 hover:text-gray-600'
            }`}
            title={pinned ? '取消固定' : '固定窗口'}
          >
            {pinned ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
          <button
            onClick={() => api.closeApp()}
            className="p-1 rounded hover:bg-[#EBEBEB] transition-colors text-gray-400 hover:text-gray-600"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* 待办列表 */}
      <div className="px-4 pb-2">
        <TodoList
          workspaces={workspaces}
          activeWorkspace={activeWorkspace}
          onSwitchWorkspace={setActiveWorkspace}
          onScreenshot={handleScreenshotAndAnalyze}
          screenshotStatus={screenshotStatus}
          reminderLevels={reminderLevels}
          focusTodoId={focusTodoId}
        />
      </div>

      {/* 工作区切换 — 撑满宽度，与下方项目区融为一体 */}
      <WorkspaceSwitcher
        workspaces={workspaces}
        active={activeWorkspace}
        onSwitch={setActiveWorkspace}
        onAdd={addWorkspace}
        onDelete={deleteWorkspace}
        onReorder={reorderWorkspaces}
        onRename={renameWorkspace}
      />

      {/* 待办时间轴 */}
      <Timeline
        activeWorkspace={activeWorkspace}
        reminderLevels={reminderLevels}
        onFocusTodo={setFocusTodoId}
      />

      {/* 模块区域 */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
        <QuickLinks activeWorkspace={activeWorkspace} />
        <FileNavigator activeWorkspace={activeWorkspace} />
        <AIAssistant
          settings={aiSettings}
          screenshot={screenshot}
          screenshotStatus={screenshotStatus}
          statusMessage={statusMessage}
          aiResult={aiResult}
          tokenStats={tokenStats}
          formatTokens={formatTokens}
          dailyLimit={DAILY_LIMIT}
        />
      </div>

      {/* 设置面板 */}
      {showSettings && (
        <div
          ref={settingsPanelRef}
          className="mx-4 mb-2 rounded-lg bg-[#F0F0F0] border border-[#D4D4D4] p-3 space-y-3 shadow-md max-h-[50vh] overflow-y-auto"
        >
          {/* 设置标题 */}
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-gray-700 tracking-wide">设置</h2>
            <span className="text-[9px] text-gray-400">Desktop Secretary</span>
          </div>

          {/* ===== 通用设置 ===== */}
          <section className="bg-white rounded-md p-2.5 space-y-2">
            <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">通用</h3>
            <div className="text-[10px] text-gray-400 leading-relaxed">
              拖动顶部标题栏可移动窗口。靠近屏幕边缘自动吸附并收起；浮空时可调整尺寸。
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">开机自动启动</span>
              <button
                onClick={async () => {
                  const next = !autoLaunch;
                  setAutoLaunch(next);
                  await api.setAutoLaunch(next);
                }}
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  autoLaunch ? 'bg-[#0099FF]' : 'bg-gray-300'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                    autoLaunch ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </section>

          {/* ===== AI 配置 ===== */}
          <section className="bg-white rounded-md p-2.5 space-y-2">
            <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">AI 配置</h3>

            <div className="space-y-1">
              <label className="text-[10px] text-gray-500">模型</label>
              <div className="relative">
                <select
                  value={aiSettings.provider}
                  onChange={(e) => setAiSettings({ ...aiSettings, provider: e.target.value })}
                  className="w-full px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 outline-none appearance-none cursor-pointer"
                >
                  {PROVIDER_KEYS.map((key) => (
                    <option key={key} value={key} className="bg-white text-gray-800">
                      {MODEL_PROVIDERS[key].label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-gray-500">
                {aiSettings.provider === 'wenxin' ? 'Access Token' : 'API Key'}
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={aiSettings.apiKey}
                  onChange={(e) => setAiSettings({ ...aiSettings, apiKey: e.target.value })}
                  placeholder={aiSettings.provider === 'wenxin' ? '输入 Access Token...' : '输入 API Key...'}
                  className="w-full px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 placeholder-gray-300 outline-none focus:border-[#0099FF] pr-6"
                />
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"
                >
                  {showKey ? <EyeOff size={10} /> : <Eye size={10} />}
                </button>
              </div>
            </div>

            {aiSettings.provider === 'custom' && (
              <>
                <div className="space-y-1">
                  <label className="text-[10px] text-gray-500">Base URL</label>
                  <input
                    value={aiSettings.customBaseUrl}
                    onChange={(e) => setAiSettings({ ...aiSettings, customBaseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    className="w-full px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 placeholder-gray-300 outline-none focus:border-[#0099FF]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-gray-500">模型名称</label>
                  <input
                    value={aiSettings.customModel}
                    onChange={(e) => setAiSettings({ ...aiSettings, customModel: e.target.value })}
                    placeholder="输入模型名称..."
                    className="w-full px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 placeholder-gray-300 outline-none focus:border-[#0099FF]"
                  />
                </div>
              </>
            )}

            <div className="text-[9px] text-gray-400">
              端点: {aiSettings.provider === 'custom' ? (aiSettings.customBaseUrl || '未设置') : currentProvider.baseUrl}
            </div>

            {/* 保存 */}
            <div className="flex gap-1 pt-1">
              <button
                onClick={handleSaveSettings}
                className="flex-1 py-1 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[10px] transition-colors flex items-center justify-center gap-1"
              >
                <Key size={10} />
                保存
              </button>
            </div>
            {settingsSaveMsg && (
              <div className={`text-[10px] rounded-md px-2 py-1.5 ${
                settingsSaveMsg.type === 'success'
                  ? 'text-green-600 bg-green-50 border border-green-200'
                  : 'text-red-600 bg-red-50 border border-red-200'
              }`}>
                {settingsSaveMsg.text}
              </div>
            )}

            {/* 测试 */}
            <div className="border-t border-[#F0F0F0] pt-2 space-y-2">
              <div className="flex gap-1">
                <button
                  onClick={handleTestConnection}
                  disabled={testing}
                  className="flex-1 py-1 rounded bg-green-50 hover:bg-green-100 text-green-600 text-[10px] transition-colors disabled:opacity-50 border border-green-200"
                >
                  {testing ? '测试中...' : '测试连接'}
                </button>
                <button
                  onClick={handleTextTest}
                  disabled={textTesting}
                  className="flex-1 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-600 text-[10px] transition-colors disabled:opacity-50 border border-amber-200"
                >
                  {textTesting ? '测试中...' : '文字 API 测试'}
                </button>
              </div>
              {testResult && (
                <div className={`text-[10px] rounded-md px-2 py-1.5 ${
                  testResult.success
                    ? 'text-green-600 bg-green-50 border border-green-200'
                    : 'text-red-600 bg-red-50 border border-red-200'
                }`}>
                  {testResult.message}
                </div>
              )}
              {textTestResult && (
                <div className={`text-[10px] rounded-md px-2 py-1.5 ${
                  textTestResult.success
                    ? 'text-green-600 bg-green-50 border border-green-200'
                    : 'text-red-600 bg-red-50 border border-red-200'
                }`}>
                  {textTestResult.message}
                </div>
              )}
            </div>
          </section>

          {/* ===== 快捷键 ===== */}
          <section className="bg-white rounded-md p-2.5 space-y-2">
            <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">快捷键</h3>
            {editingShortcut ? (
              <div className="flex gap-1">
                <input
                  autoFocus
                  value={shortcutInput}
                  onChange={(e) => setShortcutInput(e.target.value)}
                  onKeyDown={(e) => {
                    e.preventDefault();
                    const parts = [];
                    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
                    if (e.shiftKey) parts.push('Shift');
                    if (e.altKey) parts.push('Alt');
                    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
                      parts.push(key);
                      setShortcutInput(parts.join('+'));
                    }
                  }}
                  placeholder="按下快捷键组合..."
                  className="flex-1 px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 placeholder-gray-300 outline-none focus:border-[#0099FF]"
                />
                <button onClick={handleSaveShortcut} className="px-2 py-1 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[10px]">保存</button>
                <button
                  onClick={() => { setEditingShortcut(false); setShortcutInput(aiSettings.shortcutKey || ''); }}
                  className="px-2 py-1 rounded bg-[#F5F5F5] text-gray-500 text-[10px]"
                >
                  取消
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <code className="flex-1 px-2 py-1 text-[10px] rounded bg-[#F5F5F5] border border-[#E5E5E5] text-gray-600">
                  {aiSettings.shortcutKey || '未设置'}
                </code>
                <button
                  onClick={() => setEditingShortcut(true)}
                  className="px-2 py-1 rounded bg-[#F5F5F5] hover:bg-[#EBEBEB] text-gray-500 text-[10px]"
                >
                  修改
                </button>
              </div>
            )}
            <div className="text-[9px] text-gray-400">全局快捷键，无需点击按钮即可截图</div>
          </section>

          {/* ===== 时间提醒层级 ===== */}
          <section className="bg-white rounded-md p-2.5 space-y-2">
            <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">时间提醒层级</h3>
            <ReminderLevelSettings
              levels={reminderLevels}
              onChange={async (next) => {
                setReminderLevels(next);
                await api.storeSet('reminderLevels', next);
              }}
            />
          </section>

          {/* ===== 数据管理 ===== */}
          <section className="bg-white rounded-md p-2.5 space-y-2">
            <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">数据管理</h3>

            {dataStats && (
              <div className="space-y-1">
                <div className="text-[10px] text-gray-500">
                  存储占用: <span className="font-medium text-gray-700">{dataStats.fileSizeFormatted}</span>
                </div>
                <div className="text-[9px] text-gray-400">
                  {dataStats.counts.workspaces} 个工作区 · {dataStats.counts.todos} 条待办 · {dataStats.counts.links} 个链接
                </div>
              </div>
            )}

            <div className="flex gap-1">
              <button
                onClick={handleExportData}
                disabled={exporting}
                className="flex-1 py-1 rounded bg-[#F5F5F5] hover:bg-[#EBEBEB] text-gray-600 text-[10px] transition-colors disabled:opacity-50 border border-[#E5E5E5]"
              >
                {exporting ? '导出中...' : '导出数据'}
              </button>
              <button
                onClick={handleImportData}
                disabled={importing}
                className="flex-1 py-1 rounded bg-[#F5F5F5] hover:bg-[#EBEBEB] text-gray-600 text-[10px] transition-colors disabled:opacity-50 border border-[#E5E5E5]"
              >
                {importing ? '导入中...' : '导入恢复'}
              </button>
            </div>

            {dataActionMsg && (
              <div className={`text-[10px] rounded-md px-2 py-1.5 ${
                dataActionMsg.type === 'success'
                  ? 'text-green-600 bg-green-50 border border-green-200'
                  : 'text-red-600 bg-red-50 border border-red-200'
              }`}>
                {dataActionMsg.text}
              </div>
            )}

            <div className="text-[9px] text-gray-400 leading-relaxed">
              Excel 用于查看历史，JSON 用于换电脑时完整恢复。
            </div>
          </section>
        </div>
      )}

      {/* 回收站面板 */}
      {showTrash && (
        <div className="mx-4 mb-2 rounded-lg bg-[#F0F0F0] border border-[#D4D4D4] p-3 space-y-3 shadow-md max-h-[40vh] overflow-y-auto">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-gray-700 tracking-wide">回收站</h2>
            <div className="flex items-center gap-1">
              {(trashedWorkspaces.length > 0 || trashedTodos.length > 0) && (
                <button
                  onClick={clearTrash}
                  className="text-[10px] px-2 py-0.5 rounded bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                >
                  清空全部
                </button>
              )}
              <span className="text-[9px] text-gray-400">
                {trashedWorkspaces.length} 项目 · {trashedTodos.length} 待办
              </span>
            </div>
          </div>

          {/* 已删除项目 */}
          {trashedWorkspaces.length > 0 && (
            <section className="bg-white rounded-md p-2.5 space-y-2">
              <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">项目</h3>
              <div className="space-y-1">
                {trashedWorkspaces.map((ws) => (
                  <div key={ws.id} className="flex items-center justify-between text-xs">
                    <span className="text-gray-700 truncate max-w-[120px]">{ws.name}</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => restoreWorkspace(ws)}
                        className="text-[10px] px-2 py-0.5 rounded bg-green-50 text-green-600 hover:bg-green-100 transition-colors"
                      >
                        恢复
                      </button>
                      <button
                        onClick={() => permanentlyDeleteWorkspace(ws.id)}
                        className="text-[10px] px-2 py-0.5 rounded bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 已删除待办 */}
          {trashedTodos.length > 0 && (
            <section className="bg-white rounded-md p-2.5 space-y-2">
              <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">待办</h3>
              <div className="space-y-1">
                {trashedTodos.map((todo) => (
                  <div key={todo.id} className="flex items-center justify-between text-xs">
                    <span className="text-gray-700 truncate max-w-[120px]">{todo.text}</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => restoreTodo(todo)}
                        className="text-[10px] px-2 py-0.5 rounded bg-green-50 text-green-600 hover:bg-green-100 transition-colors"
                      >
                        恢复
                      </button>
                      <button
                        onClick={() => permanentlyDeleteTodo(todo.id)}
                        className="text-[10px] px-2 py-0.5 rounded bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {trashedWorkspaces.length === 0 && trashedTodos.length === 0 && (
            <div className="text-[10px] text-gray-400 text-center py-2">回收站为空</div>
          )}
        </div>
      )}

      {/* 底部操作栏 */}
      <div className="flex items-center justify-end px-4 py-1.5 border-t border-[#E5E5E5] gap-1">
        <button
          onClick={() => { setShowTrash(!showTrash); setShowSettings(false); }}
          className={`p-1 rounded transition-colors ${
            showTrash ? 'bg-[#E6F4FF] text-[#0099FF]' : 'text-gray-400 hover:text-gray-600 hover:bg-[#EBEBEB]'
          }`}
          title="回收站"
        >
          <Trash2 size={14} />
        </button>
        <button
          ref={settingsButtonRef}
          onClick={() => { setShowSettings(!showSettings); setShowTrash(false); }}
          className={`p-1 rounded transition-colors ${
            showSettings ? 'bg-[#E6F4FF] text-[#0099FF]' : 'text-gray-400 hover:text-gray-600 hover:bg-[#EBEBEB]'
          }`}
          title="设置"
        >
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
}
