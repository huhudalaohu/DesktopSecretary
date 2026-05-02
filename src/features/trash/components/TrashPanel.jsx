import React from 'react';

export default function TrashPanel({
  panelRef,
  fontScale,
  trashedWorkspaces,
  trashedTodos,
  restoreWorkspace,
  restoreTodo,
  permanentlyDeleteWorkspace,
  permanentlyDeleteTodo,
  clearTrash,
}) {
  return (
    <div
      ref={panelRef}
      style={{ zoom: 1 / fontScale }}
      className="mx-4 mb-2 rounded-lg bg-[#F0F0F0] border border-[#D4D4D4] p-3 space-y-3 shadow-md max-h-[40vh] overflow-y-auto"
    >
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-gray-700 tracking-wide">回收站</h2>
        <div className="flex items-center gap-1">
          {(trashedWorkspaces.length > 0 || trashedTodos.length > 0) && (
            <button
              onClick={clearTrash}
              className="text-[10px] px-2 py-0.5 rounded bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
            >
              清空全部
            </button>
          )}
          <span className="text-[9px] text-gray-400">
            {trashedWorkspaces.length} 项目 · {trashedTodos.length} 待办
          </span>
        </div>
      </div>

      {/* 已删除项目 */}
      {trashedWorkspaces.length > 0 && (
        <section className="bg-white rounded-md p-2.5 space-y-2">
          <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">项目</h3>
          <div className="space-y-1">
            {trashedWorkspaces.map((ws) => (
              <div key={ws.id} className="flex items-center justify-between text-xs">
                <span className="text-gray-700 truncate max-w-[120px]">{ws.name}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => restoreWorkspace(ws)}
                    className="text-[10px] px-2 py-0.5 rounded bg-green-50 text-green-600 hover:bg-green-100 transition-colors"
                  >
                    恢复
                  </button>
                  <button
                    onClick={() => permanentlyDeleteWorkspace(ws.id)}
                    className="text-[10px] px-2 py-0.5 rounded bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 已删除待办 */}
      {trashedTodos.length > 0 && (
        <section className="bg-white rounded-md p-2.5 space-y-2">
          <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">待办</h3>
          <div className="space-y-1">
            {trashedTodos.map((todo) => (
              <div key={todo.id} className="flex items-center justify-between text-xs">
                <span className="text-gray-700 truncate max-w-[120px]">{todo.text}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => restoreTodo(todo)}
                    className="text-[10px] px-2 py-0.5 rounded bg-green-50 text-green-600 hover:bg-green-100 transition-colors"
                  >
                    恢复
                  </button>
                  <button
                    onClick={() => permanentlyDeleteTodo(todo.id)}
                    className="text-[10px] px-2 py-0.5 rounded bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {trashedWorkspaces.length === 0 && trashedTodos.length === 0 && (
        <div className="text-[10px] text-gray-400 text-center py-2">回收站为空</div>
      )}
    </div>
  );
}
