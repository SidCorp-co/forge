import { type IssueStatus, issueStatuses } from '../db/schema.js';

export type { IssueStatus };
export { issueStatuses };

export const DRAFT_EXIT_TARGETS: readonly IssueStatus[] = [
  'open',
  'closed',
  'dropped',
  'developed',
  'in_progress',
];

export const transitions: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ['confirmed', 'in_progress', 'needs_info', 'on_hold', 'dropped'],
  confirmed: ['approved', 'in_progress', 'needs_info', 'on_hold', 'dropped'],
  approved: ['in_progress', 'needs_info', 'on_hold', 'dropped'],
  in_progress: ['developed', 'closed', 'needs_info', 'on_hold', 'dropped'],
  developed: ['testing', 'reopen', 'needs_info', 'on_hold', 'dropped'],
  testing: ['awaiting_release', 'closed', 'reopen', 'needs_info', 'on_hold', 'dropped'],
  awaiting_release: ['releasing', 'needs_info', 'on_hold', 'dropped'],
  releasing: ['closed', 'reopen', 'needs_info', 'on_hold'],
  closed: ['reopen'],
  reopen: ['in_progress', 'developed', 'needs_info', 'on_hold', 'dropped'],

  needs_info: [
    'open',
    'confirmed',
    'approved',
    'in_progress',
    'developed',
    'testing',
    'awaiting_release',
    'on_hold',
    'dropped',
  ],
  on_hold: [
    'open',
    'confirmed',
    'approved',
    'in_progress',
    'developed',
    'testing',
    'awaiting_release',
    'needs_info',
    'dropped',
  ],

  draft: [...DRAFT_EXIT_TARGETS],
  dropped: [],

  clarified: ['in_progress', 'needs_info', 'on_hold', 'dropped'],
  waiting: ['open', 'in_progress', 'needs_info', 'on_hold', 'dropped'],
  tested: ['awaiting_release', 'closed', 'reopen', 'needs_info', 'on_hold', 'dropped'],
};

export function getAllowedTransitions(from: IssueStatus): readonly IssueStatus[] {
  return transitions[from];
}

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return transitions[from].includes(to);
}

/**
 * Statuses that may never be a transition TARGET at runtime. `draft` is an
 * AI-proposal ingress state (issues are created as draft, then promoted to
 * open/closed) — nothing in the live lifecycle transitions INTO draft.
 */
export const NON_TARGETABLE_STATUSES: ReadonlySet<IssueStatus> = new Set(['draft']);

export function canTransitionFree(from: IssueStatus, to: IssueStatus): boolean {
  if (NON_TARGETABLE_STATUSES.has(to)) return false;
  if (from === 'draft') return DRAFT_EXIT_TARGETS.includes(to);
  return true;
}

export function isReopenEntry(from: IssueStatus, to: IssueStatus): boolean {
  return to === 'reopen' && from !== 'reopen' && from !== 'in_progress';
}

export type StagesConfig = Partial<
  Record<
    IssueStatus,
    {
      enabled?: boolean;
      deviceIds?: string[];
      [extra: string]: unknown;
    }
  >
>;
