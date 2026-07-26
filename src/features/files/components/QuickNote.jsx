import React, { useState, useEffect, useRef } from 'react';

const api = window.desktopAPI;

export default function QuickNote() {
  const [text, setText] = useState('');
  const saveTimer = useRef(null);
  const storeKey = 'quickNote';

  useEffect(() => {
    api.storeGet(storeKey, '').then(setText);
  }, []);

  const handleChange = (e) => {
    const v = e.target.value;
    setText(v);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.storeSet(storeKey, v);
    }, 500);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[15px] font-semibold text-fluent-text-primary">随手记</span>
      </div>
      <textarea
        value={text}
        onChange={handleChange}
        placeholder="随手记点什么..."
        spellCheck={false}
        className="input w-full p-3 text-[14px] resize-none"
        style={{ height: 'calc(1.5em * 6 + 24px)', lineHeight: '1.5em' }}
      />
    </div>
  );
}
