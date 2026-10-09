// The progress template's three period queries (REQ-32 BC-15): over the last `days` against the
// `days` before them, what the work did, not what a Requirements page lists. `period-flow` is one
// row of the period's counts and their change: work closed, filed and verified, sent back, and how
// much of the closed work is linked to a requirement and proven against its criteria.
// `status-time` is the hours the issues spent in each status, both periods. `closed-by-requirement`
// is the closed work per requirement it serves. All three are built over
// `issues/flow-history.ts:readIssueFlow` and the requirement list's coverage, the proof the
// Requirements screen reads.

import {
  defineReportQuery,
  type ReportCell,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import type { RequirementSummary } from '@forge/contracts/requirements';
import { z } from 'zod';
import { type IssueFlow, readIssueFlow } from '../issues/index.js';
import { listRequirementsAs } from '../requirements/index.js';
import { checkedFrame, defineAdapter } from './adapter.js';
import {
  dayOf,
  FLOW_EVENTS,
  filedIn,
  hoursOf,
  movesInto,
  periodPair,
  timeInStatus,
  type Window,
} from './flow-fold.js';

export const PERIOD_DAYS_MAX = 90;
export const PERIOD_DAYS_DEFAULT = 14;

const params = z.object({
  /** The period's length in days, ending now; the previous period is as long and ends where it starts. */
  days: z.number().int().min(1).max(PERIOD_DAYS_MAX).default(PERIOD_DAYS_DEFAULT),
});

const READS = ['issues:readIssueFlow', 'requirements:listRequirementsAs'];

type Coverage = Pick<RequirementSummary, 'id' | 'key' | 'title' | 'standing'>;

/**
 * Whether each issue key is proven against its requirement's criteria: it traces at least one
 * business criterion, and every criterion it traces reads passing.
 */
export function provenKeys(list: readonly Coverage[]): Set<string> {
  const verdicts = new Map<string, string[]>();
  for (const r of list) {
    for (const c of r.standing.coverage) {
      for (const i of c.issues) {
        verdicts.set(i.displayId, [...(verdicts.get(i.displayId) ?? []), c.verdict]);
      }
    }
  }
  return new Set(
    [...verdicts]
      .filter(([, v]) => v.length > 0 && v.every((x) => x === 'passing'))
      .map(([k]) => k),
  );
}

/** The issues closed inside the window, each once however often it was closed there. */
function closedIn(flow: IssueFlow, w: Window) {
  const ids = new Set(movesInto(flow, FLOW_EVENTS.closed, w).map((m) => m.issueId));
  return flow.issues.filter((i) => ids.has(i.id));
}

interface PeriodCounts {
  closed: number;
  created: number;
  verified: number;
  sentBack: number;
  closedLinked: number;
  closedProven: number;
}

function countsIn(flow: IssueFlow, proven: ReadonlySet<string>, w: Window): PeriodCounts {
  const closed = closedIn(flow, w);
  return {
    closed: closed.length,
    created: filedIn(flow, w).length,
    verified: movesInto(flow, FLOW_EVENTS.verified, w).length,
    sentBack: movesInto(flow, FLOW_EVENTS.sentBack, w).length,
    closedLinked: closed.filter((i) => i.requirementId !== null).length,
    closedProven: closed.filter((i) => proven.has(i.key)).length,
  };
}

const COUNTS = [
  ['closed', 'Closed'],
  ['created', 'Filed'],
  ['verified', 'Verified'],
  ['sentBack', 'Sent back'],
  ['closedLinked', 'Closed, linked to a requirement'],
  ['closedProven', 'Closed, proven against its criteria'],
] as const;

const periodFlowDescriptor = defineReportQuery({
  id: 'period-flow',
  version: 1,
  title: 'Work closed, filed, verified, sent back: a period vs the one before',
  params,
  output: [
    { name: 'periodStart', type: 'date', label: 'Period from' },
    { name: 'previousStart', type: 'date', label: 'Previous period from' },
    ...COUNTS.flatMap(([name, label]) => [
      { name, type: 'number' as const, unit: 'issues', label },
      {
        name: `${name}Previous`,
        type: 'number' as const,
        unit: 'issues',
        label: `${label}, period before`,
      },
      { name: `${name}Change`, type: 'number' as const, unit: 'issues', label: `${label}, change` },
    ]),
  ],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest', 'chat', 'cli'],
});

export function periodFlowFrame(
  flow: IssueFlow,
  list: readonly Coverage[],
  days: number,
  now: Date,
): ReportFrame {
  const { current, previous } = periodPair(days, now);
  const proven = provenKeys(list);
  const now_ = countsIn(flow, proven, current);
  const before = countsIn(flow, proven, previous);
  const row: Record<string, ReportCell> = {
    periodStart: dayOf(current.from),
    previousStart: dayOf(previous.from),
  };
  for (const [name] of COUNTS) {
    row[name] = now_[name];
    row[`${name}Previous`] = before[name];
    row[`${name}Change`] = now_[name] - before[name];
  }
  return checkedFrame(periodFlowDescriptor.id, {
    fields: [...periodFlowDescriptor.output],
    rows: [row],
  });
}

export const periodFlow = defineAdapter({
  descriptor: periodFlowDescriptor,
  reads: READS,
  async run({ projectId, viewer, now }, p) {
    const at = now ?? new Date();
    const [flow, list] = await Promise.all([
      readIssueFlow(projectId, at),
      listRequirementsAs(viewer, projectId),
    ]);
    return periodFlowFrame(flow, list, p.days, at);
  },
});

const statusTimeDescriptor = defineReportQuery({
  id: 'status-time',
  version: 1,
  title: 'Hours in each status: a period vs the one before',
  params,
  output: [
    { name: 'status', type: 'status', label: 'Status' },
    { name: 'hours', type: 'number', unit: 'h', label: 'Hours this period' },
    { name: 'previousHours', type: 'number', unit: 'h', label: 'Hours the period before' },
    { name: 'change', type: 'number', unit: 'h', label: 'Change' },
  ],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest', 'chat', 'cli'],
});

/** One row per status held in either period, most hours this period first. */
export function statusTimeFrame(flow: IssueFlow, days: number, now: Date): ReportFrame {
  const { current, previous } = periodPair(days, now);
  const held = timeInStatus(flow, current);
  const before = timeInStatus(flow, previous);
  const rows = [...new Set([...held.keys(), ...before.keys()])]
    .map((status) => {
      const hours = hoursOf(held.get(status) ?? 0);
      const previousHours = hoursOf(before.get(status) ?? 0);
      return {
        status,
        hours,
        previousHours,
        change: Math.round((hours - previousHours) * 10) / 10,
      };
    })
    .sort((a, b) => b.hours - a.hours || a.status.localeCompare(b.status));
  return checkedFrame(statusTimeDescriptor.id, {
    fields: [...statusTimeDescriptor.output],
    rows,
  });
}

export const statusTime = defineAdapter({
  descriptor: statusTimeDescriptor,
  reads: ['issues:readIssueFlow'],
  async run({ projectId, now }, p) {
    const at = now ?? new Date();
    return statusTimeFrame(await readIssueFlow(projectId, at), p.days, at);
  },
});

const closedByRequirementDescriptor = defineReportQuery({
  id: 'closed-by-requirement',
  version: 1,
  title: 'Work closed per requirement: a period vs the one before',
  params,
  output: [
    { name: 'requirement', type: 'ref', label: 'Requirement' },
    { name: 'title', type: 'string', label: 'Title' },
    { name: 'closed', type: 'number', unit: 'issues', label: 'Closed' },
    { name: 'previousClosed', type: 'number', unit: 'issues', label: 'Closed the period before' },
    { name: 'proven', type: 'number', unit: 'issues', label: 'Proven against its criteria' },
    { name: 'sentBack', type: 'number', unit: 'issues', label: 'Sent back' },
  ],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest', 'chat', 'cli'],
});

/** What the row of closed work serving no requirement is called. */
export const NO_REQUIREMENT = 'No requirement';
/** What the row of closed work serving a requirement the list does not hold (a dropped one) is called. */
export const UNLISTED_REQUIREMENT = 'A requirement not on the list';

/**
 * One row per requirement whose issues closed or were sent back in either period, most closed this
 * period first, then the closed work that serves none.
 */
export function closedByRequirementFrame(
  flow: IssueFlow,
  list: readonly Coverage[],
  days: number,
  now: Date,
): ReportFrame {
  const { current, previous } = periodPair(days, now);
  const proven = provenKeys(list);
  const byId = new Map(list.map((r) => [r.id, r]));
  const issueReq = new Map(flow.issues.map((i) => [i.id, i.requirementId]));
  const rows = new Map<string, Record<string, ReportCell>>();
  const rowOf = (requirementId: string | null) => {
    const r = requirementId ? byId.get(requirementId) : undefined;
    const at = r ? r.id : requirementId ? 'unlisted' : 'none';
    let row = rows.get(at);
    if (!row) {
      row = {
        requirement: r?.key ?? null,
        title: r?.title ?? (requirementId ? UNLISTED_REQUIREMENT : NO_REQUIREMENT),
        closed: 0,
        previousClosed: 0,
        proven: 0,
        sentBack: 0,
      };
      rows.set(at, row);
    }
    return row;
  };
  const bump = (row: Record<string, ReportCell>, key: string) => {
    row[key] = Number(row[key]) + 1;
  };
  for (const i of closedIn(flow, current)) {
    const row = rowOf(i.requirementId);
    bump(row, 'closed');
    if (proven.has(i.key)) bump(row, 'proven');
  }
  for (const i of closedIn(flow, previous)) bump(rowOf(i.requirementId), 'previousClosed');
  for (const m of movesInto(flow, FLOW_EVENTS.sentBack, current)) {
    bump(rowOf(issueReq.get(m.issueId) ?? null), 'sentBack');
  }
  const ordered = [...rows.values()].sort(
    (a, b) =>
      Number(a.requirement === null) - Number(b.requirement === null) ||
      Number(b.closed) - Number(a.closed) ||
      String(a.requirement).localeCompare(String(b.requirement), 'en', { numeric: true }),
  );
  return checkedFrame(closedByRequirementDescriptor.id, {
    fields: [...closedByRequirementDescriptor.output],
    rows: ordered,
  });
}

export const closedByRequirement = defineAdapter({
  descriptor: closedByRequirementDescriptor,
  reads: READS,
  async run({ projectId, viewer, now }, p) {
    const at = now ?? new Date();
    const [flow, list] = await Promise.all([
      readIssueFlow(projectId, at),
      listRequirementsAs(viewer, projectId),
    ]);
    return closedByRequirementFrame(flow, list, p.days, at);
  },
});
