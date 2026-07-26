import { useState, useEffect, useCallback, useRef } from 'react';
import {
  SCREENSHOT_PROMPT,
  extractTokens,
  extractContent,
  loadTokenStats,
  recordTokenUsage,
} from '../config/ai-config';
import { callAI, CallAIError } from '../services/ai-proxy';
import { parseDeadlineToTimestamp } from '../utils/datetime';
import { hashDataUrl } from '../utils/format';
import { compressImageDataUrl } from '../utils/image';

export const SCREENSHOT_STATUS = {
  IDLE: 'idle',
  CAPTURING: 'capturing',
  ANALYZING: 'analyzing',
  SUCCESS: 'success',
  ERROR: 'error',
};

export const DAILY_LIMIT = 100000;

function describeAIError(err) {
  if (err instanceof CallAIError) {
    switch (err.code) {
      case 'NOT_LOGGED_IN': return '请先登录账号';
      case 'INSUFFICIENT_CREDITS': return '积分不足,请前往设置充值';
      case 'DAILY_LIMIT_EXCEEDED': return '当日用量已达上限,请明天再试';
      case 'MAINTENANCE': return '服务维护中,请稍后再试';
      case 'UPSTREAM_ERROR': return `上游 AI 异常: ${err.detail || err.message}`;
      case 'NETWORK_ERROR': return `网络错误: ${err.message}`;
      default: return err.message || 'AI 调用失败';
    }
  }
  return err?.message || 'AI 调用失败';
}

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

    setScreenshotStatus(SCREENSHOT_STATUS.ANALYZING);
    setStatusMessage('AI 识别中...');

    try {
      // 截图理解需要多模态,默认走 precise(若用户选了 fast 也允许)
      const mode = aiSettings?.mode === 'fast' ? 'fast' : 'precise';
      // 压缩后再发送:整屏 PNG base64 会打爆 CloudBase 触发器的请求体上限
      const compressedImage = await compressImageDataUrl(croppedDataUrl);
      const messages = [{
        role: 'user',
        content: [
          { type: 'text', text: SCREENSHOT_PROMPT },
          { type: 'image_url', image_url: { url: compressedImage } },
        ],
      }];

      const data = await callAI({ mode, messages, max_tokens: 1024 });
      const content = extractContent(data);
      if (!content) {
        if (data?.choices && data.choices.length === 0) {
          throw new Error('API 返回了空的 choices 数组,可能是图片过大或模型不支持当前格式');
        }
        throw new Error('AI 返回内容为空');
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
          setStatusMessage('该截图 1 小时内已提交过,已返回上次结果');
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
        setStatusMessage('未识别到待办事项,请尝试文字更清晰的截图');
        api.dockExpand(5000);
      }
    } catch (err) {
      setScreenshotStatus(SCREENSHOT_STATUS.ERROR);
      setStatusMessage(describeAIError(err));
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
