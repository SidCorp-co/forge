'use client';

import type { AgentTodo } from './chat-message-types';

export function TodoProgress({ todos }: { todos: AgentTodo[] }) {
  if (!todos.length) return null;
  const completed = todos.filter((t) => t.status === 'completed').length;

  return (
    <div className="my-2 rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 font-mono text-xs">
      <div className="flex items-center justify-between mb-1.5 text-[#666666]">
        <span>Agent Progress</span>
        <span>{completed}/{todos.length} completed</span>
      </div>
      <div className="space-y-0.5">
        {todos.map((todo, i) => (
          <TodoItem key={i} todo={todo} />
        ))}
      </div>
    </div>
  );
}

function getTodoColors(status: AgentTodo['status']): { text: string; icon: string } {
  switch (status) {
    case 'completed':
      return { text: 'text-success', icon: 'text-success' };
    case 'in_progress':
      return { text: 'text-[#cccccc]', icon: 'text-info' };
    default:
      return { text: 'text-[#555555]', icon: 'text-[#444444]' };
  }
}

function TodoItem({ todo }: { todo: AgentTodo }) {
  const icon = todo.status === 'completed' ? '✓' : '☐';
  const { text: textColor, icon: iconColor } = getTodoColors(todo.status);

  return (
    <div>
      <div className="flex items-center gap-2 py-0.5">
        <span className={`select-none ${iconColor}`}>{icon}</span>
        <span className={textColor}>{todo.content}</span>
      </div>
      {todo.status === 'in_progress' && todo.activeForm && (
        <div className="ml-6 flex items-center gap-1.5 text-[#666666]">
          <span className="select-none">⎿</span>
          <span className="animate-pulse">{todo.activeForm}...</span>
        </div>
      )}
    </div>
  );
}
