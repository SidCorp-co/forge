import type { IssueStatus } from '@/features/issue/types';
import type { TaskStatus } from '@/features/task/types';

export const ALL_ISSUE_COLS: { status: IssueStatus; label: string; color: string; bg: string }[] = [
  { status: 'open', label: 'Open', color: 'border-outline-variant', bg: 'bg-surface-container-low' },
  { status: 'confirmed', label: 'Confirmed', color: 'border-info', bg: 'bg-info-surface/20' },
  { status: 'waiting', label: 'Waiting', color: 'border-warning', bg: 'bg-warning-dim/10' },
  { status: 'approved', label: 'Approved', color: 'border-info', bg: 'bg-info-surface/20' },
  { status: 'in_progress', label: 'In Progress', color: 'border-warning', bg: 'bg-warning-dim/10' },
  { status: 'developed', label: 'Developed', color: 'border-success', bg: 'bg-success-surface' },
  { status: 'deploying', label: 'Deploying', color: 'border-info', bg: 'bg-info-surface/20' },
  { status: 'testing', label: 'Testing', color: 'border-tertiary-container', bg: 'bg-surface-variant' },
  { status: 'tested', label: 'Tested', color: 'border-success', bg: 'bg-success-surface' },
  { status: 'pass', label: 'Pass', color: 'border-success', bg: 'bg-success-surface' },
  { status: 'staging', label: 'Staging', color: 'border-info', bg: 'bg-info-surface/20' },
  { status: 'released', label: 'Released', color: 'border-info', bg: 'bg-info-surface/20' },
  { status: 'closed', label: 'Closed', color: 'border-outline', bg: 'bg-surface-container-low' },
  { status: 'reopen', label: 'Reopen', color: 'border-warning', bg: 'bg-warning-dim/10' },
  { status: 'on_hold', label: 'On Hold', color: 'border-warning', bg: 'bg-warning-dim/10' },
  { status: 'needs_info', label: 'Needs Info', color: 'border-tertiary-container', bg: 'bg-surface-variant' },
];

export const TASK_COLS: { status: TaskStatus; label: string; color: string; bg: string }[] = [
  { status: 'backlog', label: 'Backlog', color: 'border-outline-variant', bg: 'bg-surface-container-low' },
  { status: 'todo', label: 'Todo', color: 'border-info', bg: 'bg-info-surface/20' },
  { status: 'in_progress', label: 'In Progress', color: 'border-warning', bg: 'bg-warning-dim/10' },
  { status: 'in_review', label: 'In Review', color: 'border-tertiary-container', bg: 'bg-surface-variant' },
  { status: 'done', label: 'Done', color: 'border-success', bg: 'bg-success-surface' },
];

export const DEFAULT_VISIBLE: Record<IssueStatus, boolean> = {
  open: true,
  confirmed: true,
  waiting: true,
  approved: true,
  in_progress: true,
  developed: true,
  deploying: true,
  testing: true,
  tested: true,
  pass: true,
  staging: true,
  released: true,
  closed: true,
  reopen: true,
  on_hold: true,
  needs_info: true,
};

export const BOARD_VIEW_OPTIONS: { value: 'issues' | 'tasks'; label: string }[] = [
  { value: 'issues', label: 'Issues' },
  { value: 'tasks', label: 'Tasks' },
];

export const DRAGGABLE_CARD_CLASS =
  'cursor-grab rounded-lg border bg-surface-container-low p-3 shadow-sm transition-all hover:shadow-md active:cursor-grabbing';
