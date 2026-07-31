/**
 * AIAssistant.jsx — 智能流卡片模块（精简版）
 *
 * 功能:
 *   - Token 消耗统计
 *   - 截图预览 + 状态提示
 */

import React from 'react';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

const SCREENSHOT_STATUS = {
  IDLE: 'idle',
  CAPTURING: 'capturing',
  ANALYZING: 'analyzing',
  SUCCESS: 'success',
  ERROR: 'error',
};

export default function AIAssistant({
  screenshot,
  screenshotStatus,
  statusMessage,
  aiResult,
  tokenStats,
  formatTokens,
  dailyLimit,
}) {
  const getStatusDisplay = () => {
    switch (screenshotStatus) {
      case SCREENSHOT_STATUS.CAPTURING:
        return { icon: <Loader2 size={12} className="animate-spin text-fluent-accent" />, color: 'text-fluent-accent' };
      case SCREENSHOT_STATUS.ANALYZING:
        return { icon: <Loader2 size={12} className="animate-spin text-fluent-warning" />, color: 'text-fluent-warning' };
      case SCREENSHOT_STATUS.SUCCESS:
        return { icon: <CheckCircle2 size={12} className="text-fluent-accent" />, color: 'text-fluent-accent' };
      case SCREENSHOT_STATUS.ERROR:
        return { icon: <AlertCircle size={12} className="text-fluent-danger" />, color: 'text-fluent-danger' };
      default:
        return null;
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div>
      <div className="font-display text-[15px] font-bold text-fluent-text-primary mb-2">智能流</div>

      <div className="card p-3 space-y-3">
        {/* Token 消耗 */}
        <div className="rounded-fluent-lg bg-fluent-surface-solid border border-fluent-stroke-card px-2.5 py-1.5 space-y-1">
          <div className="flex items-center justify-between text-[12px] font-normal text-fluent-text-tertiary">
            <span>今日: <span className={tokenStats.today > dailyLimit ? 'text-fluent-danger' : 'text-fluent-accent'}>{formatTokens(tokenStats.today)}</span></span>
            <span>本月: <span className="text-fluent-text-secondary">{formatTokens(tokenStats.month)}</span></span>
            <span>单次: <span className="text-fluent-accent">{formatTokens(tokenStats.lastRequest)}</span></span>
          </div>
          <div className="h-1 rounded-full bg-fluent-stroke-divider overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                tokenStats.today > dailyLimit ? 'bg-fluent-danger' : 'bg-fluent-accent'
              }`}
              style={{ width: `${Math.min(100, (tokenStats.today / dailyLimit) * 100)}%` }}
            />
          </div>
        </div>

        {/* 截图预览 */}
        {screenshot && (
          <div className="rounded-fluent-lg overflow-hidden border border-fluent-stroke-card">
            <img
              src={screenshot}
              alt="截图"
              className="w-full h-auto"
              style={{ maxHeight: '80px', objectFit: 'cover', objectPosition: 'top' }}
            />
          </div>
        )}

        {/* 状态提示 */}
        {screenshotStatus !== SCREENSHOT_STATUS.IDLE && statusMessage && (
          <div className={`flex items-center gap-1.5 text-[11px] font-normal ${statusDisplay?.color || 'text-fluent-text-tertiary'}`}>
            {statusDisplay?.icon}
            {statusMessage}
          </div>
        )}

        {/* AI 结果摘要 */}
        {aiResult && (
          <div className="rounded-fluent-lg bg-fluent-surface-solid border border-fluent-stroke-card p-2">
            {aiResult.error ? (
              <div className="text-[11px] font-normal text-fluent-danger">{aiResult.error}</div>
            ) : aiResult.tasks && aiResult.tasks.length > 0 ? (
              <div className="space-y-1">
                <div className="text-[11px] font-normal text-fluent-accent">已创建 1 条待办</div>
                {(() => {
                  const task = aiResult.tasks[0];
                  return (
                    <div className="text-[14px] font-normal text-fluent-text-primary pl-2">
                      {task.priority === 'urgent' && <span className="text-fluent-danger mr-1">[紧急]</span>}
                      {task.priority === 'high' && <span className="text-fluent-warning mr-1">[高]</span>}
                      {task.assigner && <span className="text-fluent-accent mr-1">【{task.assigner}】</span>}
                      {task.title}
                      {task.deadline && <span className="text-fluent-text-tertiary ml-1">截止: {task.deadline}</span>}
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div className="text-[12px] font-normal text-fluent-text-tertiary">
                {aiResult.raw || '未发现明确待办事项'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
