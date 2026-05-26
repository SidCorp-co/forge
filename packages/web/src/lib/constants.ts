import type { IssueStatus, IssuePriority, IssueComplexity } from '@/features/issue/types';

export const STATUS_COLORS: Record<IssueStatus, string> = {
  // — Pipeline flow —
  open: 'bg-blue-500/15 text-blue-400',
  confirmed: 'bg-indigo-500/15 text-indigo-400',
  waiting: 'bg-amber-500/15 text-amber-400',
  approved: 'bg-cyan-500/15 text-cyan-400',
  in_progress: 'bg-yellow-500/15 text-yellow-300',
  developed: 'bg-teal-500/15 text-teal-400',
  deploying: 'bg-orange-500/15 text-orange-400',
  testing: 'bg-purple-500/15 text-purple-400',
  tested: 'bg-emerald-500/15 text-emerald-400',
  pass: 'bg-green-500/30 text-green-200 font-medium',
  staging: 'bg-lime-500/15 text-lime-400',
  released: 'bg-green-500/20 text-green-400 font-medium',
  closed: 'bg-zinc-600/30 text-zinc-500',
  // — Side states —
  reopen: 'bg-red-500/15 text-red-400',
  on_hold: 'bg-stone-500/20 text-stone-400',
  needs_info: 'bg-pink-500/15 text-pink-400',
  // ISS-236 — dashed muted border conveys "proposal, not yet accepted".
  draft:
    'border border-dashed border-on-surface-variant/40 bg-transparent text-on-surface-variant',
};

export const PRIORITY_COLORS: Record<IssuePriority, string> = {
  critical: 'bg-error-container/20 text-error',
  high: 'bg-on-surface/15 text-on-surface',
  medium: 'bg-outline-variant/40 text-on-surface-variant',
  low: 'bg-surface-variant text-outline',
  none: 'bg-surface-container-low text-primary-fixed',
};

// ISS-42 C2 — t-shirt sizes mirror the core Drizzle enum.
export const COMPLEXITY_COLORS: Record<IssueComplexity, string> = {
  xs: 'bg-emerald-500/15 text-emerald-400',
  s: 'bg-green-500/15 text-green-400',
  m: 'bg-amber-500/15 text-amber-400',
  l: 'bg-orange-500/15 text-orange-400',
  xl: 'bg-rose-500/15 text-rose-400',
};

export const ALL_COMPLEXITIES: { value: IssueComplexity; label: string }[] = [
  { value: 'xs', label: 'XS' },
  { value: 's', label: 'S' },
  { value: 'm', label: 'M' },
  { value: 'l', label: 'L' },
  { value: 'xl', label: 'XL' },
];

export const ALL_STATUSES: { value: IssueStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'approved', label: 'Approved' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'developed', label: 'Developed' },
  { value: 'deploying', label: 'Deploying' },
  { value: 'testing', label: 'Testing' },
  { value: 'tested', label: 'Tested' },
  { value: 'pass', label: 'Pass' },
  { value: 'staging', label: 'Staging' },
  { value: 'released', label: 'Released' },
  { value: 'closed', label: 'Closed' },
  { value: 'reopen', label: 'Reopen' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'needs_info', label: 'Needs Info' },
  { value: 'draft', label: 'Draft' },
];

export const ALL_PRIORITIES: { value: IssuePriority; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'none', label: 'None' },
];

export const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export const ALL_CATEGORIES: { value: string; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature' },
  { value: 'improvement', label: 'Improvement' },
  { value: 'task', label: 'Task' },
  { value: 'epic', label: 'Epic' },
];

export const CLOSED_STATUSES: IssueStatus[] = ['released', 'closed'];

export const TASK_STATUS_COLORS: Record<string, string> = {
  done: 'bg-on-surface/20 text-on-surface',
  in_review: 'bg-surface-variant text-secondary-text',
  in_progress: 'bg-on-surface/10 text-on-surface',
  todo: 'bg-surface-variant text-on-surface-variant',
  backlog: 'bg-surface-container-low text-primary-fixed',
};

// Slate reserved for idle/cancelled — never reuse for active states or
// "queued" reads as "dormant" to users.
export const AGENT_STATUS_COLORS: Record<string, string> = {
  idle: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  queued:
    'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300',
  stalled:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  completed:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
};
