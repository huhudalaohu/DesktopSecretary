/**
 * TodoList.jsx — 待办列表模块（含优先级分级）
 *
 * 功能:
 *   - 输入框 + 添加按钮 (回车提交)
 *   - 支持语法快捷设置优先级: "!urgent 买牛奶" → 紧急
 *   - 列表项: 优先级色条 | 复选框 | 文字 | 删除按钮(悬浮显示)
 *   - 已完成: line-through + opacity-50
 *   - 筛选: 全部/进行中/已完成 + 优先级下拉筛选
 *   - 右键修改优先级
 *
 * 数据存储:
 *   - 键: todos
 *   - 格式: { [workspaceId]: [{id, text, done, priority}] }
 *   - priority: 'urgent' | 'high' | 'medium' | 'low'，默认 'medium'
 *   - 旧数据兼容: 无 priority 字段时迁移为 'medium'
 */

import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Check, ListFilter, ChevronDown, Pencil, Camera, Loader2 } from 'lucide-react';
import { DEFAULT_REMINDER_LEVELS } from '../../reminders/components/ReminderLevelSettings';

const api = window.desktopAPI;

// 优先级配置：颜色、标签、排序权重（数字越小越优先）
const PRIORITY_CONFIG = {
  urgent: { label: '紧急', color: 'bg-red-500', glow: 'bg-red-50', order: 0 },
  high:   { label: '高',   color: 'bg-orange-400', glow: null, order: 1 },
  medium: { label: '中',   color: 'bg-blue-400',  glow: null, order: 2 },
  low:    { label: '低',   color: 'bg-gray-500',  glow: null, order: 3 },
};

const PRIORITY_KEYS = Object.keys(PRIORITY_CONFIG);

/**
 * 解析输入文本中的优先级前缀
 * 支持语法: "!urgent 内容" / "!u 内容" / "!h 内容" / "!m 内容" / "!l 内容"
 * 返回 { priority, text }
 */
function parsePriorityPrefix(raw) {
  const match = raw.match(/^!(urgent|u|high|h|medium|m|low|l)\s+/i);
  if (!match) return { priority: 'medium', text: raw };

  const tag = match[1].toLowerCase();
  const text = raw.slice(match[0].length);
  const map = { u: 'urgent', urgent: 'urgent', h: 'high', high: 'high', m: 'medium', medium: 'medium', l: 'low', low: 'low' };
  return { priority: map[tag] || 'medium', text };
}

/**
 * 排序：未完成置顶，已完成沉底
 * 各组内 AI 新生成的待办优先，其余按添加顺序排列（先添加的在前）
 */
function sortTodos(todos) {
  return todos
    .filter((t) => t && t.id)
    .sort((a, b) => {
      // 未完成在前，已完成沉底
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;
      // AI 新生成的待办置顶
      if (a.isNew && !b.isNew) return -1;
      if (!a.isNew && b.isNew) return 1;
      // 按添加顺序（先添加的在前）
      const tA = a.createdAt || 0;
      const tB = b.createdAt || 0;
      if (tA !== tB) return tA - tB;
      return String(a.id).localeCompare(String(b.id));
    });
}

/**
 * 深蓝到浅蓝的渐变插值（与 WorkspaceSwitcher 保持一致）
 */
function gradientColor(index, total, startHex = '#0259BB', endHex = '#B3D9FF') {
  if (total <= 1) return startHex;
  const t = index / (total - 1);
  const hexToRgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = hexToRgb(startHex);
  const [r2, g2, b2] = hexToRgb(endHex);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * 根据剩余时间返回颜色（支持用户自定义层级）
 * @param {number|null} reminderTime
 * @param {Array} levels 用户自定义层级配置
 * @returns {{bg: string, text: string}}
 */
/**
 * 根据剩余时间返回颜色（支持用户自定义层级）
 * @param {number|null} reminderTime
 * @param {Array} levels 用户自定义层级配置
 * @returns {{bg: string, text: string}}
 */
function getReminderColor(reminderTime, levels) {
  const useLevels = levels && levels.length > 0 ? levels : DEFAULT_REMINDER_LEVELS;
  if (!reminderTime) return { bg: 'rgba(0, 0, 0, 0.0373)', text: '#9E9E9E' };
  const remainMs = reminderTime - Date.now();
  if (remainMs <= 0) {
    const expired = useLevels.find((l) => l.minutes === 0);
    return expired ? { bg: expired.bg, text: expired.text } : { bg: 'rgba(0, 0, 0, 0.06)', text: '#616161' };
  }
  const remainMin = remainMs / (60 * 1000);
  // 过滤掉 0 分钟（已过期），按时间升序排列
  const sorted = [...useLevels].filter((l) => l.minutes > 0).sort((a, b) => a.minutes - b.minutes);
  for (let i = 0; i < sorted.length; i++) {
    if (remainMin < sorted[i].minutes) {
      return { bg: sorted[i].bg, text: sorted[i].text };
    }
  }
  // remain 大于所有层级，返回最后一个
  const last = sorted[sorted.length - 1];
  return last ? { bg: last.bg, text: last.text } : { bg: 'rgba(0, 0, 0, 0.0373)', text: '#9E9E9E' };
}

/**
 * 数据迁移：确保每条待办都有完整字段
 */
function migrateTodos(todos) {
  if (!Array.isArray(todos)) return [];
  return todos
    .filter((t) => t && typeof t === 'object' && t.id)
    .map((t) => ({
      id: t.id,
      text: t.text || '',
      done: !!t.done,
      priority: PRIORITY_CONFIG[t.priority] ? t.priority : 'medium',
      workspaceId: t.workspaceId || null,
      isNew: !!t.isNew,
      createdAt: t.createdAt || 0,
      reminderTime: t.reminderTime || null,
      reminderTriggered: !!t.reminderTriggered,
      reminderTimeBackup: t.reminderTimeBackup || null,
    }));
}

/**
 * 格式化提醒时间为简短字符串 MM-DD HH:mm
 */
function formatReminderTime(timestamp) {
  if (!timestamp) return '--';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '--';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${min}`;
}

/**
 * 将 Date 转为 datetime-local input 需要的 YYYY-MM-DDTHH:mm 格式
 */
function toDatetimeLocalValue(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${min}`;
}

/**
 * 获取默认提醒时间：当前时间 +6 小时，对齐到 5 分钟
 */
function getDefaultReminderTime() {
  const now = new Date();
  now.setSeconds(0, 0);
  now.setMinutes(now.getMinutes() + 360);
  const rem = now.getMinutes() % 5;
  if (rem !== 0) now.setMinutes(now.getMinutes() + (5 - rem));
  return now.getTime();
}

/**
 * 判断提醒状态
 * @returns {'off' | 'on' | 'expired'}
 */
function getReminderState(todo) {
  if (!todo.reminderTime || todo.done) return 'off';
  return todo.reminderTime > Date.now() ? 'on' : 'expired';
}

/**
 * 滚轮调整时间
 * @param {number} currentTs
 * @param {number} deltaY
 * @param {boolean} shiftKey
 * @param {boolean} altKey
 * @returns {number} 新的时间戳
 */
function adjustTimeByWheel(currentTs, deltaY, shiftKey, altKey) {
  if (!currentTs) {
    // 从未设置时，默认未来时间
    return getDefaultReminderTime();
  }
  let step;
  if (altKey) {
    step = 24 * 60 * 60 * 1000; // Alt=1天
  } else if (shiftKey) {
    step = 60 * 60 * 1000; // Shift=1小时
  } else {
    step = 5 * 60 * 1000; // 普通=5分钟
  }
  const direction = deltaY > 0 ? 1 : -1;
  return currentTs + direction * step;
}

export default function TodoList({ workspaces = [], activeWorkspace, onSwitchWorkspace, onScreenshot, screenshotStatus, reminderLevels, focusTodoId }) {
  const [todos, setTodos] = useState([]);              // 全局待办列表
  const [input, setInput] = useState('');              // 输入框内容
  const [statusFilter, setStatusFilter] = useState('all');  // 状态筛选: all | active | completed
  const [priorityFilter, setPriorityFilter] = useState('all'); // 优先级筛选: all | urgent | high | medium | low
  const [priorityPicker, setPriorityPicker] = useState(null);  // 选择中的优先级（输入框旁圆点）
  const [contextMenu, setContextMenu] = useState(null);  // 右键菜单 {x, y, todo}
  const [editingId, setEditingId] = useState(null);        // 正在编辑的待办 id
  const [editValue, setEditValue] = useState('');           // 编辑输入值
  const [dropTargetId, setDropTargetId] = useState(null);   // 拖拽绑定中的目标待办 id
  const [reminderPicker, setReminderPicker] = useState(null); // 正在设置提醒的 todo id

  // Tooltip 状态
  const [tooltip, setTooltip] = useState({ show: false, text: '', x: 0, y: 0 });
  const tooltipTimer = useRef(null);
  const todoTextRefs = useRef(new Map());
  const listRef = useRef(null);

  // 加载待办数据（全局，不区分工作区）
  useEffect(() => {
    const loadTodos = () => {
      api.storeGet('todosGlobal', []).then((data) => {
        setTodos(migrateTodos(data));
      });
    };
    loadTodos();

    // 监听其他组件（如 AIAssistant）创建待办后的通知
    const handler = () => loadTodos();
    window.addEventListener('todos-updated', handler);
    return () => window.removeEventListener('todos-updated', handler);
  }, []);

  // AI 生成待办置顶高亮：自动滚动到顶部 + 10s 后清除 isNew
  useEffect(() => {
    const hasNew = todos.some((t) => t.isNew);
    if (hasNew) {
      if (listRef.current) {
        listRef.current.scrollTop = 0;
      }
      const timer = setTimeout(() => {
        setTodos((prev) => {
          const cleared = prev.map((t) => ({ ...t, isNew: false }));
          api.storeSet('todosGlobal', cleared);
          return cleared;
        });
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [todos]);

  // 时间轴双击聚焦：滚动到对应待办项
  useEffect(() => {
    if (!focusTodoId) return;
    const el = document.getElementById(`todo-item-${focusTodoId}`);
    if (el && listRef.current) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 高亮闪烁效果
      el.classList.add('ring-2', 'ring-fluent-accent');
      setTimeout(() => el.classList.remove('ring-2', 'ring-fluent-accent'), 1500);
    }
  }, [focusTodoId]);

  // 保存到 electron-store（保留完整原文，显示层用 CSS 截断）
  const saveTodos = async (updated) => {
    setTodos(updated);
    await api.storeSet('todosGlobal', updated);
    window.dispatchEvent(new Event('todos-updated'));
  };

  // 绑定工作区
  const bindWorkspace = async (todoId, workspaceId) => {
    const updated = todos.map((t) => t.id === todoId ? { ...t, workspaceId } : t);
    await saveTodos(updated);
  };

  // 排序后的待办列表
  const sortedTodos = sortTodos(todos);

  // 筛选后的列表
  const filteredTodos = sortedTodos.filter((t) => {
    // 状态筛选
    if (statusFilter === 'active' && t.done) return false;
    if (statusFilter === 'completed' && !t.done) return false;
    // 优先级筛选
    if (priorityFilter !== 'all' && (t.priority || 'medium') !== priorityFilter) return false;
    return true;
  });

  // 添加待办（带50字限制）
  const addTodo = async () => {
    const raw = input.trim();
    if (!raw) return;

    // 解析优先级前缀（如 "!urgent 买牛奶"）
    const { priority: prefixPriority, text: parsedText } = parsePriorityPrefix(raw);
    // 如果用户手动选择了优先级圆点，优先用圆点；否则用前缀解析结果
    const priority = priorityPicker || prefixPriority;
    const text = parsedText.trim();
    if (!text) return;

    const newTodo = { id: `todo-${Date.now()}`, text, done: false, priority, reminderTime: null, reminderTriggered: false };
    await saveTodos([...todos, newTodo]);
    setInput('');
    setPriorityPicker(null);
  };

  // 切换完成状态
  const toggleTodo = async (id) => {
    const updated = todos.map((t) => {
      if (t.id !== id) return t;
      const newDone = !t.done;
      return newDone
        ? { ...t, done: true, reminderTime: Date.now() }
        : { ...t, done: false };
    });
    await saveTodos(updated);
  };

  // 删除待办（移入回收站）
  const removeTodo = async (id) => {
    const todoToTrash = todos.find((t) => t.id === id);
    if (todoToTrash) {
      const trashed = await api.storeGet('trashedTodos', []);
      await api.storeSet('trashedTodos', [{ ...todoToTrash, trashedAt: Date.now() }, ...trashed]);
      window.dispatchEvent(new Event('trash-updated'));
    }
    const updated = todos.filter((t) => t.id !== id);
    await saveTodos(updated);
  };

  // 确认编辑
  const confirmEdit = async () => {
    if (!editingId) return;
    const text = editValue.trim();
    if (!text) { setEditingId(null); return; }
    const updated = todos.map((t) => t.id === editingId ? { ...t, text } : t);
    await saveTodos(updated);
    setEditingId(null);
    setEditValue('');
  };

  // 修改优先级
  const changePriority = async (id, newPriority) => {
    const updated = todos.map((t) =>
      t.id === id ? { ...t, priority: newPriority } : t
    );
    await saveTodos(updated);
    setContextMenu(null);
  };

  // 移除项目绑定
  const unbindWorkspace = async (id) => {
    const updated = todos.map((t) =>
      t.id === id ? { ...t, workspaceId: null } : t
    );
    await saveTodos(updated);
    setContextMenu(null);
  };

  // 设置提醒时间
  const setReminder = async (id, timestamp) => {
    const updated = todos.map((t) =>
      t.id === id
        ? { ...t, reminderTime: timestamp, reminderTimeBackup: null }
        : t
    );
    await saveTodos(updated);
    setReminderPicker(null);
  };

  // 清除提醒时间（保留备份，便于恢复）
  const clearReminder = async (id) => {
    const updated = todos.map((t) =>
      t.id === id
        ? { ...t, reminderTime: null, reminderTimeBackup: t.reminderTime }
        : t
    );
    await saveTodos(updated);
    setReminderPicker(null);
    setContextMenu(null);
  };

  // 处理时间标签键盘方向键/WASD（↑↓ 调时间，←→ 调日期，Shift+↑↓ 调小时）
  const handleReminderKeyDown = async (e, todo) => {
    const key = e.key;
    const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    const wasdKeys = ['w', 'a', 's', 'd'];
    if (!arrowKeys.includes(key) && !wasdKeys.includes(key)) return;
    e.preventDefault();
    e.stopPropagation();
    const isDate = key === 'ArrowLeft' || key === 'ArrowRight' || key === 'a' || key === 'd';
    const direction = (key === 'ArrowUp' || key === 'ArrowLeft' || key === 'w' || key === 'a') ? -1 : 1;
    let step;
    if (isDate) {
      step = 24 * 60 * 60 * 1000; // 日期±1天
    } else if (e.shiftKey) {
      step = 60 * 60 * 1000; // Shift+W/S 小时±1
    } else {
      step = 5 * 60 * 1000; // W/S 时间±5分钟
    }
    let newTs;
    if (!todo.reminderTime) {
      newTs = getDefaultReminderTime() + direction * step;
    } else {
      newTs = todo.reminderTime + direction * step;
    }
    await setReminder(todo.id, newTs);
  };

  // 双击切换提醒开关：关闭时保留备份，开启时优先恢复备份
  const toggleReminderMode = async (todo) => {
    if (todo.reminderTime) {
      // 有提醒时间 → 关闭（保留备份）
      await clearReminder(todo.id);
    } else {
      // 无提醒时间 → 开启（优先恢复备份，否则默认+6h）
      const restoreTs = todo.reminderTimeBackup || getDefaultReminderTime();
      await setReminder(todo.id, restoreTs);
    }
  };

  // 状态筛选按钮
  const statusFilters = [
    { key: 'all', label: '全部' },
    { key: 'active', label: '进行中' },
    { key: 'completed', label: '已完成' },
  ];

  // 关闭右键菜单
  const closeContextMenu = () => setContextMenu(null);

  return (
    <div onClick={closeContextMenu} onContextMenu={(e) => e.preventDefault()}>
      <style>{`
        .todo-scroll::-webkit-scrollbar { width: 2px !important; }
        .todo-scroll::-webkit-scrollbar-track { background: transparent !important; border-radius: 999px !important; }
        .todo-scroll::-webkit-scrollbar-thumb { border-radius: 999px !important; background: transparent !important; }
        .todo-scroll:hover::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.2) !important; }
        .todo-scroll::-webkit-scrollbar-button { display: none !important; }
      `}</style>
      <div className="card p-3">
        {/* ===== 筛选栏 ===== */}
        <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <span className="text-[15px] font-semibold text-fluent-text-primary mr-1">待办</span>
          <ListFilter size={10} className="text-fluent-text-tertiary" />
          {/* 状态筛选 */}
          {statusFilters.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`text-[12px] font-normal px-1.5 py-0.5 rounded-fluent transition-colors ${
                statusFilter === f.key
                  ? 'bg-fluent-accent-light text-fluent-accent'
                  : 'text-fluent-text-tertiary hover:text-fluent-text-secondary'
              }`}
            >
              {f.label}
            </button>
          ))}
          {/* 优先级下拉筛选 */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                // 切换下拉：如果已打开则关闭，否则打开
                setPriorityFilter((prev) => prev === '_open' ? 'all' : '_open');
              }}
              className="text-[12px] font-normal px-1.5 py-0.5 rounded-fluent flex items-center gap-0.5 text-fluent-text-tertiary hover:text-fluent-text-secondary transition-colors"
            >
              {priorityFilter === 'all' || priorityFilter === '_open'
                ? '优先级'
                : PRIORITY_CONFIG[priorityFilter]?.label}
              <ChevronDown size={8} />
            </button>
            {priorityFilter === '_open' && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-fluent-surface-flyout border border-fluent-stroke-card rounded-fluent-lg py-1 shadow-fluent-flyout min-w-[80px]">
                <button
                  onClick={(e) => { e.stopPropagation(); setPriorityFilter('all'); }}
                  className="w-full text-left text-[12px] font-normal px-3 py-1.5 text-fluent-text-secondary hover:bg-fluent-fill-hover"
                >
                  全部优先级
                </button>
                {PRIORITY_KEYS.map((key) => (
                  <button
                    key={key}
                    onClick={(e) => { e.stopPropagation(); setPriorityFilter(key); }}
                    className="w-full text-left text-[12px] font-normal px-3 py-1.5 text-fluent-text-secondary hover:bg-fluent-fill-hover flex items-center gap-2"
                  >
                    <span className={`w-2 h-2 rounded-full ${PRIORITY_CONFIG[key].color}`} />
                    {PRIORITY_CONFIG[key].label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== 输入框 + 优先级选择器 ===== */}
      <form
        onSubmit={(e) => { e.preventDefault(); addTodo(); }}
        className="flex items-center gap-2 mb-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="点击右边截图按钮，或输入文字后点＋号，生成待办"
          className="input flex-1 px-3 py-1.5 text-[14px]"
        />
        {/* 优先级圆点选择器 */}
        <div className="flex items-center gap-1">
          {PRIORITY_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setPriorityPicker(priorityPicker === key ? null : key)}
              title={PRIORITY_CONFIG[key].label}
              className={`w-3 h-3 rounded-full transition-all ${
                PRIORITY_CONFIG[key].color
              } ${
                priorityPicker === key
                  ? 'ring-1 ring-fluent-text-tertiary scale-125'
                  : 'opacity-40 hover:opacity-80'
              }`}
            />
          ))}
        </div>
        <button
          type="submit"
          className="icon-btn p-1.5"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          data-tour="screenshot-btn"
          onClick={() => {
            console.log('[TodoList] camera clicked, onScreenshot=', onScreenshot);
            if (typeof onScreenshot === 'function') onScreenshot();
          }}
          disabled={screenshotStatus === 'capturing' || screenshotStatus === 'analyzing'}
          className="icon-btn p-1.5"
          title="截图加待办"
        >
          {screenshotStatus === 'capturing' || screenshotStatus === 'analyzing' ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Camera size={14} />
          )}
        </button>
      </form>

      {/* ===== 待办列表 ===== */}
      {filteredTodos.length === 0 ? (
        <div data-tour="todo-item" className="text-[12px] font-normal text-fluent-text-tertiary py-2 text-center">
          {statusFilter === 'all' && priorityFilter === 'all' ? '暂无待办' : '没有符合条件的待办'}
        </div>
      ) : (
        <div ref={listRef} data-tour="todo-item" className="todo-scroll space-y-1 max-h-[166px] overflow-y-auto">
          {filteredTodos.map((todo) => {
            const pc = PRIORITY_CONFIG[todo.priority || 'medium'];
            return (
              <div
                key={todo.id}
                id={`todo-item-${todo.id}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, todo });
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  setDropTargetId(todo.id);
                  console.log('[TodoList DragOver] todo=', todo.id);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget)) {
                    setDropTargetId(null);
                    console.log('[TodoList DragLeave] todo=', todo.id);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTargetId(null);
                  let data = null;
                  // 尝试 application/json
                  const rawJson = e.dataTransfer.getData('application/json');
                  if (rawJson) {
                    try { data = JSON.parse(rawJson); } catch {}
                  }
                  // fallback 到 text/workspace
                  if (!data || !data.workspaceId) {
                    const rawText = e.dataTransfer.getData('text/workspace');
                    if (rawText) {
                      const [id, name] = rawText.split('|');
                      if (id) data = { workspaceId: id, workspaceName: name };
                    }
                  }
                  // Electron fallback: 全局变量
                  if ((!data || !data.workspaceId) && window.__draggingWorkspace) {
                    data = window.__draggingWorkspace;
                  }
                  console.log('[TodoList Drop] data=', data, 'json=', rawJson, 'text=', e.dataTransfer.getData('text/workspace'));
                  if (data && data.workspaceId) {
                    bindWorkspace(todo.id, data.workspaceId);
                  }
                }}
                className={`group flex items-center gap-1 h-[30px] pl-0 rounded-fluent hover:bg-fluent-fill-hover transition-colors ${
                  // 紧急未完成：红色背景 glow
                  todo.priority === 'urgent' && !todo.done ? 'bg-red-50' : ''
                } ${dropTargetId === todo.id ? 'ring-1 ring-inset ring-fluent-accent bg-fluent-accent-light' : ''} ${
                  todo.isNew ? 'animate-new-todo' : ''
                }`}
              >
                {/* 优先级色条 (4px) */}
                <div className={`w-1 h-full rounded-l-fluent flex-shrink-0 ${
                  pc.color
                } ${
                  todo.done ? 'opacity-30' : ''
                }`} />

                <div className="flex items-center gap-1.5 flex-1 px-1 min-w-0">
                  {/* 复选框 */}
                  <button
                    onClick={() => toggleTodo(todo.id)}
                    className={`w-4 h-4 rounded-fluent border flex items-center justify-center flex-shrink-0 transition-colors ${
                      todo.done
                        ? 'bg-fluent-accent border-fluent-accent'
                        : 'border-fluent-stroke-control hover:border-fluent-accent'
                    }`}
                  >
                    {todo.done && <Check size={10} className="text-fluent-text-on-accent" />}
                  </button>

                  {/* 文字（带 tooltip）/ 编辑输入框 */}
                  <div className="flex-1 min-w-0 overflow-hidden relative">
                    {editingId === todo.id ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') confirmEdit();
                          if (e.key === 'Escape') { setEditingId(null); setEditValue(''); }
                        }}
                        onBlur={confirmEdit}
                        className="input w-full text-[14px] border-fluent-accent px-1.5 py-0.5"
                      />
                    ) : (
                      <span
                        ref={el => { if (el) todoTextRefs.current.set(todo.id, el); }}
                        onMouseEnter={(e) => {
                          const el = todoTextRefs.current.get(todo.id);
                          if (el && el.scrollWidth > el.clientWidth) {
                            if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
                            tooltipTimer.current = setTimeout(() => {
                              const rect = el.getBoundingClientRect();
                              setTooltip({
                                show: true,
                                text: todo.text,
                                x: rect.left + rect.width / 2,
                                y: rect.top - 8
                              });
                            }, 200);
                          }
                        }}
                        onMouseLeave={() => {
                          if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
                          setTooltip(prev => ({ ...prev, show: false }));
                        }}
                        onDoubleClick={() => {
                          setEditingId(todo.id);
                          setEditValue(todo.text);
                        }}
                        className={`block text-[14px] font-normal truncate transition-all cursor-default ${
                          todo.done ? 'line-through text-fluent-text-tertiary' : 'text-fluent-text-primary'
                        }`}
                        title="双击编辑"
                      >
                        {(() => {
                          const match = todo.text.match(/^([^：:]+)[：:](.*)$/);
                          if (match) {
                            return (
                              <>
                                <span className="font-semibold">{match[1]}</span>
                                <span className="text-fluent-text-tertiary mx-0.5">：</span>
                                <span>{match[2]}</span>
                              </>
                            );
                          }
                          return todo.text;
                        })()}
                      </span>
                    )}
                  </div>
                </div>

                {todo.workspaceId && (
                  <span
                    className="text-[11px] rounded-fluent text-fluent-text-on-accent w-[18px] h-[18px] inline-flex items-center justify-center flex-shrink-0 mr-2 tabular-nums leading-none cursor-pointer"
                    title={`${workspaces.find((w) => w.id === todo.workspaceId)?.name || ''}（双击跳转）`}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      if (onSwitchWorkspace) onSwitchWorkspace(todo.workspaceId);
                    }}
                    style={{
                      backgroundColor: (() => {
                        const idx = workspaces.findIndex((w) => w.id === todo.workspaceId);
                        return idx >= 0 ? gradientColor(idx, workspaces.length) : '#0259BB';
                      })(),
                      fontFamily: "'D-DIN', 'JetBrains Mono', monospace",
                    }}
                  >
                    {(() => {
                      const idx = workspaces.findIndex((w) => w.id === todo.workspaceId);
                      return idx >= 0 ? idx + 1 : '-';
                    })()}
                  </span>
                )}

                {/* 提醒时间标签 */}
                {reminderPicker === todo.id ? (
                  <input
                    type="datetime-local"
                    autoFocus
                    defaultValue={toDatetimeLocalValue(todo.reminderTime)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val) {
                        const ts = new Date(val).getTime();
                        if (!isNaN(ts)) setReminder(todo.id, ts);
                      }
                    }}
                    onBlur={() => setReminderPicker(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setReminderPicker(null);
                    }}
                    className="input text-[12px] px-1 py-0.5 border-fluent-accent w-[130px] flex-shrink-0"
                  />
                ) : (
                  <span
                    tabIndex={0}
                    onKeyDown={(e) => handleReminderKeyDown(e, todo)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      toggleReminderMode(todo);
                    }}
                    title="双击开关｜↑↓/WS±5分｜Shift+↑↓/WS±1时｜←→/AD±1天"
                    className="text-[12px] font-normal text-fluent-text-tertiary px-1 py-0.5 rounded-fluent truncate text-center flex-shrink-0 cursor-pointer select-none transition-all focus:outline-none focus:scale-110 focus:shadow-[0_0_12px_2px_rgba(255,255,255,0.95),0_3px_8px_rgba(0,0,0,0.45)] mr-2 tabular-nums tracking-wide"
                    style={(() => {
                      const c = getReminderColor(todo.reminderTime, reminderLevels);
                      return {
                        backgroundColor: c.bg,
                        color: c.text,
                        fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                      };
                    })()}
                  >
                    {formatReminderTime(todo.reminderTime)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ===== Tooltip ===== */}
      {tooltip.show && (
        <div
          className="fixed z-50 px-2 py-1 text-[12px] font-normal text-fluent-text-primary bg-fluent-surface-flyout border border-fluent-stroke-card rounded-fluent shadow-fluent-flyout pointer-events-none whitespace-nowrap"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -100%)'
          }}
        >
          {tooltip.text}
          <div className="absolute left-1/2 top-full -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-fluent-surface-flyout" />
        </div>
      )}

      {/* ===== 右键菜单 — 设置紧急程度 / 重命名 / 移除项目关联 / 删除 ===== */}
      {contextMenu && (
        <div
          className="fixed z-[9999] bg-fluent-surface-flyout border border-fluent-stroke-card rounded-fluent-lg py-1 shadow-fluent-flyout min-w-[120px]"
          style={(() => {
            const menuW = 150;
            const winW = window.innerWidth;
            const left = contextMenu.x + menuW > winW ? winW - menuW - 4 : contextMenu.x;
            return { left, top: contextMenu.y };
          })()}
        >
          {/* 设置紧急程度 */}
          {PRIORITY_KEYS.map((key) => (
            <button
              key={key}
              onClick={(e) => {
                e.stopPropagation();
                changePriority(contextMenu.todo.id, key);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fluent-text-secondary hover:bg-fluent-fill-hover"
            >
              <span className={`w-2.5 h-2.5 rounded-full ${PRIORITY_CONFIG[key].color}`} />
              设为{PRIORITY_CONFIG[key].label}
            </button>
          ))}

          <div className="border-t border-fluent-stroke-divider my-1" />

          {/* 重命名 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditingId(contextMenu.todo.id);
              setEditValue(contextMenu.todo.text);
              setContextMenu(null);
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fluent-text-secondary hover:bg-fluent-fill-hover"
          >
            <Pencil size={12} className="text-fluent-text-tertiary" />
            编辑
          </button>

          {/* 设置/清除提醒时间 */}
          {(() => {
            if (!contextMenu.todo?.reminderTime) {
              return (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleReminderMode(contextMenu.todo);
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-fluent-text-secondary hover:bg-fluent-fill-hover"
                >
                  <span className="text-fluent-success text-[11px]">⏰</span>
                  开启提醒
                </button>
              );
            }
            return (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setReminderPicker(contextMenu.todo.id);
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-fluent-text-secondary hover:bg-fluent-fill-hover"
                >
                  <span className="text-fluent-text-tertiary text-[11px]">⏰</span>
                  修改提醒时间
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    clearReminder(contextMenu.todo.id);
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-fluent-text-secondary hover:bg-fluent-fill-hover"
                >
                  <span className="text-fluent-text-tertiary text-[11px]">✕</span>
                  关闭提醒
                </button>
              </>
            );
          })()}

          {/* 移除项目关联 */}
          {contextMenu.todo?.workspaceId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                unbindWorkspace(contextMenu.todo.id);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-fluent-text-secondary hover:bg-fluent-fill-hover"
            >
              <span className="w-2.5 h-2.5 rounded-full border border-fluent-stroke-control bg-transparent" />
              移除项目关联
            </button>
          )}

          <div className="border-t border-fluent-stroke-divider my-1" />

          {/* 删除 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              removeTodo(contextMenu.todo.id);
              setContextMenu(null);
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-fluent-danger hover:bg-fluent-fill-hover"
          >
            <Trash2 size={12} className="text-fluent-danger" />
            删除
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
