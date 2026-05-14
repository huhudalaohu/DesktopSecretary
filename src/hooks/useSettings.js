import { useState, useEffect, useRef } from 'react';
import {
  DEFAULT_AI_SETTINGS,
  extractTokens,
  extractContent,
  recordTokenUsage,
} from '../config/ai-config';
import { callAI, CallAIError } from '../services/ai-proxy';

function describeAIError(err) {
  if (err instanceof CallAIError) {
    switch (err.code) {
      case 'NOT_LOGGED_IN': return '请先登录账号';
      case 'INSUFFICIENT_CREDITS': return '积分不足,请充值';
      case 'DAILY_LIMIT_EXCEEDED': return '当日用量已达上限';
      case 'MAINTENANCE': return '服务维护中,请稍后再试';
      case 'UPSTREAM_ERROR': return `上游 AI 异常: ${err.detail || err.message}`;
      case 'NETWORK_ERROR': return `网络错误: ${err.message}`;
      default: return err.message || 'AI 调用失败';
    }
  }
  return err?.message || 'AI 调用失败';
}

export function useSettings(api) {
  const [showSettings, setShowSettings] = useState(false);
  const settingsPanelRef = useRef(null);
  const settingsButtonRef = useRef(null);

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
    try {
      const mode = aiSettings.mode || 'fast';
      const data = await callAI({
        mode,
        messages: [{ role: 'user', content: 'Hello, reply with "OK" only.' }],
        max_tokens: 32,
      });
      const content = extractContent(data);
      const tokensUsed = extractTokens(data, content);
      await recordTokenUsage(api, tokensUsed);
      const credits = data?._credits;
      const usedNote = credits ? `,扣 ${credits.used} 积分,余额 ${credits.balanceAfter}` : '';
      setTestResult({ success: true, message: `连接成功 (${mode}): ${content.slice(0, 50)}${usedNote}` });
    } catch (err) {
      setTestResult({ success: false, message: describeAIError(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleTextTest = async () => {
    setTextTesting(true);
    setTextTestResult(null);
    try {
      const mode = aiSettings.mode || 'fast';
      const data = await callAI({
        mode,
        messages: [{
          role: 'user',
          content: '请分析这个需求,提取待办事项。需求:完成项目v2.0的登录模块开发,截止周五。返回JSON格式:{tasks:[{title, deadline, priority}]}',
        }],
        max_tokens: 256,
      });
      const content = extractContent(data);
      const tokensUsed = extractTokens(data, content);
      await recordTokenUsage(api, tokensUsed);
      const credits = data?._credits;
      const usedNote = credits ? ` · 扣 ${credits.used} 积分,余额 ${credits.balanceAfter}` : '';
      setTextTestResult({ success: true, message: `成功! 回复: ${content.slice(0, 150)}${usedNote}` });
    } catch (err) {
      setTextTestResult({ success: false, message: describeAIError(err) });
    } finally {
      setTextTesting(false);
    }
  };

  return {
    showSettings,
    setShowSettings,
    settingsPanelRef,
    settingsButtonRef,
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
