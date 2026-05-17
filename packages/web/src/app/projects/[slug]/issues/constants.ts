import type { IssueStatus } from '@/features/issue/types';

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS: number[] = [10, 25, 50];

export function issuesPageSizeKey(slug: string | undefined): string | null {
  return slug ? `forge:web:issuesPageSize:${slug}` : null;
}

export type ViewMode = 'table' | 'board';
export type SortOption = 'newest' | 'oldest' | 'priority' | 'updated';

export type GroupBy = 'none' | 'status' | 'assignee' | 'priority' | 'parent';

export const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'status', label: 'Group by status' },
  { value: 'assignee', label: 'Group by assignee' },
  { value: 'priority', label: 'Group by priority' },
  { value: 'parent', label: 'Group by parent' },
];

export type Density = 'compact' | 'comfortable';

export interface SavedView {
  name: string;
  query: string;
}

export const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'table', label: 'Table' },
  { value: 'board', label: 'Board' },
];

export const BOARD_COLUMNS: {
  key: string;
  label: string;
  statuses: IssueStatus[];
  color: string;
  bg: string;
}[] = [
  { key: 'open', label: 'Open', statuses: ['open', 'reopen', 'needs_info'], color: 'border-outline', bg: 'bg-surface' },
  { key: 'triage', label: 'Triage', statuses: ['confirmed', 'approved'], color: 'border-on-surface-variant', bg: 'bg-surface' },
  { key: 'in_progress', label: 'In Progress', statuses: ['in_progress', 'on_hold'], color: 'border-primary', bg: 'bg-surface' },
  { key: 'deploying', label: 'Deploying', statuses: ['deploying', 'testing', 'staging'], color: 'border-secondary-dim', bg: 'bg-surface' },
  { key: 'done', label: 'Done', statuses: ['released', 'closed'], color: 'border-outline-variant', bg: 'bg-surface' },
];
