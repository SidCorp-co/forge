// An issue's flow through the machine, as the activity log recorded it: every unarchived issue of a
// project filed by `until`, and every `issue.statusChanged` move on them up to `until`, oldest first.
// The report queries that read work over time (`report-queries/issue-flow.ts`, `burndown.ts`,
// `period-progress.ts`) are built over this one read and SELECT nothing of their own.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog, issues } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { activeIssuePrefix } from './issue-prefix-read.js';

export interface FlowIssue {
  id: string;
  /** Its key as people read it, under the project's prefix. */
  key: string;
  title: string;
  createdAt: Date;
  /** Where it stands now; the status it held before its first move is that move's `from`. */
  status: IssueStatus;
  requirementId: string | null;
}

export interface FlowMove {
  issueId: string;
  /** A status name as the move recorded it, a legacy one included. */
  from: string;
  to: string;
  at: Date;
}

export interface IssueFlow {
  issues: FlowIssue[];
  moves: FlowMove[];
}

export async function readIssueFlow(projectId: string, until: Date): Promise<IssueFlow> {
  const [prefix, rows, moves] = await Promise.all([
    activeIssuePrefix(projectId),
    db
      .select({
        id: issues.id,
        seq: issues.issSeq,
        title: issues.title,
        createdAt: issues.createdAt,
        status: issues.status,
        requirementId: issues.requirementId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.projectId, projectId),
          isNull(issues.archivedAt),
          lte(issues.createdAt, until),
        ),
      ),
    db
      .select({
        id: activityLog.id,
        issueId: activityLog.issueId,
        payload: activityLog.payload,
        at: activityLog.createdAt,
      })
      .from(activityLog)
      .innerJoin(issues, eq(issues.id, activityLog.issueId))
      .where(
        and(
          eq(issues.projectId, projectId),
          isNull(issues.archivedAt),
          eq(activityLog.action, 'issue.statusChanged'),
          lte(activityLog.createdAt, until),
        ),
      )
      .orderBy(asc(activityLog.createdAt)),
  ]);
  return {
    issues: rows.map((r) => ({
      id: r.id,
      key: formatIssueRef(prefix, r.seq),
      title: r.title,
      createdAt: r.createdAt,
      status: r.status as IssueStatus,
      requirementId: r.requirementId,
    })),
    moves: moves.map((m) => {
      const p = (m.payload ?? {}) as { from?: unknown; to?: unknown };
      if (typeof p.from !== 'string' || typeof p.to !== 'string') {
        throw new Error(
          `activity_log ${m.id} is an issue.statusChanged move whose payload ${JSON.stringify(m.payload)} names no from and to status; every move records both`,
        );
      }
      return { issueId: m.issueId, from: p.from, to: p.to, at: m.at };
    }),
  };
}
