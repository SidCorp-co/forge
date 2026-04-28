import type { IssueStatus, IssuePriority } from '@/features/issue/types';
import type { TaskStatus, AgentStatus } from '@/features/task/types';

export const STATUS_COLORS: Record<IssueStatus, { bg: string; text: string }> = {
  draft: { bg: '#f8fafc', text: '#94a3b8' },
  open: { bg: '#f3f4f6', text: '#374151' },
  confirmed: { bg: '#eef2ff', text: '#4338ca' },
  clarified: { bg: '#ecfeff', text: '#0891b2' },
  waiting: { bg: '#fffbeb', text: '#b45309' },
  approved: { bg: '#f0fdf4', text: '#15803d' },
  in_progress: { bg: '#fff7ed', text: '#c2410c' },
  developed: { bg: '#ecfdf5', text: '#047857' },
  deploying: { bg: '#eff6ff', text: '#1d4ed8' },
  testing: { bg: '#f3e8ff', text: '#7c3aed' },
  staging: { bg: '#ecfeff', text: '#0e7490' },
  released: { bg: '#f0fdfa', text: '#0f766e' },
  closed: { bg: '#f9fafb', text: '#6b7280' },
  reopen: { bg: '#fef3c7', text: '#b45309' },
  on_hold: { bg: '#fef9c3', text: '#a16207' },
  needs_info: { bg: '#fce7f3', text: '#be185d' },
};

export const PRIORITY_COLORS: Record<IssuePriority, { bg: string; text: string }> = {
  critical: { bg: '#fee2e2', text: '#b91c1c' },
  high: { bg: '#ffedd5', text: '#c2410c' },
  medium: { bg: '#fef9c3', text: '#a16207' },
  low: { bg: '#f3f4f6', text: '#4b5563' },
  none: { bg: '#f9fafb', text: '#9ca3af' },
};

export const TASK_STATUS_COLORS: Record<TaskStatus, { bg: string; text: string }> = {
  done: { bg: '#dcfce7', text: '#15803d' },
  in_review: { bg: '#f3e8ff', text: '#7c3aed' },
  in_progress: { bg: '#fef9c3', text: '#a16207' },
  todo: { bg: '#dbeafe', text: '#1d4ed8' },
  backlog: { bg: '#f3f4f6', text: '#4b5563' },
};

export const AGENT_STATUS_COLORS: Record<AgentStatus, { bg: string; text: string }> = {
  idle: { bg: '#f3f4f6', text: '#4b5563' },
  running: { bg: '#dbeafe', text: '#1d4ed8' },
  completed: { bg: '#dcfce7', text: '#15803d' },
  failed: { bg: '#fee2e2', text: '#b91c1c' },
};

export const ALL_STATUSES: { value: IssueStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'open', label: 'Open' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'clarified', label: 'Clarified' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'approved', label: 'Approved' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'developed', label: 'Developed' },
  { value: 'deploying', label: 'Deploying' },
  { value: 'testing', label: 'Testing' },
  { value: 'staging', label: 'Staging' },
  { value: 'released', label: 'Released' },
  { value: 'closed', label: 'Closed' },
  { value: 'reopen', label: 'Reopen' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'needs_info', label: 'Needs Info' },
];

export const ALL_PRIORITIES: { value: IssuePriority; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'none', label: 'None' },
];