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

import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Check, ListFilter, ChevronDown } from 'lucide-react';

const api = window.desktopAPI;

// 优先级配置：颜色、标签、排序权重（数字越小越优先）
const PRIORITY_CONFIG = {
  urgent: { label: '紧急', color: 'bg-red-500', glow: 'bg-red-500/10', order: 0 },
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
 * 按优先级排序：urgent > high > medium > low
 * 同优先级内按 id（时间戳）倒序，新的在前
 */
function sortByPriority(todos) {
  return todos
    .filter((t) => t && t.id)
    .sort((a, b) => {
      const pA = PRIORITY_CONFIG[a.priority || 'medium'];
      const pB = PRIORITY_CONFIG[b.priority || 'medium'];
      if (!pA || !pB) return 0;
      const diff = pA.order - pB.order;
      if (diff !== 0) return diff;
      return String(b.id).localeCompare(String(a.id));
    });
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
    }));
}

export default function TodoList() {
  const [todos, setTodos] = useState([]);              // 全局待办列表
  const [input, setInput] = useState('');              // 输入框内容
  const [statusFilter, setStatusFilter] = useState('all');  // 状态筛选: all | active | completed
  const [priorityFilter, setPriorityFilter] = useState('all'); // 优先级筛选: all | urgent | high | medium | low
  const [priorityPicker, setPriorityPicker] = useState(null);  // 选择中的优先级（输入框旁圆点）
  const [contextMenu, setContextMenu] = useState(null);  // 右键菜单 {x, y, todo}

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

  // 保存到 electron-store
  const saveTodos = async (updated) => {
    setTodos(updated);
    await api.storeSet('todosGlobal', updated);
  };

  // 排序后的待办列表
  const sortedTodos = sortByPriority(todos);

  // 筛选后的列表
  const filteredTodos = sortedTodos.filter((t) => {
    // 状态筛选
    if (statusFilter === 'active' && t.done) return false;
    if (statusFilter === 'completed' && !t.done) return false;
    // 优先级筛选
    if (priorityFilter !== 'all' && (t.priority || 'medium') !== priorityFilter) return false;
    return true;
  });

  // 添加待办
  const addTodo = async () => {
    const raw = input.trim();
    if (!raw) return;

    // 解析优先级前缀（如 "!urgent 买牛奶"）
    const { priority: prefixPriority, text: parsedText } = parsePriorityPrefix(raw);
    // 如果用户手动选择了优先级圆点，优先用圆点；否则用前缀解析结果
    const priority = priorityPicker || prefixPriority;
    const text = parsedText.trim();
    if (!text) return;

    const newTodo = { id: `todo-${Date.now()}`, text, done: false, priority };
    await saveTodos([...todos, newTodo]);
    setInput('');
    setPriorityPicker(null);
  };

  // 切换完成状态
  const toggleTodo = async (id) => {
    const updated = todos.map((t) =>
      t.id === id ? { ...t, done: !t.done } : t
    );
    await saveTodos(updated);
  };

  // 删除待办
  const removeTodo = async (id) => {
    const updated = todos.filter((t) => t.id !== id);
    await saveTodos(updated);
  };

  // 修改优先级
  const changePriority = async (id, newPriority) => {
    const updated = todos.map((t) =>
      t.id === id ? { ...t, priority: newPriority } : t
    );
    await saveTodos(updated);
    setContextMenu(null);
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
      <div className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">待办</div>

      <div className="rounded-xl bg-white/5 border border-white/10 p-3">
        {/* ===== 筛选栏 ===== */}
        <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <ListFilter size={10} className="text-white/20" />
          {/* 状态筛选 */}
          {statusFilters.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                statusFilter === f.key
                  ? 'bg-white/15 text-white/80'
                  : 'text-white/30 hover:text-white/50'
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
              className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5 text-white/30 hover:text-white/50 transition-colors"
            >
              {priorityFilter === 'all' || priorityFilter === '_open'
                ? '优先级'
                : PRIORITY_CONFIG[priorityFilter]?.label}
              <ChevronDown size={8} />
            </button>
            {priorityFilter === '_open' && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-slate-800/95 backdrop-blur border border-white/10 rounded-lg py-1 shadow-xl min-w-[80px]">
                <button
                  onClick={(e) => { e.stopPropagation(); setPriorityFilter('all'); }}
                  className="w-full text-left text-[10px] px-3 py-1.5 text-white/60 hover:bg-white/10"
                >
                  全部优先级
                </button>
                {PRIORITY_KEYS.map((key) => (
                  <button
                    key={key}
                    onClick={(e) => { e.stopPropagation(); setPriorityFilter(key); }}
                    className="w-full text-left text-[10px] px-3 py-1.5 text-white/60 hover:bg-white/10 flex items-center gap-2"
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
          placeholder="添加待办（!u/!h/!m/!l 快捷设置优先级）..."
          className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-white placeholder-white/25 outline-none focus:border-white/20 transition-colors"
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
                  ? 'ring-1 ring-white/60 scale-125'
                  : 'opacity-40 hover:opacity-80'
              }`}
            />
          ))}
        </div>
        <button
          type="submit"
          className="p-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white/60 hover:text-white transition-colors"
        >
          <Plus size={14} />
        </button>
      </form>

      {/* ===== 待办列表 ===== */}
      {filteredTodos.length === 0 ? (
        <div className="text-xs text-white/20 py-2 text-center">
          {statusFilter === 'all' && priorityFilter === 'all' ? '暂无待办' : '没有符合条件的待办'}
        </div>
      ) : (
        <div className="space-y-1 max-h-[196px] overflow-y-auto">
          {filteredTodos.map((todo) => {
            const pc = PRIORITY_CONFIG[todo.priority || 'medium'];
            return (
              <div
                key={todo.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, todo });
                }}
                className={`group flex items-center gap-2 h-[36px] pl-0 rounded-lg hover:bg-white/5 transition-colors ${
                  // 紧急未完成：红色背景 glow
                  todo.priority === 'urgent' && !todo.done ? pc.glow : ''
                }`}
              >
                {/* 优先级色条 (4px) */}
                <div className={`w-1 h-full rounded-l-lg flex-shrink-0 ${
                  pc.color
                } ${
                  // 已完成的高优先级：降低透明度
                  todo.done ? 'opacity-30' : ''
                }`} />

                <div className="flex items-center gap-2 flex-1 px-2 min-w-0">
                  {/* 复选框 */}
                  <button
                    onClick={() => toggleTodo(todo.id)}
                    className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                      todo.done
                        ? 'bg-blue-500/30 border-blue-400/50'
                        : 'border-white/20 hover:border-white/40'
                    }`}
                  >
                    {todo.done && <Check size={10} className="text-blue-300" />}
                  </button>

                  {/* 文字 */}
                  <span
                    className={`flex-1 text-xs truncate transition-all ${
                      todo.done ? 'line-through opacity-50 text-white/40' : 'text-white/80'
                    }`}
                  >
                    {todo.text}
                  </span>
                </div>

                {/* 删除按钮 — 悬浮显示 */}
                <button
                  onClick={() => removeTodo(todo.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/10 text-white/30 hover:text-red-400 transition-all mr-1"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ===== 右键菜单 — 修改优先级 ===== */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-slate-800/95 backdrop-blur border border-white/10 rounded-lg py-1 shadow-xl min-w-[100px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {PRIORITY_KEYS.map((key) => (
            <button
              key={key}
              onClick={(e) => {
                e.stopPropagation();
                changePriority(contextMenu.todo.id, key);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
            >
              <span className={`w-2.5 h-2.5 rounded-full ${PRIORITY_CONFIG[key].color}`} />
              设为{PRIORITY_CONFIG[key].label}
            </button>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
