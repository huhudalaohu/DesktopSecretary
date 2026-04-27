/**
 * AIAssistant.jsx — AI 助手卡片模块（精简版）
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
        return { icon: <Loader2 size={12} className="animate-spin text-blue-400" />, color: 'text-blue-400' };
      case SCREENSHOT_STATUS.ANALYZING:
        return { icon: <Loader2 size={12} className="animate-spin text-amber-400" />, color: 'text-amber-400' };
      case SCREENSHOT_STATUS.SUCCESS:
        return { icon: <CheckCircle2 size={12} className="text-blue-500" />, color: 'text-blue-500' };
      case SCREENSHOT_STATUS.ERROR:
        return { icon: <AlertCircle size={12} className="text-red-400" />, color: 'text-red-400' };
      default:
        return null;
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div>
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">AI 助手</div>

      <div className="rounded-lg bg-white border border-[#E5E5E5] p-3 space-y-3 shadow-sm">
        {/* Token 消耗 */}
        <div className="rounded-md bg-white border border-[#E5E5E5] px-2.5 py-1.5 space-y-1">
          <div className="flex items-center justify-between text-[10px] text-gray-400">
            <span>今日: <span className={tokenStats.today > dailyLimit ? 'text-red-500' : 'text-blue-500'}>{formatTokens(tokenStats.today)}</span></span>
            <span>本月: <span className="text-gray-600">{formatTokens(tokenStats.month)}</span></span>
            <span>单次: <span className="text-blue-500">{formatTokens(tokenStats.lastRequest)}</span></span>
          </div>
          <div className="h-1 rounded-full bg-[#E5E5E5] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                tokenStats.today > dailyLimit ? 'bg-red-500' : 'bg-blue-500'
              }`}
              style={{ width: `${Math.min(100, (tokenStats.today / dailyLimit) * 100)}%` }}
            />
          </div>
        </div>

        {/* 截图预览 */}
        {screenshot && (
          <div className="rounded-md overflow-hidden border border-[#E5E5E5]">
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
          <div className={`flex items-center gap-1.5 text-[10px] ${statusDisplay?.color || 'text-gray-400'}`}>
            {statusDisplay?.icon}
            {statusMessage}
          </div>
        )}

        {/* AI 结果摘要 */}
        {aiResult && (
          <div className="rounded-md bg-white border border-[#E5E5E5] p-2">
            {aiResult.error ? (
              <div className="text-[10px] text-red-500">{aiResult.error}</div>
            ) : aiResult.tasks && aiResult.tasks.length > 0 ? (
              <div className="space-y-1">
                <div className="text-[10px] text-blue-500">已创建 1 条待办</div>
                {(() => {
                  const task = aiResult.tasks[0];
                  return (
                    <div className="text-[10px] text-gray-600 pl-2">
                      {task.priority === 'urgent' && <span className="text-red-500 mr-1">[紧急]</span>}
                      {task.priority === 'high' && <span className="text-orange-500 mr-1">[高]</span>}
                      {task.assigner && <span className="text-blue-500 mr-1">【{task.assigner}】</span>}
                      {task.title}
                      {task.deadline && <span className="text-gray-400 ml-1">截止: {task.deadline}</span>}
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div className="text-[10px] text-gray-400">
                {aiResult.raw || '未发现明确待办事项'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
