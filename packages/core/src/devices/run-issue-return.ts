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

/**
 * The only statuses a dead run's issue is taken back from.
 */
// cm:guard an ALLOWLIST, never "any status that differs from the opening one". These three assert an action is happening RIGHT NOW, and a dead run makes that assertion false, so retracting it is the whole job. Every other status asserts a fact the run already achieved — a pushed branch at `developed`, a verdict at `tested`, a hand-earned `awaiting_release` — and those stay true whether or not the pane survived. Returning from them would walk an issue back over landed work and hand it to the next master to do again, on top of a branch that is already there.
export const RETURNABLE_FROM: readonly IssueStatus[] = ['in_progress', 'testing', 'releasing'];

export interface ReturnedIssue {
  issueKey: string;
  from: IssueStatus;
  to: IssueStatus;
}

interface RunRow {
  projectId: string;
  projectCreatedBy: string | null;
  startedAt: Date;
  keys: string[];
  statuses: Record<string, string>;
}

async function readRun(runId: string): Promise<RunRow | null> {
  const rows = (await db.execute(sql`
    SELECT r.project_id,
           p.created_by,
           r.started_at,
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
    startedAt: new Date(String(row.started_at)),
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
      mergedAt: issues.mergedAt,
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
    if (issue.status === target) {
      // cm:guard this branch carries TWO facts and used to report neither: "the run moved nothing, all well", and "this run opened over a rung that already asserted work nobody was doing, so the floor is the defect and no return can reach it". The second is ISS-457's shape standing on a rung `RETURNABLE_FROM` names — reachable because `testing` is backlog-admissible (`REGISTRY_BACKLOG_ADMISSIBLE_STATUSES`), so a master may legitimately open a run over it and re-record it as the floor every time. Counting it is what makes the rate knowable; healing it is NOT this module's to do, because the floor is by construction the status the master claimed from.
      if (RETURNABLE_FROM.includes(issue.status as IssueStatus)) {
        logger.warn(
          { runId, issueKey: key, status: issue.status },
          'run-issue-return: the run opened over an in-flight status, so the floor is the stuck rung and no return can move it',
        );
      }
      continue;
    }
    // cm:guard the allowlist is read BEFORE the park check and subsumes it — no park is in flight — so the park check survives as a named rule rather than as the thing doing the work, kept true by the test that the two sets never intersect.
    // cm:guard a merge stamped DURING this run outranks the rung the issue is standing on, and the comparison against `started_at` is the whole rule: `mergedAt` is never cleared on reopen (`apply-transition.ts` increments `reopenCount` and touches nothing else), so a bare `mergedAt !== null` test would refuse to return every reopened issue and strand it at `in_progress` — the exact hole this module was written to close. Measured on sid-desk 2026-09-13: seven issues died at `testing` with the merge already stamped, because that project merges to staging BEFORE the issue leaves `testing`; returning them would have sent five to `open` and two to `draft`, which is outside the pool entirely, over code that was already on master.
    if (issue.mergedAt !== null && issue.mergedAt >= run.startedAt) {
      logger.info(
        { runId, issueKey: key, status: issue.status, mergedAt: issue.mergedAt },
        'run-issue-return: left an issue whose run had already landed its code',
      );
      continue;
    }
    if (!RETURNABLE_FROM.includes(issue.status as IssueStatus)) {
      logger.info(
        { runId, issueKey: key, status: issue.status },
        'run-issue-return: left a status the run had already reached',
      );
      continue;
    }
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
