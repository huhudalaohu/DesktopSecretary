import { useState, useEffect, useCallback, useRef } from 'react';
import {
  MODEL_PROVIDERS,
  SCREENSHOT_PROMPT,
  extractTokens,
  loadTokenStats,
  recordTokenUsage,
} from '../config/ai-config';
import { parseDeadlineToTimestamp } from '../utils/datetime';
import { hashDataUrl } from '../utils/format';

export const SCREENSHOT_STATUS = {
  IDLE: 'idle',
  CAPTURING: 'capturing',
  ANALYZING: 'analyzing',
  SUCCESS: 'success',
  ERROR: 'error',
};

export const DAILY_LIMIT = 100000;

export function useScreenshotAI(api, aiSettings) {
  const [screenshot, setScreenshot] = useState(null);
  const [screenshotStatus, setScreenshotStatus] = useState(SCREENSHOT_STATUS.IDLE);
  const [statusMessage, setStatusMessage] = useState('');
  const [aiResult, setAiResult] = useState(null);
  const [tokenStats, setTokenStats] = useState({ today: 0, month: 0, lastRequest: 0 });
  const [focusTodoId, setFocusTodoId] = useState(null);

  const recentScreenshots = useRef({});

  useEffect(() => {
    loadTokenStats(api).then((s) =>
      setTokenStats({ today: s.today, month: s.month, lastRequest: s.lastRequest })
    );
  }, [api]);

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

      const url = provider.buildUrl
        ? provider.buildUrl(baseUrl, aiSettings.apiKey)
        : `${baseUrl}/chat/completions`;
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
      await recordTokenUsage(api, tokensUsed);
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

        // 清理过期缓存
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
  }, [aiSettings, api]);

  // 监听全局快捷键触发
  useEffect(() => {
    const cleanup = api.onShortcutTriggered(() => {
      handleScreenshotAndAnalyze();
    });
    return cleanup;
  }, [handleScreenshotAndAnalyze, api]);

  return {
    screenshot,
    screenshotStatus,
    statusMessage,
    aiResult,
    tokenStats,
    focusTodoId,
    setFocusTodoId,
    handleScreenshotAndAnalyze,
  };
}
