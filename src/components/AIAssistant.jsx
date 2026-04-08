/**
 * AIAssistant.jsx — AI 助手卡片模块（多模型 + 完整截图工作流）
 *
 * 功能:
 *   1. 截图加待办 — 完整工作流：截屏 → AI 识别 → 生成待办
 *   2. 文件建议区域 — 扫描桌面最近修改文件，提示整理建议
 *   3. 操作按钮: [确认整理] [忽略]
 *   4. 设置: 模型选择 + API Key + 自定义 Base URL + 快捷键
 *   5. 全局快捷键触发截图
 *   6. 前台窗口智能识别（检测聊天应用）
 *
 * 数据存储键:
 *   - aiSettings: { provider, apiKey, customBaseUrl, customModel, shortcutKey }
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Camera, Sparkles, Settings, Key, Eye, EyeOff, ChevronDown, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

const api = window.desktopAPI;

// ========== 模型配置 ==========
const MODEL_PROVIDERS = {
  kimi: {
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (messages) => ({
      model: 'moonshot-v1-8k',
      messages,
      max_tokens: 1024,
    }),
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  tongyi: {
    label: '通义千问 (Aliyun)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (messages) => ({
      model: 'qwen-max',
      messages,
      max_tokens: 1024,
    }),
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  wenxin: {
    label: '文心一言 (Baidu)',
    baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat',
    headers: (key) => ({
      'Content-Type': 'application/json',
    }),
    buildBody: (messages) => ({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    buildUrl: (baseUrl, key) => `${baseUrl}/completions?access_token=${key}`,
    extractContent: (data) => data.result || data.choices?.[0]?.message?.content || '',
  },
  doubao: {
    label: '豆包 (ByteDance)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (messages) => ({
      model: 'doubao-pro-4k',
      messages,
      max_tokens: 1024,
    }),
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  custom: {
    label: '自定义',
    baseUrl: '',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (messages) => ({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 1024,
    }),
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
};

const PROVIDER_KEYS = Object.keys(MODEL_PROVIDERS);

// ========== Prompt 模板 ==========
const SCREENSHOT_PROMPT = `请分析这张截图，提取其中的待办事项。如果是聊天、邮件或文档，提取：任务内容、截止时间、涉及人员、优先级。返回JSON格式：{tasks:[{title, deadline, priority, source}]}。如果没有明确待办，返回空数组。`;
const MEMORY_SUMMARY_PROMPT = `请总结以下用户与AI的对话，提取关键信息（项目名称、待办、决策、文件路径），用于后续检索。摘要不超过100字，同时提取3-5个关键词。`;

// ========== 截图工作流状态 ==========
const SCREENSHOT_STATUS = {
  IDLE: 'idle',           // 空闲
  CAPTURING: 'capturing', // 正在截图
  ANALYZING: 'analyzing', // AI 识别中
  SUCCESS: 'success',     // 识别成功
  ERROR: 'error',         // 错误
};

const STATUS_MESSAGES = {
  [SCREENSHOT_STATUS.IDLE]: '',
  [SCREENSHOT_STATUS.CAPTURING]: '正在截图...',
  [SCREENSHOT_STATUS.ANALYZING]: 'AI 识别中...',
  [SCREENSHOT_STATUS.SUCCESS]: '',  // 动态生成
  [SCREENSHOT_STATUS.ERROR]: '',    // 动态生成
};

// 默认设置
const DEFAULT_SETTINGS = {
  provider: 'kimi',
  apiKey: '',
  customBaseUrl: '',
  customModel: 'mimo-chat',
  shortcutKey: 'Ctrl+Shift+A',
};

export default function AIAssistant() {
  const [screenshot, setScreenshot] = useState(null);
  const [desktopFiles, setDesktopFiles] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  // AI 设置
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  // 截图工作流状态
  const [screenshotStatus, setScreenshotStatus] = useState(SCREENSHOT_STATUS.IDLE);
  const [statusMessage, setStatusMessage] = useState('');
  const [aiResult, setAiResult] = useState(null);
  // 快捷键编辑
  const [editingShortcut, setEditingShortcut] = useState(false);
  const [shortcutInput, setShortcutInput] = useState('');
  // 前台窗口检测
  const [frontWindow, setFrontWindow] = useState(null);
  // 测试连接状态
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  // 加载设置
  useEffect(() => {
    api.storeGet('aiSettings', DEFAULT_SETTINGS).then((saved) => {
      const merged = { ...DEFAULT_SETTINGS, ...saved };
      setSettings(merged);
      setShortcutInput(merged.shortcutKey || 'Ctrl+Shift+A');
    });
  }, []);

  // 监听全局快捷键触发
  useEffect(() => {
    const cleanup = api.onShortcutTriggered(() => {
      handleScreenshotAndAnalyze();
    });
    return cleanup;
  }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps

  // 扫描桌面文件
  const handleScanDesktop = async () => {
    const files = await api.getDesktopFiles();
    setDesktopFiles(files);
  };

  useEffect(() => {
    handleScanDesktop();
  }, []);

  // 保存设置
  const handleSaveSettings = async () => {
    await api.storeSet('aiSettings', settings);
    setShowSettings(false);
  };

  // 测试连接
  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);

    const provider = MODEL_PROVIDERS[settings.provider];
    const baseUrl = settings.provider === 'custom' ? settings.customBaseUrl : provider.baseUrl;

    if (!baseUrl) {
      setTestResult({ success: false, message: '请填写 Base URL' });
      setTesting(false);
      return;
    }
    if (!settings.apiKey) {
      setTestResult({ success: false, message: '请填写 API Key' });
      setTesting(false);
      return;
    }

    const testMessages = [{ role: 'user', content: 'Hello, reply with "OK" only.' }];
    const body = settings.provider === 'custom'
      ? { ...provider.buildBody(testMessages), model: settings.customModel || 'mimo-chat' }
      : provider.buildBody(testMessages);
    const url = provider.buildUrl ? provider.buildUrl(baseUrl, settings.apiKey) : `${baseUrl}/chat/completions`;
    const headers = provider.headers(settings.apiKey);

    console.log('[Test Debug] URL:', url);
    console.log('[Test Debug] Headers:', JSON.stringify(headers));
    console.log('[Test Debug] Body:', JSON.stringify(body));

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      console.log('[Test Debug] Status:', resp.status);

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => '');
        console.log('[Test Debug] Error:', errorText);

        if (resp.status === 403) {
          setTestResult({ success: false, message: `403 Forbidden: API Key 无效或模型无权限。请求URL: ${url}` });
        } else if (resp.status === 404) {
          setTestResult({ success: false, message: `404 Not Found: 模型名称错误，当前模型: ${body.model}，请尝试 mimo-v2-pro` });
        } else if (resp.status === 429) {
          setTestResult({ success: false, message: '429 Too Many Requests: 请求频繁，请稍后再试' });
        } else if (resp.status === 401) {
          setTestResult({ success: false, message: `401 Unauthorized: 认证失败，请检查 Authorization 头格式。当前: ${headers.Authorization?.slice(0, 20)}...` });
        } else {
          setTestResult({ success: false, message: `${resp.status} ${resp.statusText}: ${errorText.slice(0, 200)}` });
        }
      } else {
        const data = await resp.json();
        const content = provider.extractContent(data);
        console.log('[Test Debug] Response:', JSON.stringify(data).slice(0, 300));
        setTestResult({
          success: true,
          message: `连接成功! 模型: ${body.model}, 回复: ${content.slice(0, 50)}`,
        });
      }
    } catch (err) {
      console.log('[Test Debug] Exception:', err.message);
      setTestResult({ success: false, message: `网络错误: ${err.message}` });
    } finally {
      setTesting(false);
    }
  };

  // 截图 + AI 识别（完整工作流）
  const handleScreenshotAndAnalyze = useCallback(async () => {
    // 状态：正在截图
    setScreenshotStatus(SCREENSHOT_STATUS.CAPTURING);
    setStatusMessage('正在截图...');
    setAiResult(null);
    setScreenshot(null);

    // 1. 截取所有屏幕
    const captureResult = await api.captureScreenshot();

    if (captureResult.error) {
      setScreenshotStatus(SCREENSHOT_STATUS.ERROR);
      setStatusMessage(`截图失败: ${captureResult.error}`);
      return;
    }

    // 使用第一个屏幕源（主屏幕）的截图
    const mainSource = captureResult.sources?.[0];
    if (!mainSource?.dataUrl) {
      setScreenshotStatus(SCREENSHOT_STATUS.ERROR);
      setStatusMessage('截图失败: 未获取到屏幕数据');
      return;
    }

    setScreenshot(mainSource.dataUrl);

    // 2. 检查 API Key
    if (!settings.apiKey) {
      setScreenshotStatus(SCREENSHOT_STATUS.ERROR);
      setStatusMessage('请先在 API 设置中填写 API Key');
      return;
    }

    // 3. 状态：AI 识别中
    setScreenshotStatus(SCREENSHOT_STATUS.ANALYZING);
    setStatusMessage('AI 识别中...');

    // 检测前台窗口
    try {
      const windows = await api.getFrontWindows();
      if (windows.length > 0 && windows[0].isChatApp) {
        setFrontWindow(windows[0]);
      } else {
        setFrontWindow(null);
      }
    } catch {
      setFrontWindow(null);
    }

    try {
      const provider = MODEL_PROVIDERS[settings.provider];
      const baseUrl = settings.provider === 'custom' ? settings.customBaseUrl : provider.baseUrl;

      if (!baseUrl) {
        setScreenshotStatus(SCREENSHOT_STATUS.ERROR);
        setStatusMessage('请填写 Base URL');
        return;
      }

      // 支持多模态的模型：直接传图片
      const supportsImage = ['kimi', 'tongyi', 'custom'].includes(settings.provider);
      const messages = supportsImage
        ? [{
            role: 'user',
            content: [
              { type: 'text', text: SCREENSHOT_PROMPT },
              { type: 'image_url', image_url: { url: mainSource.dataUrl } },
            ],
          }]
        : [{
            role: 'user',
            content: SCREENSHOT_PROMPT + '\n（注：当前模型不支持图片输入，请根据文字提示返回格式）',
          }];

      const body = settings.provider === 'custom'
        ? { ...provider.buildBody(messages), model: settings.customModel || 'mimo-chat' }
        : provider.buildBody(messages);

      const url = provider.buildUrl ? provider.buildUrl(baseUrl, settings.apiKey) : `${baseUrl}/chat/completions`;
      const headers = provider.headers(settings.apiKey);

      // ========== 诊断日志 ==========
      console.log('[AI Debug] ===== API 请求详情 =====');
      console.log('[AI Debug] Provider:', settings.provider);
      console.log('[AI Debug] URL:', url);
      console.log('[AI Debug] Headers:', JSON.stringify(headers, null, 2));
      console.log('[AI Debug] Body:', JSON.stringify(body, null, 2));
      console.log('[AI Debug] ==========================');

      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      console.log('[AI Debug] Response status:', resp.status, resp.statusText);

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => '');
        console.log('[AI Debug] Error body:', errorText);

        // 按状态码返回具体错误提示
        if (resp.status === 403) {
          throw new Error('API Key 无效或模型无权限，请检查 Key 和模型名称是否正确');
        } else if (resp.status === 404) {
          throw new Error('模型名称错误，请尝试将模型名改为 mimo-v2-pro 或检查 Base URL');
        } else if (resp.status === 429) {
          throw new Error('请求过于频繁，请稍后再试');
        } else if (resp.status === 401) {
          throw new Error('认证失败：API Key 格式可能不对，尝试去掉或加上 Bearer 前缀');
        } else {
          throw new Error(`API 返回 ${resp.status}: ${errorText.slice(0, 200)}`);
        }
      }

      const data = await resp.json();
      const content = provider.extractContent(data);

      if (!content) {
        throw new Error('API 返回内容为空');
      }

      // 解析 JSON 结果
      let result;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          result = { raw: content };
        }
      } catch {
        result = { raw: content };
      }

      setAiResult(result);

      // 状态：成功
      if (result.tasks && result.tasks.length > 0) {
        setScreenshotStatus(SCREENSHOT_STATUS.SUCCESS);
        setStatusMessage(`识别成功，发现 ${result.tasks.length} 个待办`);
      } else {
        setScreenshotStatus(SCREENSHOT_STATUS.SUCCESS);
        setStatusMessage('未识别到待办事项，请尝试文字更清晰的截图');
      }
    } catch (err) {
      setScreenshotStatus(SCREENSHOT_STATUS.ERROR);
      setStatusMessage(`API 连接失败: ${err.message}`);
    }
  }, [settings]);

  // 确认整理
  const handleOrganize = async () => {
    if (desktopFiles.length === 0) return;
    const desktopPath = desktopFiles[0]?.path
      ? desktopFiles[0].path.replace(/[/\\][^/\\]+$/, '')
      : '';
    const organizeDir = desktopPath + '/整理_' + new Date().toISOString().slice(0, 10);
    const filePaths = desktopFiles.map((f) => f.path);
    await api.moveFiles(filePaths, organizeDir);
    handleScanDesktop();
  };

  const handleIgnore = () => setDesktopFiles([]);

  // 保存快捷键
  const handleSaveShortcut = async () => {
    const key = shortcutInput.trim();
    if (!key) {
      // 空字符串 = 注销快捷键
      await api.unregisterShortcut();
      const updated = { ...settings, shortcutKey: '' };
      setSettings(updated);
      await api.storeSet('aiSettings', updated);
      setEditingShortcut(false);
      return;
    }

    const result = await api.registerShortcut(key);
    if (result.success) {
      const updated = { ...settings, shortcutKey: key };
      setSettings(updated);
      await api.storeSet('aiSettings', updated);
      setEditingShortcut(false);
    } else {
      setStatusMessage(`快捷键设置失败: ${result.error}`);
      setScreenshotStatus(SCREENSHOT_STATUS.ERROR);
    }
  };

  const currentProvider = MODEL_PROVIDERS[settings.provider];

  // 状态指示器颜色和图标
  const getStatusDisplay = () => {
    switch (screenshotStatus) {
      case SCREENSHOT_STATUS.CAPTURING:
        return { icon: <Loader2 size={12} className="animate-spin text-blue-400" />, color: 'text-blue-400' };
      case SCREENSHOT_STATUS.ANALYZING:
        return { icon: <Loader2 size={12} className="animate-spin text-amber-400" />, color: 'text-amber-400' };
      case SCREENSHOT_STATUS.SUCCESS:
        return { icon: <CheckCircle2 size={12} className="text-green-400" />, color: 'text-green-400' };
      case SCREENSHOT_STATUS.ERROR:
        return { icon: <AlertCircle size={12} className="text-red-400" />, color: 'text-red-400' };
      default:
        return null;
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div>
      <div className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">AI 助手</div>

      <div className="rounded-xl bg-white/5 border border-white/10 p-3 space-y-3">
        {/* 截图加待办按钮 */}
        <button
          onClick={handleScreenshotAndAnalyze}
          disabled={screenshotStatus === SCREENSHOT_STATUS.CAPTURING || screenshotStatus === SCREENSHOT_STATUS.ANALYZING}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/70 text-xs transition-colors disabled:opacity-50"
        >
          <Camera size={14} />
          {screenshotStatus === SCREENSHOT_STATUS.CAPTURING ? '正在截图...' :
           screenshotStatus === SCREENSHOT_STATUS.ANALYZING ? 'AI 识别中...' :
           '截图加待办'}
        </button>

        {/* 截图预览 */}
        {screenshot && (
          <div className="rounded-lg overflow-hidden border border-white/10">
            <img
              src={screenshot}
              alt="截图"
              className="w-full h-auto"
              style={{ maxHeight: '80px', objectFit: 'cover', objectPosition: 'top' }}
            />
          </div>
        )}

        {/* 状态消息 */}
        {screenshotStatus !== SCREENSHOT_STATUS.IDLE && statusMessage && (
          <div className={`flex items-center gap-1.5 text-[10px] ${statusDisplay?.color || 'text-white/40'}`}>
            {statusDisplay?.icon}
            {statusMessage}
          </div>
        )}

        {/* 前台窗口检测提示 */}
        {frontWindow && (
          <div className="text-[10px] text-blue-300/70 bg-blue-500/10 rounded-lg px-2 py-1.5">
            检测到 {frontWindow.processName} 窗口在前台
            ({frontWindow.rect.right - frontWindow.rect.left}x{frontWindow.rect.bottom - frontWindow.rect.top})
          </div>
        )}

        {/* AI 分析结果 */}
        {aiResult && (
          <div className="rounded-lg bg-white/5 border border-white/10 p-2">
            {aiResult.error ? (
              <div className="text-[10px] text-red-400">{aiResult.error}</div>
            ) : aiResult.tasks && aiResult.tasks.length > 0 ? (
              <div className="space-y-1">
                <div className="text-[10px] text-green-400/80">发现 {aiResult.tasks.length} 个待办</div>
                {aiResult.tasks.map((task, i) => (
                  <div key={i} className="text-[10px] text-white/50 pl-2">
                    {task.priority === 'urgent' && <span className="text-red-400 mr-1">[紧急]</span>}
                    {task.priority === 'high' && <span className="text-orange-400 mr-1">[高]</span>}
                    {task.title}
                    {task.deadline && <span className="text-white/25 ml-1">截止: {task.deadline}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-white/30">
                {aiResult.raw || '未发现明确待办事项'}
              </div>
            )}
          </div>
        )}

        {/* 文件建议区域 */}
        {desktopFiles.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs text-amber-300/80">
              <Sparkles size={12} />
              发现 {desktopFiles.length} 个文件建议整理
            </div>
            <div className="max-h-[80px] overflow-y-auto space-y-0.5">
              {desktopFiles.slice(0, 5).map((f) => (
                <div key={f.path} className="text-[10px] text-white/40 truncate pl-4">{f.name}</div>
              ))}
              {desktopFiles.length > 5 && (
                <div className="text-[10px] text-white/25 pl-4">...还有 {desktopFiles.length - 5} 个</div>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={handleOrganize} className="flex-1 py-1.5 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 text-xs transition-colors">确认整理</button>
              <button onClick={handleIgnore} className="flex-1 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 text-xs transition-colors">忽略</button>
            </div>
          </div>
        )}

        {/* ===== API 设置 ===== */}
        <div className="border-t border-white/5 pt-2">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="flex items-center gap-1.5 text-[10px] text-white/25 hover:text-white/40 transition-colors"
          >
            <Settings size={10} />
            API 设置
          </button>

          {showSettings && (
            <div className="mt-2 space-y-2">
              {/* 模型选择下拉 */}
              <div className="text-[10px] text-white/30">模型选择</div>
              <div className="relative">
                <select
                  value={settings.provider}
                  onChange={(e) => setSettings({ ...settings, provider: e.target.value })}
                  className="w-full px-2 py-1 text-[10px] rounded bg-white/5 border border-white/10 text-white outline-none appearance-none cursor-pointer"
                >
                  {PROVIDER_KEYS.map((key) => (
                    <option key={key} value={key} className="bg-slate-800 text-white">
                      {MODEL_PROVIDERS[key].label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none" />
              </div>

              {/* API Key */}
              <div className="text-[10px] text-white/30">
                {settings.provider === 'wenxin' ? 'Access Token' : 'API Key'}
              </div>
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={settings.apiKey}
                  onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                  placeholder={settings.provider === 'wenxin' ? '输入 Access Token...' : '输入 API Key...'}
                  className="w-full px-2 py-1 text-[10px] rounded bg-white/5 border border-white/10 text-white placeholder-white/20 outline-none pr-6"
                />
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/40"
                >
                  {showKey ? <EyeOff size={10} /> : <Eye size={10} />}
                </button>
              </div>

              {/* 自定义 Base URL + 模型名称 */}
              {settings.provider === 'custom' && (
                <>
                  <div className="text-[10px] text-white/30">Base URL</div>
                  <input
                    value={settings.customBaseUrl}
                    onChange={(e) => setSettings({ ...settings, customBaseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    className="w-full px-2 py-1 text-[10px] rounded bg-white/5 border border-white/10 text-white placeholder-white/20 outline-none"
                  />
                  <div className="text-[10px] text-white/30">模型名称</div>
                  <input
                    value={settings.customModel}
                    onChange={(e) => setSettings({ ...settings, customModel: e.target.value })}
                    placeholder="mimo-chat"
                    className="w-full px-2 py-1 text-[10px] rounded bg-white/5 border border-white/10 text-white placeholder-white/20 outline-none"
                  />
                </>
              )}

              {/* 预设端点提示 */}
              <div className="text-[9px] text-white/15">
                端点: {settings.provider === 'custom' ? (settings.customBaseUrl || '未设置') : currentProvider.baseUrl}
              </div>

              {/* 测试连接按钮 */}
              <div className="flex gap-1">
                <button
                  onClick={handleTestConnection}
                  disabled={testing}
                  className="flex-1 py-1 rounded bg-green-500/15 hover:bg-green-500/25 text-green-400/80 text-[10px] transition-colors disabled:opacity-50"
                >
                  {testing ? '测试中...' : '测试连接'}
                </button>
                <button
                  onClick={handleSaveSettings}
                  className="flex-1 py-1 rounded bg-white/10 hover:bg-white/15 text-white/50 text-[10px] transition-colors flex items-center justify-center gap-1"
                >
                  <Key size={10} />
                  保存设置
                </button>
              </div>
              {/* 测试结果 */}
              {testResult && (
                <div className={`text-[10px] rounded-lg px-2 py-1.5 ${
                  testResult.success
                    ? 'text-green-400 bg-green-500/10 border border-green-500/20'
                    : 'text-red-400 bg-red-500/10 border border-red-500/20'
                }`}>
                  {testResult.message}
                </div>
              )}

              {/* ===== 截图快捷键设置 ===== */}
              <div className="border-t border-white/5 pt-2">
                <div className="text-[10px] text-white/30">截图快捷键</div>
                {editingShortcut ? (
                  <div className="flex gap-1">
                    <input
                      autoFocus
                      value={shortcutInput}
                      onChange={(e) => setShortcutInput(e.target.value)}
                      onKeyDown={(e) => {
                        e.preventDefault();
                        // 自动捕获按键组合
                        const parts = [];
                        if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
                        if (e.shiftKey) parts.push('Shift');
                        if (e.altKey) parts.push('Alt');
                        const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                        // 排除单独的修饰键
                        if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
                          parts.push(key);
                          setShortcutInput(parts.join('+'));
                        }
                      }}
                      placeholder="按下快捷键组合..."
                      className="flex-1 px-2 py-1 text-[10px] rounded bg-white/5 border border-white/10 text-white placeholder-white/20 outline-none"
                    />
                    <button onClick={handleSaveShortcut} className="px-2 py-1 rounded bg-blue-500/20 text-blue-300 text-[10px]">保存</button>
                    <button onClick={() => { setEditingShortcut(false); setShortcutInput(settings.shortcutKey || ''); }} className="px-2 py-1 rounded bg-white/5 text-white/40 text-[10px]">取消</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <code className="flex-1 px-2 py-1 text-[10px] rounded bg-white/5 border border-white/10 text-white/60">
                      {settings.shortcutKey || '未设置'}
                    </code>
                    <button onClick={() => setEditingShortcut(true)} className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-white/40 text-[10px]">修改</button>
                  </div>
                )}
                <div className="text-[9px] text-white/15 mt-0.5">全局快捷键，无需点击按钮即可截图</div>
              </div>


              {/* Prompt 模板展示 */}
              <button
                onClick={() => setShowPrompt(!showPrompt)}
                className="text-[9px] text-white/15 hover:text-white/30 transition-colors"
              >
                {showPrompt ? '收起 Prompt 模板' : '查看 Prompt 模板'}
              </button>

              {showPrompt && (
                <div className="space-y-2 border-t border-white/5 pt-2">
                  <div>
                    <div className="text-[9px] text-blue-400/60 mb-0.5">截图识别 Prompt</div>
                    <div className="text-[9px] text-white/25 leading-relaxed bg-white/5 rounded p-1.5">{SCREENSHOT_PROMPT}</div>
                  </div>
                  <div>
                    <div className="text-[9px] text-blue-400/60 mb-0.5">记忆总结 Prompt</div>
                    <div className="text-[9px] text-white/25 leading-relaxed bg-white/5 rounded p-1.5">{MEMORY_SUMMARY_PROMPT}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
