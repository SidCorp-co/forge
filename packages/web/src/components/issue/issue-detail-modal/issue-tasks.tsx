'use client';

import { useState, type KeyboardEvent } from 'react';
import { GripVertical, Trash2 } from 'lucide-react';
import { AssigneePicker } from '@/components/issue/assignee-picker';
import { Input } from '@/components/ui/input';
import {
  useProjectMembers,
  type ProjectMemberRow,
} from '@/features/project/hooks/use-project-members';
import {
  useCreateTask,
  useDeleteTask,
  useIssueTasks,
  useReorderTasks,
  useUpdateTask,
} from '@/features/task/hooks/use-tasks';
import type { Task, TaskStatus } from '@/features/task/types';
import { TASK_STATUS_COLORS } from '@/lib/constants';
import { formatApiError } from '@/lib/api/error';
import { cn } from '@/lib/utils/cn';

interface IssueTasksProps {
  issueId: string;
  projectId: string;
}

const CYCLE: TaskStatus[] = ['todo', 'in_progress', 'done'];
function nextStatus(current: TaskStatus): TaskStatus {
  const i = CYCLE.indexOf(current);
  if (i === -1) return 'todo';
  return CYCLE[(i + 1) % CYCLE.length] as TaskStatus;
}

export function IssueTasks({ issueId, projectId }: IssueTasksProps) {
  const { data: tasks = [], isLoading } = useIssueTasks(issueId);
  const { data: members = [] } = useProjectMembers(projectId);
  const createTask = useCreateTask(issueId, projectId);
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask(issueId);
  const reorderTasks = useReorderTasks(issueId);

  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const mutationPending =
    createTask.isPending ||
    updateTask.isPending ||
    deleteTask.isPending ||
    reorderTasks.isPending;

  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  function handleSubmitDraft() {
    const title = draft.trim();
    if (!title || createTask.isPending) return;
    createTask.mutate(
      { title, status: 'todo' },
      { onSuccess: () => setDraft('') },
    );
  }

  function handleDrop(targetId: string) {
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      setOverId(null);
      return;
    }
    const ids = tasks.map((t) => t.id);
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) {
      setDraggedId(null);
      setOverId(null);
      return;
    }
    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, draggedId);
    setDraggedId(null);
    setOverId(null);
    if (next.some((id, i) => id !== ids[i])) {
      reorderTasks.mutate(next);
    }
  }

  return (
    <div className="space-y-3 p-4">
      {total > 0 && (
        <div className="flex items-center gap-3">
          <div className="h-1 flex-1 overflow-hidden bg-surface-container-low">
            <div
              className="h-full bg-success transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-[10px] font-mono uppercase tracking-widest text-on-surface-variant">
            {done}/{total}
          </span>
        </div>
      )}

      <Input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSubmitDraft();
          }
        }}
        placeholder="Add a subtask…"
        disabled={createTask.isPending}
        aria-label="Add a subtask"
      />

      {createTask.error && (
        <p className="text-[10px] uppercase tracking-widest text-error">
          {formatApiError(createTask.error)}
        </p>
      )}

      {isLoading ? (
        <div className="space-y-1.5">
          <div className="h-8 animate-pulse bg-surface-container-low" />
          <div className="h-8 animate-pulse bg-surface-container-low" />
        </div>
      ) : tasks.length === 0 ? (
        <p className="text-xs text-outline">No subtasks yet. Add the first one above.</p>
      ) : (
        <ul className="space-y-1">
          {tasks.map((task) => (
            <IssueTaskRow
              key={task.id}
              task={task}
              members={members}
              isEditing={editingId === task.id}
              isDragOver={overId === task.id && draggedId !== null && draggedId !== task.id}
              dragDisabled={mutationPending}
              onStartEdit={() => setEditingId(task.id)}
              onCancelEdit={() => setEditingId(null)}
              onSaveTitle={(title) => {
                const trimmed = title.trim();
                if (!trimmed || trimmed === task.title) {
                  setEditingId(null);
                  return;
                }
                updateTask.mutate({ id: task.id, data: { title: trimmed } });
                setEditingId(null);
              }}
              onCycleStatus={() =>
                updateTask.mutate({ id: task.id, data: { status: nextStatus(task.status) } })
              }
              onChangeAssignee={(assigneeId) =>
                updateTask.mutate({ id: task.id, data: { assigneeId } })
              }
              onDelete={() => {
                if (typeof window !== 'undefined' && !window.confirm('Delete this subtask?'))
                  return;
                deleteTask.mutate(task.id);
              }}
              onDragStart={() => setDraggedId(task.id)}
              onDragOver={() => {
                if (overId !== task.id) setOverId(task.id);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setOverId(null);
              }}
              onDrop={() => handleDrop(task.id)}
            />
          ))}
        </ul>
      )}

      {(updateTask.error || deleteTask.error || reorderTasks.error) && (
        <p className="text-[10px] uppercase tracking-widest text-error">
          {formatApiError(updateTask.error ?? deleteTask.error ?? reorderTasks.error)}
        </p>
      )}
    </div>
  );
}

interface IssueTaskRowProps {
  task: Task;
  members: ProjectMemberRow[];
  isEditing: boolean;
  isDragOver: boolean;
  dragDisabled: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveTitle: (next: string) => void;
  onCycleStatus: () => void;
  onChangeAssignee: (assigneeId: string | null) => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}

function IssueTaskRow({
  task,
  members,
  isEditing,
  isDragOver,
  dragDisabled,
  onStartEdit,
  onCancelEdit,
  onSaveTitle,
  onCycleStatus,
  onChangeAssignee,
  onDelete,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: IssueTaskRowProps) {
  const statusClass = TASK_STATUS_COLORS[task.status] ?? TASK_STATUS_COLORS.todo;

  function handleEditKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSaveTitle(e.currentTarget.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancelEdit();
    }
  }

  return (
    <li
      draggable={!dragDisabled}
      onDragStart={(e) => {
        if (dragDisabled) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDragEnd={onDragEnd}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className={cn(
        'group flex items-center gap-2 rounded-sm px-1 py-1',
        isDragOver && 'border-t border-primary',
      )}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        className="cursor-grab text-outline-variant hover:text-on-surface-variant"
        tabIndex={-1}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={onCycleStatus}
        className={cn(
          'rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest transition-colors',
          statusClass,
        )}
        aria-label={`Status: ${task.status}. Click to change.`}
      >
        {task.status.replace('_', ' ')}
      </button>

      <div className="min-w-0 flex-1">
        {isEditing ? (
          <Input
            type="text"
            defaultValue={task.title}
            autoFocus
            onBlur={(e) => onSaveTitle(e.currentTarget.value)}
            onKeyDown={handleEditKey}
            className="text-sm"
            aria-label="Edit subtask title"
          />
        ) : (
          <button
            type="button"
            onClick={onStartEdit}
            className={cn(
              'block w-full truncate text-left text-sm',
              task.status === 'done'
                ? 'text-outline-variant line-through'
                : 'text-on-surface',
            )}
          >
            {task.title}
          </button>
        )}
      </div>

      <AssigneePicker
        compact
        value={task.assigneeId}
        members={members}
        onChange={onChangeAssignee}
      />

      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete subtask"
        className="rounded-sm p-1 text-outline-variant opacity-0 transition-colors hover:bg-surface-container-high hover:text-error group-hover:opacity-100 focus:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
