import { useState } from 'react';

export function useTrash(api, workspaces, setWorkspaces) {
  const [trashedWorkspaces, setTrashedWorkspaces] = useState([]);
  const [trashedTodos, setTrashedTodos] = useState([]);

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
    trashedWorkspaces,
    setTrashedWorkspaces,
    trashedTodos,
    setTrashedTodos,
    restoreWorkspace,
    restoreTodo,
    permanentlyDeleteWorkspace,
    permanentlyDeleteTodo,
    clearTrash,
  };
}
