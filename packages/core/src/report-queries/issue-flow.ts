// issue-flow: the project's work per day or per week, oldest first: issues filed, verified (merged
// and proven), closed (released) and sent back in each, and how many were still open at its end.
// What a line chart of issues closed per week, or created against closed per day, is drawn from
// (REQ-32 BC-3). Built over `issues/flow-history.ts:readIssueFlow`; the fold is `flow-fold.ts`.

import {
  defineReportQuery,
  type ReportCell,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import { z } from 'zod';
import { type IssueFlow, readIssueFlow } from '../issues/index.js';
import { bucketBoundaries } from '../lib/time-buckets.js';
import { checkedFrame, defineAdapter } from './adapter.js';
import {
  dayOf,
  FLOW_EVENTS,
  filedIn,
  isOpenStatus,
  movesByIssue,
  movesInto,
  statusAt,
} from './flow-fold.js';

export const ISSUE_FLOW_BUCKETS = ['day', 'week'] as const;
export const ISSUE_FLOW_PERIODS_MAX = 90;

const params = z.object({
  /** One row per UTC day, or per UTC week starting Monday. */
  bucket: z.enum(ISSUE_FLOW_BUCKETS).default('week'),
  /** How many days or weeks, the newest being the one under way. */
  periods: z.number().int().min(1).max(ISSUE_FLOW_PERIODS_MAX).default(8),
});

const descriptor = defineReportQuery({
  id: 'issue-flow',
  version: 1,
  title: 'Issues filed, verified, closed, sent back per day or week',
  params,
  output: [
    { name: 'start', type: 'date', label: 'Starting' },
    { name: 'created', type: 'number', unit: 'issues', label: 'Filed' },
    { name: 'verified', type: 'number', unit: 'issues', label: 'Verified' },
    { name: 'closed', type: 'number', unit: 'issues', label: 'Closed' },
    { name: 'sentBack', type: 'number', unit: 'issues', label: 'Sent back' },
    { name: 'open', type: 'number', unit: 'issues', label: 'Open at its end' },
  ],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest', 'chat', 'cli'],
});

/** One row per bucket, oldest first; the newest bucket ends at `now`. */
export function issueFlowFrame(
  flow: IssueFlow,
  bucket: (typeof ISSUE_FLOW_BUCKETS)[number],
  periods: number,
  now: Date,
): ReportFrame {
  const starts = bucketBoundaries(bucket, periods, now).map((s) => new Date(s));
  const byIssue = movesByIssue(flow);
  const rows: Record<string, ReportCell>[] = starts.map((from, i) => {
    const until = starts[i + 1] ?? now;
    const w = { from, until };
    const end = new Date(until.getTime() - 1);
    return {
      start: dayOf(from),
      created: filedIn(flow, w).length,
      verified: movesInto(flow, FLOW_EVENTS.verified, w).length,
      closed: movesInto(flow, FLOW_EVENTS.closed, w).length,
      sentBack: movesInto(flow, FLOW_EVENTS.sentBack, w).length,
      open: flow.issues.filter((issue) => {
        const s = statusAt(issue, byIssue.get(issue.id) ?? [], end);
        return s !== null && isOpenStatus(s);
      }).length,
    };
  });
  return checkedFrame(descriptor.id, { fields: [...descriptor.output], rows });
}

export const issueFlow = defineAdapter({
  descriptor,
  reads: ['issues:readIssueFlow'],
  async run({ projectId, now }, p) {
    const at = now ?? new Date();
    return issueFlowFrame(await readIssueFlow(projectId, at), p.bucket, p.periods, at);
  },
});
