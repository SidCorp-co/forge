// burndown: day by day, how many issues of a scope were still to do at the day's end, how many were
// done (merged and proven, or released) and how many the scope held: the project's, one
// requirement's, or one release's. What a burndown chart is drawn from (REQ-32 BC-3). A dropped
// issue leaves the scope the day it is dropped. Built over `issues/flow-history.ts:readIssueFlow`,
// the requirement list a requirement key is read through, and the release run a version names.

import {
  defineReportQuery,
  type ReportCell,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import { z } from 'zod';
import { type IssueFlow, readIssueFlow } from '../issues/index.js';
import { bucketBoundaries } from '../lib/time-buckets.js';
import { badRequest } from '../middleware/route-errors.js';
import { runWearingVersion } from '../pipeline/index.js';
import { listRequirementsAs } from '../requirements/index.js';
import { checkedFrame, defineAdapter } from './adapter.js';
import { dayOf, isDroppedStatus, isResolvedStatus, movesByIssue, statusAt } from './flow-fold.js';

export const BURNDOWN_DAYS_MAX = 90;
const REQUIREMENT_KEY = /^REQ-[1-9]\d{0,8}$/;

const params = z.object({
  days: z.number().int().min(1).max(BURNDOWN_DAYS_MAX).default(14),
  /** Only this requirement's issues. */
  requirement: z.string().regex(REQUIREMENT_KEY, 'a requirement key like REQ-12').optional(),
  /** Only the issues of the release wearing this version. */
  release: z.string().min(1).max(64).optional(),
});

const descriptor = defineReportQuery({
  id: 'burndown',
  version: 1,
  title: 'Issues left to do per day: project, requirement or release',
  params,
  output: [
    { name: 'day', type: 'date', label: 'Day' },
    { name: 'remaining', type: 'number', unit: 'issues', label: 'Left to do' },
    { name: 'done', type: 'number', unit: 'issues', label: 'Done' },
    { name: 'scope', type: 'number', unit: 'issues', label: 'In scope' },
  ],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest', 'chat', 'cli'],
});

const refused = (why: string) =>
  badRequest(`report query "burndown": params refused: ${why}`, 'REPORT_PARAMS_REFUSED');

/** One row per UTC day, oldest first, each read at the day's end (the last one at `now`). */
export function burndownFrame(
  flow: IssueFlow,
  scope: ReadonlySet<string> | null,
  days: number,
  now: Date,
): ReportFrame {
  const issues = scope ? flow.issues.filter((i) => scope.has(i.id)) : flow.issues;
  const byIssue = movesByIssue(flow);
  const starts = bucketBoundaries('day', days, now).map((s) => new Date(s));
  const rows: Record<string, ReportCell>[] = starts.map((from, i) => {
    const next = starts[i + 1];
    const end = next ? new Date(next.getTime() - 1) : now;
    let done = 0;
    let held = 0;
    for (const issue of issues) {
      const s = statusAt(issue, byIssue.get(issue.id) ?? [], end);
      if (s === null || isDroppedStatus(s)) continue;
      held += 1;
      if (isResolvedStatus(s)) done += 1;
    }
    return { day: dayOf(from), remaining: held - done, done, scope: held };
  });
  return checkedFrame(descriptor.id, { fields: [...descriptor.output], rows });
}

/** The release run's roster: the issues it carried, and those it closed afterwards. */
function rosterOf(metadata: Record<string, unknown>): string[] {
  const listed = (key: string) => {
    const v = metadata[key];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  return [...listed('issueIds'), ...listed('rosterClosed')];
}

export const burndown = defineAdapter({
  descriptor,
  reads: [
    'issues:readIssueFlow',
    'requirements:listRequirementsAs',
    'pipeline/release-runs.ts:runWearingVersion',
  ],
  async run({ projectId, viewer, now }, p) {
    const at = now ?? new Date();
    if (p.requirement !== undefined && p.release !== undefined) {
      throw refused(
        `requirement ${p.requirement} and release ${p.release} were both given; a burndown is of one scope, so name one, or neither for the whole project`,
      );
    }
    let scope: Set<string> | null = null;
    const flow = await readIssueFlow(projectId, at);
    if (p.requirement !== undefined) {
      const list = await listRequirementsAs(viewer, projectId);
      const found = list.find((r) => r.key === p.requirement);
      if (!found) {
        throw refused(
          `project ${projectId} holds no requirement ${p.requirement}; name a key like REQ-12 of this project`,
        );
      }
      scope = new Set(flow.issues.filter((i) => i.requirementId === found.id).map((i) => i.id));
    } else if (p.release !== undefined) {
      const run = await runWearingVersion(projectId, p.release);
      if (!run) {
        throw refused(
          `no release of project ${projectId} wears version ${p.release}; name a version a release was cut as`,
        );
      }
      scope = new Set(rosterOf(run.metadata));
    }
    return burndownFrame(flow, scope, p.days, at);
  },
});
