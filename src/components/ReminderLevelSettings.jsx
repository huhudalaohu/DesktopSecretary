/**
 * ReminderLevelSettings.jsx — 时间层级与颜色自定义设置
 *
 * 功能：
 * - 增删改时间提醒层级
 * - 调整每个层级的时间阈值（分钟/小时/天）
 * - Excel 风格标准色盘选择背景色和文字色
 */

import React, { useState, useEffect } from 'react';
import { Plus, Trash2, ChevronDown } from 'lucide-react';

/* ===== Excel 主题色盘（列=色系，行=深浅） ===== */
const EXCEL_PALETTE = [
  // 第1行：深色 50%
  ['#9E0000', '#9E480E', '#9C6500', '#375623', '#1F4E79', '#203764', '#4A206B', '#404040'],
  // 第2行：深色 25%
  ['#C00000', '#C55A11', '#BF8F00', '#548235', '#2E75B6', '#305496', '#7030A0', '#595959'],
  // 第3行：主题色（标准色）
  ['#FF0000', '#ED7D31', '#FFC000', '#70AD47', '#5B9BD5', '#4472C4', '#8E5BB5', '#7F7F7F'],
  // 第4行：浅色 40%
  ['#FF9999', '#F4B084', '#FFD966', '#A9D18E', '#9DC3E6', '#8FAADC', '#B4A7D6', '#BFBFBF'],
  // 第5行：浅色 80%
  ['#FFCCCC', '#FCE4D6', '#FFF2CC', '#E2F0DA', '#D9E2F3', '#D6DCE4', '#E5E0EC', '#D9D9D9'],
];

function ColorPicker({ value, onChange, label }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#D4D4D4] bg-white hover:border-[#999] transition-colors"
        title={label}
      >
        <span
          className="w-3 h-3 rounded-sm border border-[#E5E5E5]"
          style={{ backgroundColor: value }}
        />
        <ChevronDown size={10} className="text-gray-400" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 p-1.5 bg-white border border-[#D4D4D4] rounded shadow-lg grid gap-0.5">
            {EXCEL_PALETTE.map((row, ri) => (
              <div key={ri} className="flex gap-0.5">
                {row.map((color) => (
                  <button
                    key={color}
                    onClick={() => { onChange(color); setOpen(false); }}
                    className="w-4 h-4 rounded-sm border border-[#E5E5E5] hover:scale-110 transition-transform"
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>
            ))}
            <div className="border-t border-[#E5E5E5] pt-1 mt-0.5">
              <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder="#RRGGBB"
                className="w-full px-1 py-0.5 text-[9px] rounded border border-[#E5E5E5] outline-none focus:border-[#0099FF]"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DurationInput({ value, onChange }) {
  const [num, setNum] = useState('');
  const [unit, setUnit] = useState('分钟');

  // 根据传入的分钟数反推数字和单位
  useEffect(() => {
    if (value >= 1440 && value % 1440 === 0) {
      setNum(String(value / 1440));
      setUnit('天');
    } else if (value >= 60 && value % 60 === 0) {
      setNum(String(value / 60));
      setUnit('小时');
    } else {
      setNum(String(value));
      setUnit('分钟');
    }
  }, [value]);

  const commit = (nextNum, nextUnit) => {
    const n = parseFloat(nextNum);
    if (!isNaN(n) && n > 0) {
      const multiplier = nextUnit === '天' ? 1440 : nextUnit === '小时' ? 60 : 1;
      onChange(Math.round(n * multiplier));
    }
  };

  return (
    <div className="flex items-center gap-0.5">
      <input
        type="number"
        min="0"
        step="0.1"
        value={num}
        onChange={(e) => {
          setNum(e.target.value);
          commit(e.target.value, unit);
        }}
        className="w-10 px-1 py-0.5 text-[10px] rounded border border-[#E5E5E5] outline-none focus:border-[#0099FF]"
      />
      <select
        value={unit}
        onChange={(e) => {
          const u = e.target.value;
          setUnit(u);
          commit(num, u);
        }}
        className="w-[52px] px-0.5 py-0.5 text-[10px] rounded border border-[#E5E5E5] outline-none focus:border-[#0099FF] bg-white"
      >
        <option value="分钟">分钟</option>
        <option value="小时">小时</option>
        <option value="天">天</option>
      </select>
    </div>
  );
}

export const DEFAULT_REMINDER_LEVELS = [
  { id: 'expired', label: '已过期', minutes: 0, bg: '#E5E7EB', text: '#6B7280' },
  { id: 'urgent', label: '紧急', minutes: 60, bg: 'rgba(220, 38, 38, 0.15)', text: '#B91C1C' },
  { id: 'soon', label: '紧迫', minutes: 360, bg: 'rgba(245, 158, 11, 0.12)', text: '#B45309' },
  { id: 'today', label: '今日', minutes: 1440, bg: 'rgba(16, 185, 129, 0.10)', text: '#059669' },
  { id: 'near', label: '近期', minutes: 4320, bg: 'rgba(52, 211, 153, 0.08)', text: '#10B981' },
  { id: 'month', label: '月内', minutes: 10080, bg: '#E8F8F0', text: '#10B981' },
  { id: 'far', label: '远期', minutes: 43200, bg: '#F0FDF4', text: '#9CA3AF' },
];

export default function ReminderLevelSettings({ levels, onChange }) {
  const updateLevel = (id, patch) => {
    onChange(levels.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const addLevel = () => {
    const maxMin = levels.length > 0 ? Math.max(...levels.map((l) => l.minutes)) : 0;
    const newLevel = {
      id: `lvl-${Date.now()}`,
      label: '新层级',
      minutes: maxMin + 1440,
      bg: '#F0FDF4',
      text: '#9CA3AF',
    };
    const next = [...levels, newLevel].sort((a, b) => a.minutes - b.minutes);
    onChange(next);
  };

  const removeLevel = (id) => {
    if (levels.length <= 2) return;
    onChange(levels.filter((l) => l.id !== id));
  };

  return (
    <div className="space-y-2">
      <div className="text-[9px] text-gray-400 leading-relaxed">
        按时间由近到远排列，第一个层级固定为"已过期"。
      </div>

      <div className="space-y-1">
        {levels.map((level, index) => (
          <div
            key={level.id}
            className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-white border border-[#E5E5E5]"
          >
            {/* 层级序号 */}
            <span className="text-[9px] text-gray-400 w-3 text-center tabular-nums">{index + 1}</span>

            {/* 标签名 */}
            <input
              value={level.label}
              onChange={(e) => updateLevel(level.id, { label: e.target.value })}
              disabled={level.minutes === 0}
              className="w-14 px-1 py-0.5 text-[10px] rounded border border-[#E5E5E5] outline-none focus:border-[#0099FF] disabled:bg-[#F5F5F5] disabled:text-gray-400"
            />

            {/* 时间阈值 */}
            {level.minutes === 0 ? (
              <span className="text-[10px] text-gray-400 w-[88px]">已过期</span>
            ) : (
              <DurationInput
                value={level.minutes}
                onChange={(minutes) => {
                  const next = levels.map((l) => (l.id === level.id ? { ...l, minutes } : l));
                  onChange(next.sort((a, b) => a.minutes - b.minutes));
                }}
              />
            )}

            {/* 背景色 */}
            <ColorPicker
              label="背景色"
              value={level.bg}
              onChange={(color) => updateLevel(level.id, { bg: color })}
            />

            {/* 文字色 */}
            <ColorPicker
              label="文字色"
              value={level.text}
              onChange={(color) => updateLevel(level.id, { text: color })}
            />

            {/* 预览 */}
            <span
              className="ml-auto text-[9px] px-1.5 py-0.5 rounded min-w-[36px] text-center"
              style={{ backgroundColor: level.bg, color: level.text }}
            >
              预览
            </span>

            {/* 删除 */}
            <button
              onClick={() => removeLevel(level.id)}
              disabled={level.minutes === 0 || levels.length <= 2}
              className="p-0.5 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 disabled:opacity-30 transition-colors"
            >
              <Trash2 size={10} />
            </button>
          </div>
        ))}
      </div>

      <button
        onClick={addLevel}
        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[#0099FF] hover:bg-blue-50 border border-dashed border-[#0099FF] transition-colors"
      >
        <Plus size={10} />
        添加层级
      </button>
    </div>
  );
}
