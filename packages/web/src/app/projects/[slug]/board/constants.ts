import type { IssueStatus } from '@/features/issue/types';
import type { TaskStatus } from '@/features/task/types';

export const ALL_ISSUE_COLS: { status: IssueStatus; label: string; color: string; bg: string }[] = [
  { status: 'open', label: 'Open', color: 'border-outline-variant', bg: 'bg-surface-container-low' },
  { status: 'confirmed', label: 'Confirmed', color: 'border-info', bg: 'bg-info-surface/20' },
  { status: 'clarified', label: 'Clarified', color: 'border-info', bg: 'bg-info-surface/20' },
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
  // ISS-236 — drafts are AI-generated proposals; they appear as a board
  // column but are hidden by default (see DEFAULT_VISIBLE below).
  { status: 'draft', label: 'Draft', color: 'border-outline-variant', bg: 'bg-surface-container-low' },
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
  clarified: false,
  waiting: false,
  approved: true,
  in_progress: true,
  developed: true,
  deploying: false,
  testing: true,
  tested: false,
  pass: false,
  staging: false,
  released: true,
  closed: false,
  reopen: false,
  on_hold: false,
  needs_info: false,
  // ISS-236 — drafts default-hidden; the user opens the column from the
  // board toolbar's column-picker when they want to triage proposals.
  draft: false,
};

export const BOARD_VIEW_OPTIONS: { value: 'issues' | 'tasks'; label: string }[] = [
  { value: 'issues', label: 'Issues' },
  { value: 'tasks', label: 'Tasks' },
];

export const DRAGGABLE_CARD_CLASS =
  'cursor-grab rounded-lg border bg-surface-container-low p-3 shadow-sm transition-all hover:shadow-md active:cursor-grabbing';

export type BoardDensity = 'compact' | 'comfortable';
export type BoardGroupBy = 'none' | 'assignee' | 'parent' | 'category';

export const BOARD_DENSITY_KEY = 'forge.web.boardDensity';
export const boardGroupByKey = (projectId: string) => `forge.web.boardGroupBy.${projectId}`;
export const boardCollapsedKey = (projectId: string) => `forge.web.boardCollapsed.${projectId}`;
export const boardVisibleColsKey = (projectId: string) => `forge.web.boardVisibleCols.${projectId}`;

export const BOARD_DENSITY_OPTIONS: { value: BoardDensity; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
];

export const BOARD_GROUP_BY_OPTIONS: { value: BoardGroupBy; label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'parent', label: 'Parent' },
  { value: 'category', label: 'Category' },
];
