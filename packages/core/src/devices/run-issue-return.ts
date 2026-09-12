/**
 * Giving a run's issues back when the run ended by failing.
 *
 * The lease needs nothing here — it is derived from a live run session naming
 * the issue, so it lapses the moment the session goes terminal. What does NOT
 * lapse is the issue's STATUS: an agent moves it to `in_progress` on its way
 * in, and a run that dies there leaves it reading as work somebody is doing.
 * Measured on sidpeak 2026-09-12: ISS-457 stood at `in_progress` for 18 hours
 * with no process behind it, and ISS-410 queued behind it the whole time.
 *
 * So a failed run returns each issue to the status it held when the run
 * opened, which is by construction a status that project admits — it is the
 * one the master claimed it out of.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { RUN_ISSUE_STATUSES_METADATA_KEY, RUN_ISSUES_METADATA_KEY } from './run-session.js';

/**
 * Statuses a person parks an issue at, which outrank an automatic restore.
 */
// cm:guard a park reached DURING the run is a human decision taken after the run started, so it is newer than the status this module remembers and must win. Without this a run dying over a question somebody just asked would pull the issue straight back into the claimable set and the next master would dispatch it, answering nothing — the same shape `recovery::reconcile` grants a park before it reads either orphan premise.
export const HUMAN_PARK_STATUSES: readonly IssueStatus[] = ['needs_info', 'waiting', 'on_hold'];

export interface ReturnedIssue {
  issueKey: string;
  from: IssueStatus;
  to: IssueStatus;
}

interface RunRow {
  projectId: string;
  projectCreatedBy: string | null;
  keys: string[];
  statuses: Record<string, string>;
}

async function readRun(runId: string): Promise<RunRow | null> {
  const rows = (await db.execute(sql`
    SELECT r.project_id,
           p.created_by,
           COALESCE(r.metadata -> ${RUN_ISSUES_METADATA_KEY}, '[]'::jsonb) AS keys,
           COALESCE(r.metadata -> ${RUN_ISSUE_STATUSES_METADATA_KEY}, '{}'::jsonb) AS statuses
      FROM pipeline_runs r
      JOIN projects p ON p.id = r.project_id
     WHERE r.id = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    projectId: String(row.project_id),
    projectCreatedBy: row.created_by == null ? null : String(row.created_by),
    keys: (row.keys ?? []) as string[],
    statuses: (row.statuses ?? {}) as Record<string, string>,
  };
}

/**
 * Return every issue this run still holds to the status it was claimed from.
 *
 * Safe to call twice: an issue already back at its opening status is a no-op.
 */
// cm:guard called ONLY on a failing outcome. A run whose agent finished moved these issues deliberately — `developed`, `tested`, `closed` — and restoring those would undo the work's own record and hand the issue to the next master as unstarted.
// cm:edge protocol -> packages/core/src/devices/run-session-reaper.ts — the reaper is the other caller and the two must stay in step: it had the issue keys in hand and returned nothing, which is the defect this module exists to close.
export async function returnIssuesForRun(
  runId: string,
  opts: { reason: string },
): Promise<ReturnedIssue[]> {
  const run = await readRun(runId);
  if (!run || run.keys.length === 0) return [];

  const seqs = run.keys
    .map((k) => Number.parseInt(k.replace(/^ISS-/, ''), 10))
    .filter((n) => Number.isInteger(n));
  if (seqs.length === 0) return [];

  const rows = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      issSeq: issues.issSeq,
      status: issues.status,
      reopenCount: issues.reopenCount,
    })
    .from(issues)
    .where(and(eq(issues.projectId, run.projectId), inArray(issues.issSeq, seqs)));

  // cm:guard a synthesized DEVICE actor, never the project owner: this hop is a machine noticing a dead run, and recording it as the owner puts a transition nobody made into the interventions-per-issue metric. Same fallback shape as `releasing-recovery.ts` and for the same reason.
  const fallbackId = run.projectCreatedBy ?? run.projectId;
  const actor: TransitionActor = { type: 'device', id: fallbackId, ownerId: fallbackId };

  const returned: ReturnedIssue[] = [];
  for (const issue of rows) {
    const key = `ISS-${issue.issSeq}`;
    const target = run.statuses[key] as IssueStatus | undefined;
    if (!target) continue;
    if (issue.status === target) continue;
    if (HUMAN_PARK_STATUSES.includes(issue.status as IssueStatus)) {
      logger.info(
        { runId, issueKey: key, status: issue.status },
        'run-issue-return: left a human park alone',
      );
      continue;
    }
    try {
      await transitionIssueStatus(
        {
          id: issue.id,
          projectId: issue.projectId,
          status: issue.status as IssueStatus,
          reopenCount: issue.reopenCount,
        },
        target,
        actor,
        { transitionReason: opts.reason, skip: true },
      );
      returned.push({ issueKey: key, from: issue.status as IssueStatus, to: target });
    } catch (err) {
      if (err instanceof TransitionError && err.code === 'NO_OP') continue;
      logger.warn(
        { err, runId, issueKey: key, from: issue.status, to: target },
        'run-issue-return: could not return an issue its run had stopped working',
      );
    }
  }

  if (returned.length > 0) {
    logger.warn({ runId, returned, reason: opts.reason }, 'run-issue-return: issues given back');
  }
  return returned;
}
