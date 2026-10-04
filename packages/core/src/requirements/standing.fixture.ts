import { issueStatusToneOn, type KernelIssueStatus } from '@forge/contracts/issue-vocabulary';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { StandingInput, StandingIssue, StandingRevision } from './standing.js';

export const NOW = new Date('2026-10-03T12:00:00Z');
export const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
export const LAN = { userId: 'lan', canSignOff: true };
export const VIEWER_ONLY = { userId: 'tuan', canSignOff: false };

export const rev = (
  revision: number,
  state: StandingRevision['state'],
  extra: Partial<StandingRevision> = {},
): StandingRevision => ({
  revision,
  state,
  authorId: 'minh',
  authorName: 'Minh',
  authorKind: 'human',
  createdAt: daysAgo(2),
  proposedAt: null,
  decidedAt: null,
  ...extra,
});

export const issue = (
  id: string,
  status: string,
  extra: Partial<StandingIssue> = {},
): StandingIssue => ({
  id,
  displayId: formatIssueRef(null, Number(id)),
  title: `Issue ${id}`,
  status,
  tone: issueStatusToneOn(status as KernelIssueStatus, false),
  updatedAt: daysAgo(1),
  changedSincePlan: false,
  ...extra,
});

export const BC1 = {
  id: 'bc1-r1',
  code: 'BC-1',
  body: 'Remind at D+1',
  sinceRevision: 1,
  retiredRevision: null,
};
export const BC2_OLD = {
  id: 'bc2-r1',
  code: 'BC-2',
  body: 'Old wording',
  sinceRevision: 1,
  retiredRevision: 2,
};
export const BC2 = {
  id: 'bc2-r2',
  code: 'BC-2',
  body: 'New wording',
  sinceRevision: 2,
  retiredRevision: null,
};
export const BC3 = {
  id: 'bc3-r1',
  code: 'BC-3',
  body: 'Weekly report',
  sinceRevision: 1,
  retiredRevision: null,
};

export const base = (over: Partial<StandingInput> = {}): StandingInput => ({
  status: 'agreed',
  phase: 'in_delivery',
  owner: { id: 'lan', name: 'Lan', kind: 'human' },
  viewer: LAN,
  revisions: [rev(2, 'current', { decidedAt: daysAgo(3) }), rev(1, 'superseded')],
  currentRevision: 2,
  criteria: [BC1, BC2_OLD, BC2, BC3],
  issues: [issue('1', 'in_progress'), issue('2', 'closed')],
  issueCriteria: [],
  openSuggestionKinds: [],
  stalePins: [],
  feedback: { open: 0, untriaged: [] },
  updatedAt: daysAgo(3),
  now: NOW,
  ...over,
});
