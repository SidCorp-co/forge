/**
 * Giving a run's issues back when its run session ends, whatever the outcome
 * (`agent-sessions/session-transition.ts:transitionSessions` calls it on every end).
 *
 * The lease needs nothing here — it is derived from a live run session naming
 * the issue, so it lapses the moment the session goes terminal. What does NOT
 * lapse is the issue's STATUS: an agent moves it to `in_progress` on its way
 * in, and a run that dies there leaves it reading as work somebody is doing.
 * Measured on sidpeak 2026-09-12: ISS-457 stood at `in_progress` for 18 hours
 * with no process behind it, and ISS-410 queued behind it the whole time.
 *
 * So an ended run returns each issue it left there to the status it held when
 * the run opened. A landing the run recorded does not keep it: recording a merge
 * moves no status, and the run that claims it next moves it to `awaiting_release`. That floor bounds what this module can do, in both directions: it
 * can never put an issue behind the status it was standing on at claim time,
 * and it can never lift one off a status that was already stuck — a master may
 * open a run over an issue already `in_progress`, and the floor is then the defect.
 * That case is counted here and healed where run sessions are admitted. The move is the kernel's
 * recovery edge (a `recovery` edge of `@forge/contracts/issue-machine:ISSUE_MACHINE`), refused while anything holds it.
 */

import {
  RUN_ISSUE_STATUSES_METADATA_KEY,
  RUN_ISSUES_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import { ASSERTS_WORK_IN_PROGRESS, PARK_STATUSES } from '@forge/contracts/issue-machine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  issueStatuses,
  issues,
  terminalAgentSessionStatuses,
} from '../db/schema.js';
import type { TransitionActor } from '../issues/index.js';
import { TransitionError, transitionIssueStatus } from '../issues/index.js';
import { canonicalIssueKey, seqOfCanonicalIssueKey } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';

interface ReturnedIssue {
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
 * Which of this project's issue keys a live run session OTHER than this one is holding.
 */
async function keysHeldByAnotherLiveRun(runId: string, projectId: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT k AS issue_key
      FROM agent_sessions s
      JOIN pipeline_runs r ON r.id = s.pipeline_run_id
      CROSS JOIN LATERAL jsonb_array_elements_text(
             COALESCE(r.metadata -> ${RUN_ISSUES_METADATA_KEY}, '[]'::jsonb)) AS k
     WHERE r.project_id = ${projectId}
       AND r.id <> ${runId}
       AND s.kind = ${RUN_SESSION_KIND}
       AND s.status NOT IN (${sql.join(
         terminalAgentSessionStatuses.map((v) => sql`${v}`),
         sql`, `,
       )})
  `)) as unknown as Array<{ issue_key: string }>;
  return new Set(rows.map((r) => String(r.issue_key)));
}

/**
 * Return every issue this run still holds to the status it was claimed from.
 *
 * Safe to call twice: an issue already back at its opening status is a no-op, and one a LIVE run
 * session other than this one now holds is left where it is.
 */
export async function returnIssuesForRun(
  runId: string,
  opts: { reason: string },
): Promise<ReturnedIssue[]> {
  const run = await readRun(runId);
  if (!run || run.keys.length === 0) return [];

  const seqs = run.keys.map(seqOfCanonicalIssueKey);
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

  const heldElsewhere = await keysHeldByAnotherLiveRun(runId, run.projectId);

  const fallbackId = run.projectCreatedBy ?? run.projectId;
  const actor: TransitionActor = { type: 'device', id: fallbackId, ownerId: fallbackId };

  const returned: ReturnedIssue[] = [];
  for (const issue of rows) {
    const key = canonicalIssueKey(issue.issSeq);
    const named = run.statuses[key];
    if (!named) {
      if (ASSERTS_WORK_IN_PROGRESS.includes(issue.status as IssueStatus)) {
        logger.warn(
          { runId, issueKey: key, status: issue.status },
          'run-issue-return: the run recorded no opening status for this issue, so no recovery edge names where it goes back and it stays',
        );
      }
      continue;
    }
    if (!(issueStatuses as readonly string[]).includes(named)) {
      throw new Error(
        `run-issue-return: run ${runId} stored \`${named}\` as ${key}'s opening status, which is not one of ${issueStatuses.join(', ')}`,
      );
    }
    const target = named as IssueStatus;
    if (heldElsewhere.has(key)) {
      logger.info(
        { runId, issueKey: key, status: issue.status },
        'run-issue-return: left an issue a live run session now holds',
      );
      continue;
    }
    if (issue.status === target) {
      if (ASSERTS_WORK_IN_PROGRESS.includes(issue.status as IssueStatus)) {
        logger.warn(
          { runId, issueKey: key, status: issue.status },
          'run-issue-return: the run opened over an in-flight status, so the floor is the stuck rung and no return can move it',
        );
      }
      continue;
    }
    if (!ASSERTS_WORK_IN_PROGRESS.includes(issue.status as IssueStatus)) {
      logger.info(
        { runId, issueKey: key, status: issue.status },
        'run-issue-return: left a status the run had already reached',
      );
      continue;
    }
    if (PARK_STATUSES.includes(issue.status as IssueStatus)) {
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
        {
          transitionReason: opts.reason,
          reason: opts.reason,
          recovery: true,
          recoveringRunId: runId,
        },
      );
      returned.push({ issueKey: key, from: issue.status as IssueStatus, to: target });
    } catch (err) {
      if (err instanceof TransitionError && err.code === 'NO_OP') continue;
      if (err instanceof TransitionError && err.code === 'STALE_TRANSITION') {
        logger.info(
          { runId, issueKey: key, from: issue.status, to: target },
          'run-issue-return: the issue moved while this return was in flight, so it belongs to whoever moved it',
        );
        continue;
      }
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
