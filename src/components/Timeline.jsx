import React, { useState, useEffect, useMemo } from 'react';
import { Clock } from 'lucide-react';
import { DEFAULT_REMINDER_LEVELS } from './ReminderLevelSettings';

const api = window.desktopAPI;

/**
 * 根据剩余时间返回颜色（与 TodoList 保持一致）
 */
function getReminderColor(reminderTime, levels) {
  const useLevels = levels && levels.length > 0 ? levels : DEFAULT_REMINDER_LEVELS;
  if (!reminderTime) return { bg: '#93C5FD', text: '#1E40AF' }; // 无提醒时间：默认蓝色
  const remainMs = reminderTime - Date.now();
  if (remainMs <= 0) {
    const expired = useLevels.find((l) => l.minutes === 0);
    return expired ? { bg: expired.bg, text: expired.text } : { bg: '#E5E7EB', text: '#6B7280' };
  }
  const remainMin = remainMs / (60 * 1000);
  const sorted = [...useLevels].filter((l) => l.minutes > 0).sort((a, b) => a.minutes - b.minutes);
  for (let i = 0; i < sorted.length; i++) {
    if (remainMin < sorted[i].minutes) {
      return { bg: sorted[i].bg, text: sorted[i].text };
    }
  }
  const last = sorted[sorted.length - 1];
  return last ? { bg: last.bg, text: last.text } : { bg: '#F0FDF4', text: '#9CA3AF' };
}

// 默认视口宽度（30天）
const DEFAULT_VIEWPORT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// 最小展示范围：至少两周（方便单点时也能看到周日标记）
const MIN_DISPLAY_DAYS = 14;
const MIN_DISPLAY_MS = MIN_DISPLAY_DAYS * DAY_MS;

function formatShortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// 获取时间戳所在自然周（周一 00:00）
function getWeekStart(ts) {
  const d = new Date(ts);
  const day = d.getDay(); // 0=周日, 1=周一
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 统一蓝色渐变：每周都从浅蓝平滑过渡到深蓝
const WEEK_GRADIENT = { light: '#93C5FD', deep: '#1E40AF' };

export default function Timeline({ activeWorkspace, reminderLevels, onFocusTodo }) {
  const [todos, setTodos] = useState([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showAll, setShowAll] = useState(false); // false=月视图, true=全部

  useEffect(() => {
    const load = () => {
      api.storeGet('todosGlobal', []).then((data) => {
        setTodos(data || []);
      });
    };
    load();
    const handler = () => load();
    window.addEventListener('todos-updated', handler);
    return () => window.removeEventListener('todos-updated', handler);
  }, []);

  // 当前工作区的所有待办（包含已完成）
  const workspaceTodos = useMemo(() => {
    return todos.filter((t) => t.workspaceId === activeWorkspace);
  }, [todos, activeWorkspace]);

  // 按提醒时间 > 创建时间排序
  const sorted = useMemo(() => {
    return [...workspaceTodos].sort((a, b) => {
      const ta = a.reminderTime || a.createdAt || 0;
      const tb = b.reminderTime || b.createdAt || 0;
      return ta - tb;
    });
  }, [workspaceTodos]);

  // 计算时间范围（至少展示两周，方便单点时也能看到周日标记）
  const timeRange = useMemo(() => {
    const times = sorted.map((t) => t.reminderTime || t.createdAt || Date.now());
    const min = times.length ? Math.min(...times) : 0;
    const max = times.length ? Math.max(...times) : 0;
    const actualRange = max - min;
    // 如果只有一个点或范围小于两周，以该点所在周的周一为起点扩展为两周
    if (actualRange < MIN_DISPLAY_MS && sorted.length > 0) {
      const weekStart = getWeekStart(min);
      return { minTime: weekStart, maxTime: weekStart + MIN_DISPLAY_MS, range: MIN_DISPLAY_MS };
    }
    return { minTime: min, maxTime: max, range: actualRange || 1 };
  }, [sorted]);

  const { minTime, maxTime, range } = timeRange;

  const viewportMs = DEFAULT_VIEWPORT_DAYS * DAY_MS;

  // 全部模式：显示完整范围；月视图模式：30天视口
  const needsScroll = !showAll && range > viewportMs;
  const viewportRange = showAll ? range : (needsScroll ? viewportMs : range);
  const viewportStart = showAll ? minTime : (minTime + scrollOffset);
  const viewportEnd = viewportStart + viewportRange;

  // 模式切换时重置滚动偏移
  useEffect(() => {
    setScrollOffset(0);
  }, [showAll]);

  // 滚轮控制视口（仅月视图模式）
  const handleWheel = (e) => {
    if (showAll || !needsScroll) return;
    e.preventDefault();
    const delta = e.deltaY * 0.10 * viewportMs;
    setScrollOffset((prev) => {
      const maxOffset = Math.max(0, range - viewportMs);
      const next = prev + delta;
      return Math.max(0, Math.min(maxOffset, next));
    });
  };

  // 过滤视口内的待办
  const visibleTodos = useMemo(() => {
    if (!needsScroll) return sorted;
    return sorted.filter((t) => {
      const time = t.reminderTime || t.createdAt || 0;
      return time >= viewportStart && time <= viewportEnd;
    });
  }, [sorted, viewportStart, viewportEnd, needsScroll]);

  // 计算每个点在视口中的位置，避免重叠；两端留 5% 内边距
  const positioned = useMemo(() => {
    const buckets = new Map();
    const PADDING = 5;
    return visibleTodos.map((todo) => {
      const t = todo.reminderTime || todo.createdAt || Date.now();
      const rawLeft = viewportRange === 0
        ? 50
        : PADDING + ((t - viewportStart) / viewportRange) * (100 - 2 * PADDING);
      const bucketKey = Math.round(rawLeft / 2);
      const count = (buckets.get(bucketKey) || 0) + 1;
      buckets.set(bucketKey, count);
      const staggerY = (count - 1) * 6;
      return { todo, left: rawLeft, staggerY, bucketKey, time: t };
    });
  }, [visibleTodos, viewportStart, viewportRange]);

  const hasReminder = useMemo(() => visibleTodos.some((t) => t.reminderTime), [visibleTodos]);

  // 按自然周分段，基于视口
  const weekSegments = useMemo(() => {
    if (viewportRange <= 0 || visibleTodos.length === 0) return [];
    const segs = [];
    let weekStart = getWeekStart(viewportStart);
    let idx = 0;
    while (weekStart < viewportEnd) {
      const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;
      const effStart = Math.max(weekStart, viewportStart);
      const effEnd = Math.min(weekEnd, viewportEnd);
      if (effStart < effEnd) {
        const theme = WEEK_GRADIENT;
        // 周一标签：放在每段左边界（weekStart 位置），只要该周与视口有交集就显示
        const showMondayLabel = weekStart < viewportEnd && weekStart + 7 * DAY_MS > viewportStart;
        const mondayLeft = ((weekStart - viewportStart) / viewportRange) * 100;
        segs.push({
          left: ((effStart - viewportStart) / viewportRange) * 100,
          width: ((effEnd - effStart) / viewportRange) * 100,
          theme,
          showMondayLabel,
          mondayLeft: showMondayLabel ? Math.max(0, Math.min(100, mondayLeft)) : null,
          mondayLabel: showMondayLabel ? `${formatShortDate(weekStart).replace('/', '.')} 周一` : null,
        });
      }
      weekStart = weekEnd;
      idx++;
    }
    return segs;
  }, [visibleTodos, viewportStart, viewportEnd, viewportRange]);

  const isEmpty = workspaceTodos.length === 0;

  return (
    <div className="px-4 mt-[3px] mb-2 select-none">
      {/* 头部标签 */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Clock size={10} className="text-blue-400" />
            <span className="text-[10px] font-normal text-[#999]">时间轴</span>
          </div>
          {/* 月视图 / 全部 切换开关 */}
          <button
            onClick={() => setShowAll((prev) => !prev)}
            className={`relative w-[18px] h-[10px] rounded-full transition-colors ${
              showAll ? 'bg-blue-400' : 'bg-gray-300'
            }`}
            title={showAll ? '切换为月视图' : '切换为全部视图'}
          >
            <span
              className={`absolute top-[1px] left-[1px] w-2 h-2 bg-white rounded-full transition-transform ${
                showAll ? 'translate-x-[8px]' : 'translate-x-0'
              }`}
            />
          </button>
          <span className="text-[10px] font-normal text-[#999]">{showAll ? '全部' : '月'}</span>
        </div>
        <div className="flex items-center gap-2">
          {needsScroll && (
            <span className="text-[10px] font-normal text-[#999]">滚轮查看更多</span>
          )}
          <span className="text-[10px] font-normal text-[#999]">{isEmpty ? 0 : visibleTodos.length} 个待办</span>
        </div>
      </div>

      {/* 时间轴主体 */}
      <div
        className="relative h-6 flex items-center"
        onWheel={handleWheel}
      >
        {isEmpty ? (
          <>
            {/* 空状态占位轴线 */}
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[2px] rounded-full bg-gray-200" />
          </>
        ) : (
          <>
            {/* 分段周轴线 — 每周从浅蓝渐变至深蓝 */}
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[2px] rounded-full overflow-hidden">
              {weekSegments.map((seg, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full"
                  style={{
                    left: `${seg.left}%`,
                    width: `${seg.width}%`,
                    background: `linear-gradient(to right, ${seg.theme.light}, ${seg.theme.deep})`,
                  }}
                />
              ))}
            </div>

            {/* 周一日期标签 — 放在每段左边界 */}
            <div className="absolute top-[65%] left-0 right-0 h-3 pointer-events-none">
              {weekSegments.filter((s) => s.showMondayLabel).map((seg, i) => {
                const nearLeft = (seg.mondayLeft ?? 0) < 4;
                return (
                  <div
                    key={`mon-${i}`}
                    className={`absolute text-[10px] font-normal text-[#999] tabular-nums whitespace-nowrap ${
                      nearLeft ? 'left-0' : ''
                    }`}
                    style={nearLeft ? {} : { left: `${seg.mondayLeft}%`, transform: 'translateX(-50%)' }}
                  >
                    {seg.mondayLabel}
                  </div>
                );
              })}
            </div>

            {/* 时间打点 */}
            {positioned.map(({ todo, left, staggerY, time }) => {
              const isReminder = !!todo.reminderTime;
              const isNearLeft = left < 12;
              const isNearRight = left > 88;
              const tooltipAlign = isNearLeft ? 'left-0 translate-x-0' : isNearRight ? 'right-0 translate-x-0' : 'left-1/2 -translate-x-1/2';
              const arrowAlign = isNearLeft ? 'left-1 translate-x-0' : isNearRight ? 'right-1 translate-x-0' : 'left-1/2 -translate-x-1/2';
              return (
                <div
                  key={todo.id}
                  className="absolute flex flex-col items-center group cursor-pointer"
                  style={{ left: `${left}%`, top: '50%', transform: `translate(-50%, calc(-50% + ${staggerY}px))` }}
                  onDoubleClick={() => onFocusTodo?.(todo.id)}
                >
                  {/* 点 — 颜色与 TodoList 提醒按钮文字色一致 */}
                  <div
                    className="w-[7px] h-[7px] rounded-full border border-white shadow-sm transition-transform duration-150 group-hover:scale-150"
                    style={(() => {
                      const c = getReminderColor(todo.reminderTime, reminderLevels);
                      return { backgroundColor: c.text };
                    })()}
                  />
                  {/* Tooltip */}
                  <div className={`absolute bottom-full mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 ${tooltipAlign}`}>
                    <div className="bg-gray-800 text-white text-[10px] font-normal px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
                      <div className="font-medium">{todo.text}</div>
                      <div className="text-gray-300 mt-0.5">
                        {isReminder ? `提醒 ${formatShortDate(time)} ${formatTime(time)}` : `创建 ${formatShortDate(time)}`}
                      </div>
                    </div>
                    {/* 小三角 */}
                    <div className={`absolute -bottom-1 w-0 h-0 border-l-[4px] border-r-[4px] border-t-[4px] border-l-transparent border-r-transparent border-t-gray-800 ${arrowAlign}`} />
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* 底部时间标签 — 显示视口起止 */}
      <div className="flex justify-between mt-0.5">
        <span className="text-[10px] font-normal text-[#999] tabular-nums">
          {isEmpty ? '--' : (hasReminder ? formatShortDate(viewportStart) + ' ' + formatTime(viewportStart) : formatShortDate(viewportStart))}
        </span>
        <span className="text-[10px] font-normal text-[#999] tabular-nums">
          {isEmpty ? '--' : (hasReminder ? formatShortDate(viewportEnd) + ' ' + formatTime(viewportEnd) : formatShortDate(viewportEnd))}
        </span>
      </div>
    </div>
  );
}
