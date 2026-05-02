import { useState, useEffect, useRef } from 'react';
import {
  MODEL_PROVIDERS,
  DEFAULT_AI_SETTINGS,
  extractTokens,
  recordTokenUsage,
} from '../config/ai-config';

export function useSettings(api) {
  const [showSettings, setShowSettings] = useState(false);
  const settingsPanelRef = useRef(null);
  const settingsButtonRef = useRef(null);

  const [showKey, setShowKey] = useState(false);
  const [aiSettings, setAiSettings] = useState(DEFAULT_AI_SETTINGS);
  const [editingShortcut, setEditingShortcut] = useState(false);
  const [shortcutInput, setShortcutInput] = useState('');
  const [editingPinShortcut, setEditingPinShortcut] = useState(false);
  const [pinShortcutInput, setPinShortcutInput] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [textTestResult, setTextTestResult] = useState(null);
  const [textTesting, setTextTesting] = useState(false);
  const [settingsSaveMsg, setSettingsSaveMsg] = useState(null);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [fontScale, setFontScale] = useState(1.0);

  // 点击面板/按钮之外任意处自动收起
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

  const handleSaveSettings = async () => {
    try {
      await api.storeSet('aiSettings', aiSettings);
      setSettingsSaveMsg({ type: 'success', text: '保存成功' });
    } catch (err) {
      setSettingsSaveMsg({ type: 'error', text: `保存失败: ${err?.message || '未知错误'}` });
    }
    setTimeout(() => setSettingsSaveMsg(null), 2000);
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

  const handleSavePinShortcut = async () => {
    const key = pinShortcutInput.trim();
    if (!key) {
      await api.unregisterPinShortcut();
      await api.storeSet('pinShortcutKey', '');
      setEditingPinShortcut(false);
      return;
    }
    const result = await api.registerPinShortcut(key);
    if (result.success) {
      await api.storeSet('pinShortcutKey', key);
      setEditingPinShortcut(false);
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
    const url = provider.buildUrl
      ? provider.buildUrl(baseUrl, aiSettings.apiKey)
      : `${baseUrl}/chat/completions`;
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
        const tokensUsed = extractTokens(data, content);
        await recordTokenUsage(api, tokensUsed);
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
    const url = provider.buildUrl
      ? provider.buildUrl(baseUrl, aiSettings.apiKey)
      : `${baseUrl}/chat/completions`;
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
          const tokensUsed = extractTokens(data, content);
          await recordTokenUsage(api, tokensUsed);
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

  return {
    showSettings,
    setShowSettings,
    settingsPanelRef,
    settingsButtonRef,
    showKey,
    setShowKey,
    aiSettings,
    setAiSettings,
    editingShortcut,
    setEditingShortcut,
    shortcutInput,
    setShortcutInput,
    editingPinShortcut,
    setEditingPinShortcut,
    pinShortcutInput,
    setPinShortcutInput,
    testResult,
    testing,
    textTestResult,
    textTesting,
    settingsSaveMsg,
    autoLaunch,
    setAutoLaunch,
    fontScale,
    setFontScale,
    handleSaveSettings,
    handleSaveShortcut,
    handleSavePinShortcut,
    handleTestConnection,
    handleTextTest,
  };
}
