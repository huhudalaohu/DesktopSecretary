import React, { useState, useEffect, useRef } from 'react';

const api = window.desktopAPI;

/**
 * 灵感流 — 按工作区绑定:每个项目(工作区)一份内容,切换项目自动切换。
 * 存储键: quickNote:<workspaceId>
 * 兼容:旧版全局 quickNote 键的内容会迁移到首次打开时的工作区。
 */
export default function QuickNote({ activeWorkspace }) {
  const [text, setText] = useState('');
  const saveTimer = useRef(null);
  const textRef = useRef('');
  const wsRef = useRef(null);
  textRef.current = text;

  const keyFor = (ws) => `quickNote:${ws}`;

  // 切换工作区:先把上一个工作区的内容立即落盘,再加载新工作区的内容
  useEffect(() => {
    const prev = wsRef.current;
    if (prev && prev !== activeWorkspace) {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      api.storeSet(keyFor(prev), textRef.current);
    }
    wsRef.current = activeWorkspace;

    if (!activeWorkspace) {
      setText('');
      return;
    }

    api.storeGet(keyFor(activeWorkspace), null).then((v) => {
      if (v != null) {
        setText(v);
        return;
      }
      // 兼容旧版:全局 quickNote 迁移到当前工作区,只迁一次
      api.storeGet('quickNote', '').then((legacy) => {
        setText(legacy || '');
        if (legacy) {
          api.storeSet(keyFor(activeWorkspace), legacy);
          api.storeSet('quickNote', '');
        }
      });
    });
  }, [activeWorkspace]);

  // 卸载时兜底保存
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        if (wsRef.current) api.storeSet(keyFor(wsRef.current), textRef.current);
      }
    };
  }, []);

  const handleChange = (e) => {
    const v = e.target.value;
    setText(v);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (wsRef.current) api.storeSet(keyFor(wsRef.current), v);
    }, 500);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="font-display text-[15px] font-bold text-fluent-text-primary">灵感流</span>
      </div>
      <textarea
        value={text}
        onChange={handleChange}
        placeholder={activeWorkspace ? '记下此刻的灵感...' : '请先创建一个工作区'}
        disabled={!activeWorkspace}
        spellCheck={false}
        className="input w-full p-3 text-[14px] resize-none"
        style={{ height: 'calc(1.5em * 6 + 24px)', lineHeight: '1.5em' }}
      />
    </div>
  );
}
