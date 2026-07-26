import React from 'react';

export default function TrashPanel({
  trashedWorkspaces,
  trashedTodos,
  restoreWorkspace,
  restoreTodo,
  permanentlyDeleteWorkspace,
  permanentlyDeleteTodo,
  clearTrash,
}) {
  return (
    <section className="card p-2.5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">回收站</h3>
        <div className="flex items-center gap-1">
          {(trashedWorkspaces.length > 0 || trashedTodos.length > 0) && (
            <button
              onClick={clearTrash}
              className="text-[10px] px-2 py-0.5 rounded-fluent bg-red-50 text-fluent-danger hover:bg-red-100 transition-colors"
            >
              清空全部
            </button>
          )}
          <span className="text-[9px] text-fluent-text-tertiary">
            {trashedWorkspaces.length} 项目 · {trashedTodos.length} 待办
          </span>
        </div>
      </div>

      {/* 已删除项目 */}
      {trashedWorkspaces.length > 0 && (
        <div className="border-t border-fluent-stroke-divider pt-2 space-y-2">
          <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">项目</h3>
          <div className="space-y-1">
            {trashedWorkspaces.map((ws) => (
              <div key={ws.id} className="flex items-center justify-between text-xs">
                <span className="text-fluent-text-primary truncate max-w-[120px]">{ws.name}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => restoreWorkspace(ws)}
                    className="text-[10px] px-2 py-0.5 rounded-fluent bg-green-50 text-fluent-success hover:bg-green-100 transition-colors"
                  >
                    恢复
                  </button>
                  <button
                    onClick={() => permanentlyDeleteWorkspace(ws.id)}
                    className="text-[10px] px-2 py-0.5 rounded-fluent bg-red-50 text-fluent-danger hover:bg-red-100 transition-colors"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 已删除待办 */}
      {trashedTodos.length > 0 && (
        <div className="border-t border-fluent-stroke-divider pt-2 space-y-2">
          <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">待办</h3>
          <div className="space-y-1">
            {trashedTodos.map((todo) => (
              <div key={todo.id} className="flex items-center justify-between text-xs">
                <span className="text-fluent-text-primary truncate max-w-[120px]">{todo.text}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => restoreTodo(todo)}
                    className="text-[10px] px-2 py-0.5 rounded-fluent bg-green-50 text-fluent-success hover:bg-green-100 transition-colors"
                  >
                    恢复
                  </button>
                  <button
                    onClick={() => permanentlyDeleteTodo(todo.id)}
                    className="text-[10px] px-2 py-0.5 rounded-fluent bg-red-50 text-fluent-danger hover:bg-red-100 transition-colors"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {trashedWorkspaces.length === 0 && trashedTodos.length === 0 && (
        <div className="text-[10px] text-fluent-text-tertiary text-center py-2">回收站为空</div>
      )}
    </section>
  );
}
