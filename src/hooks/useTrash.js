import { useState, useEffect, useRef } from 'react';

export function useTrash(api, workspaces, setWorkspaces) {
  const [showTrash, setShowTrash] = useState(false);
  const [trashedWorkspaces, setTrashedWorkspaces] = useState([]);
  const [trashedTodos, setTrashedTodos] = useState([]);

  const trashPanelRef = useRef(null);
  const trashButtonRef = useRef(null);

  // 点击面板/按钮之外任意处自动收起
  useEffect(() => {
    if (!showTrash) return;
    const onMouseDown = (e) => {
      const panel = trashPanelRef.current;
      const btn = trashButtonRef.current;
      if (panel && panel.contains(e.target)) return;
      if (btn && btn.contains(e.target)) return;
      setShowTrash(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showTrash]);

  const restoreWorkspace = async (ws) => {
    const updated = [...workspaces, ws];
    setWorkspaces(updated);
    await api.storeSet('workspaces', updated);
    const remaining = trashedWorkspaces.filter((w) => w.id !== ws.id);
    setTrashedWorkspaces(remaining);
    await api.storeSet('trashedWorkspaces', remaining);
  };

  const restoreTodo = async (todo) => {
    const current = await api.storeGet('todosGlobal', []);
    const updated = [...current, todo];
    await api.storeSet('todosGlobal', updated);
    window.dispatchEvent(new Event('todos-updated'));
    const remaining = trashedTodos.filter((t) => t.id !== todo.id);
    setTrashedTodos(remaining);
    await api.storeSet('trashedTodos', remaining);
  };

  const permanentlyDeleteWorkspace = async (id) => {
    const remaining = trashedWorkspaces.filter((w) => w.id !== id);
    setTrashedWorkspaces(remaining);
    await api.storeSet('trashedWorkspaces', remaining);
  };

  const permanentlyDeleteTodo = async (id) => {
    const remaining = trashedTodos.filter((t) => t.id !== id);
    setTrashedTodos(remaining);
    await api.storeSet('trashedTodos', remaining);
  };

  const clearTrash = async () => {
    setTrashedWorkspaces([]);
    setTrashedTodos([]);
    await api.storeSet('trashedWorkspaces', []);
    await api.storeSet('trashedTodos', []);
  };

  return {
    showTrash,
    setShowTrash,
    trashedWorkspaces,
    setTrashedWorkspaces,
    trashedTodos,
    setTrashedTodos,
    trashPanelRef,
    trashButtonRef,
    restoreWorkspace,
    restoreTodo,
    permanentlyDeleteWorkspace,
    permanentlyDeleteTodo,
    clearTrash,
  };
}
