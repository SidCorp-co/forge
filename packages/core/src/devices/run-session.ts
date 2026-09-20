/**
 * A run session as core knows it: one box, one worktree, a GROUP of issues.
 *
 * Membership lives in `pipeline_runs.metadata.runIssues` because
 * `pipeline_runs.issue_id` is one column and a run carries many. Core only
 * ever reads it by run id — to say which issues came back when a box is lost —
 * so a jsonb array serves the access pattern and no migration ships for it.
 */

import { and, eq, inArray, notInArray, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { agentSessions, issues, pipelineRuns, terminalAgentSessionStatuses } from '../db/schema.js';
import { heldIssuePrefixes } from '../issues/issue-prefix-read.js';
import { RUN_SESSION_KIND } from '../jobs/session-kinds.js';
import { canonicalIssueKey, issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import {
  announceOneShotRun,
  closeRunIfOneShot,
  insertOneShotRun,
  type OneShotRunSpec,
} from '../pipeline/runs.js';
import { liveMasterSessionId } from './master-owner.js';
import { returnIssuesForRun } from './run-issue-return.js';

export { RUN_SESSION_KIND } from '../jobs/session-kinds.js';

/** Where a run's issue group lives on its one-shot run. */
export const RUN_ISSUES_METADATA_KEY = 'runIssues';

/** The box's own run id for this dispatch, so the two records can be joined. */
export const BOX_RUN_ID_METADATA_KEY = 'boxRunId';

/** Set on the run once its open event has actually reached the subscribers. */
export const RUN_ANNOUNCED_METADATA_KEY = 'runSessionAnnouncedAt';

/** Where each issue's status AT OPEN lives, beside the group itself. */
export const RUN_ISSUE_STATUSES_METADATA_KEY = 'runIssueStatuses';

export interface RunSession {
  sessionId: string;
  runId: string;
}

/** A session found for a box run, and whether its open event ever reached anyone. */
interface FoundRunSession extends RunSession {
  announced: boolean;
}

/**
 * Each issue's status right now, keyed as the run's metadata will hold it.
 */
async function readIssueStatuses(
  projectId: string,
  seqs: number[],
): Promise<Record<string, string>> {
  if (seqs.length === 0) return {};
  const rows = await db
    .select({ issSeq: issues.issSeq, status: issues.status })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.issSeq, seqs)));
  return Object.fromEntries(rows.map((r) => [canonicalIssueKey(r.issSeq), r.status]));
}

/** Every key this run will be recorded under, in the ONE form the metadata holds. */
async function canonicaliseIssueKeys(
  projectId: string,
  issueKeys: string[],
): Promise<{ keys: string[]; seqs: number[] }> {
  const accepts = issueKeys.some((k) => issueRefNeedsHeldPrefixes(k))
    ? await heldIssuePrefixes(projectId)
    : [];
  const seqs: number[] = [];
  for (const raw of issueKeys) {
    const parsed = parseIssueRef(raw, accepts);
    if (!parsed.ok) throw new Error(`openRunSession: ${parsed.message}`);
    seqs.push(parsed.issSeq);
  }
  return { keys: seqs.map(canonicalIssueKey), seqs };
}

/**
 * Open the core-side record of a run session the box is about to spawn.
 */
/**
 * The session a device already has open for this box run, if it has one.
 */
async function openSessionForBoxRun(
  executor: Tx,
  args: {
    deviceId: string;
    boxRunId: string;
  },
): Promise<FoundRunSession | null> {
  const [row] = await executor
    .select({
      sessionId: agentSessions.id,
      runId: pipelineRuns.id,
      announced: sql<string | null>`${pipelineRuns.metadata}->>${RUN_ANNOUNCED_METADATA_KEY}`,
    })
    .from(agentSessions)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, agentSessions.pipelineRunId))
    .where(
      and(
        eq(agentSessions.deviceId, args.deviceId),
        eq(agentSessions.kind, RUN_SESSION_KIND),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
        sql`${pipelineRuns.metadata}->>${BOX_RUN_ID_METADATA_KEY} = ${args.boxRunId}`,
      ),
    )
    .limit(1);
  return row
    ? { sessionId: row.sessionId, runId: row.runId, announced: row.announced !== null }
    : null;
}

/**
 * Emit this run's open event unless it has already been emitted, and record that it was.
 */
async function announceOnce(
  found: { runId: string; announced: boolean },
  projectId: string,
): Promise<void> {
  if (found.announced) return;
  await announceOneShotRun(found.runId, { projectId, kind: 'system' });
  await db
    .update(pipelineRuns)
    .set({
      metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object(${RUN_ANNOUNCED_METADATA_KEY}::text, to_jsonb(now()))`,
    })
    .where(eq(pipelineRuns.id, found.runId));
}

/**
 * The advisory-lock key two requests for one box run both compute.
 */
function boxRunLockKey(args: { deviceId: string; boxRunId?: string }): SQL<number> {
  return sql<number>`hashtextextended(${`run-session:${args.deviceId}:${args.boxRunId}`}, 0)`;
}

export async function openRunSession(args: {
  deviceId: string;
  projectId: string;
  issueKeys: string[];
  name: string;
  boxRunId?: string;
}): Promise<RunSession> {
  if (args.issueKeys.length === 0) {
    throw new Error('openRunSession: a run session must carry at least one issue');
  }
  if (args.boxRunId) {
    const existing = await openSessionForBoxRun(db, {
      deviceId: args.deviceId,
      boxRunId: args.boxRunId,
    });
    if (existing) {
      logger.info(
        { ...existing, boxRunId: args.boxRunId, deviceId: args.deviceId },
        'run-session: this box run already has a session, answering with it rather than opening a second',
      );
      await announceOnce(existing, args.projectId);
      return { sessionId: existing.sessionId, runId: existing.runId };
    }
  }
  // Core issues the owner edge. The box is authenticated as a device and says
  // which project it is running for; which master that is, core already knows.
  // No master registered yet leaves a root rather than a guess.
  const masterSessionId = await liveMasterSessionId({
    deviceId: args.deviceId,
    projectId: args.projectId,
  });
  if (!masterSessionId) {
    logger.warn(
      { deviceId: args.deviceId, projectId: args.projectId, name: args.name },
      'run-session: no live master registered for this device and project, so this run opens as a root',
    );
  }
  const canonical = await canonicaliseIssueKeys(args.projectId, args.issueKeys);
  const openingStatuses = await readIssueStatuses(args.projectId, canonical.seqs);
  const spec: OneShotRunSpec = {
    projectId: args.projectId,
    kind: 'system',
    metadata: {
      type: RUN_SESSION_KIND,
      deviceId: args.deviceId,
      [RUN_ISSUES_METADATA_KEY]: canonical.keys,
      [RUN_ISSUE_STATUSES_METADATA_KEY]: openingStatuses,
      ...(args.boxRunId ? { [BOX_RUN_ID_METADATA_KEY]: args.boxRunId } : {}),
    },
  };
  const claimed = await db.transaction(async (tx) => {
    if (args.boxRunId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${boxRunLockKey(args)})`);
      const winner = await openSessionForBoxRun(tx, {
        deviceId: args.deviceId,
        boxRunId: args.boxRunId,
      });
      if (winner) return { existing: winner };
    }
    const run = await insertOneShotRun(tx, spec);
    const [row] = await tx
      .insert(agentSessions)
      .values({
        projectId: args.projectId,
        deviceId: args.deviceId,
        pipelineRunId: run.id,
        title: `run: ${args.name}`,
        kind: RUN_SESSION_KIND,
        parentSessionId: masterSessionId,
        status: 'running',
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        metadata: { terminalName: args.name, deviceId: args.deviceId },
      })
      .returning({ id: agentSessions.id });
    if (!row) throw new Error('openRunSession: insert returned no row');
    return { opened: { sessionId: row.id, runId: run.id } };
  });
  if (claimed.existing) {
    logger.info(
      { ...claimed.existing, boxRunId: args.boxRunId, deviceId: args.deviceId },
      'run-session: another request opened this box run while we were opening it, answering with theirs',
    );
    await announceOnce(claimed.existing, args.projectId);
    return { sessionId: claimed.existing.sessionId, runId: claimed.existing.runId };
  }
  const opened = claimed.opened;
  if (!opened)
    throw new Error('openRunSession: the claim returned neither a session nor an answer');
  await announceOnce({ runId: opened.runId, announced: false }, args.projectId);
  logger.info(
    {
      runSessionId: opened.sessionId,
      runId: opened.runId,
      boxRunId: args.boxRunId ?? null,
      deviceId: args.deviceId,
      issues: canonical.keys,
    },
    'run-session: opened',
  );
  return opened;
}

/** The issues one live run session carries, read back from its run. */
export async function runSessionIssues(sessionId: string): Promise<string[]> {
  const [row] = await db
    .select({
      issues: sql<string[] | null>`${pipelineRuns.metadata} -> ${RUN_ISSUES_METADATA_KEY}`,
    })
    .from(agentSessions)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, agentSessions.pipelineRunId))
    .where(eq(agentSessions.id, sessionId));
  return row?.issues ?? [];
}

/** Is this box's run session terminal, read from the authoritative row. */
export async function readRunSessionTerminal(args: {
  deviceId: string;
  sessionId: string;
}): Promise<boolean | null> {
  const [row] = await db
    .select({ status: agentSessions.status })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.deviceId, args.deviceId),
        eq(agentSessions.kind, RUN_SESSION_KIND),
      ),
    );
  if (!row) return null;
  return (terminalAgentSessionStatuses as readonly string[]).includes(row.status);
}

/**
 * Is one issue still held by a live run session on this box?
 */
export async function isIssueLeaseHeld(args: {
  deviceId: string;
  issueKey: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentSessions)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, agentSessions.pipelineRunId))
    .where(
      and(
        eq(agentSessions.deviceId, args.deviceId),
        eq(agentSessions.kind, RUN_SESSION_KIND),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
        sql`${pipelineRuns.metadata} -> ${RUN_ISSUES_METADATA_KEY} @> to_jsonb(${args.issueKey}::text)`,
      ),
    );
  return (row?.n ?? 0) > 0;
}

/**
 * Give one issue's lease back, per ISSUE and never per run.
 */
export async function releaseIssueLease(args: {
  deviceId: string;
  issueKey: string;
}): Promise<void> {
  await db.execute(sql`
    UPDATE pipeline_runs r
       SET metadata = jsonb_set(
             COALESCE(r.metadata, '{}'::jsonb),
             ARRAY[${RUN_ISSUES_METADATA_KEY}],
             COALESCE(
               (SELECT jsonb_agg(k)
                  FROM jsonb_array_elements_text(
                    COALESCE(r.metadata -> ${RUN_ISSUES_METADATA_KEY}, '[]'::jsonb)
                  ) AS k
                 WHERE k <> ${args.issueKey}),
               '[]'::jsonb))
      FROM agent_sessions s
     WHERE s.pipeline_run_id = r.id
       AND s.device_id = ${args.deviceId}
       AND s.kind = ${RUN_SESSION_KIND}
       AND r.metadata -> ${RUN_ISSUES_METADATA_KEY} @> to_jsonb(${args.issueKey}::text)
  `);
}

/** Every live run session on one device, for the daemon's own reconcile. */
export async function listRunSessionsForDevice(
  deviceId: string,
): Promise<Array<{ sessionId: string; runId: string; issueKeys: string[] }>> {
  const rows = await db
    .select({
      id: agentSessions.id,
      runId: pipelineRuns.id,
      issues: sql<string[] | null>`${pipelineRuns.metadata} -> ${RUN_ISSUES_METADATA_KEY}`,
    })
    .from(agentSessions)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, agentSessions.pipelineRunId))
    .where(
      and(
        eq(agentSessions.deviceId, deviceId),
        eq(agentSessions.kind, RUN_SESSION_KIND),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    );
  return rows.map((r) => ({ sessionId: r.id, runId: r.runId, issueKeys: r.issues ?? [] }));
}

/** How a box says a run session ended, and whether the work came back. */
export type RunSessionOutcome = 'ended' | 'killed_idle' | 'died';

const FAILING_OUTCOMES: readonly RunSessionOutcome[] = ['died'];

export interface ClosedRunSession {
  alreadyTerminal: boolean;
  returned: string[];
}

/**
 * Finish the half of a failed close that does not depend on flipping the session.
 */
async function finishFailedClose(
  runId: string | null,
  args: { sessionId: string; outcome: RunSessionOutcome; detail?: string },
  failing: boolean,
): Promise<string[]> {
  if (!failing || !runId) return [];
  const returned = await returnIssuesForRun(runId, {
    reason: args.detail ?? `run ${args.outcome}`,
  });
  await closeRunIfOneShot(runId, 'failed');
  if (returned.length > 0) {
    logger.warn(
      {
        runSessionId: args.sessionId,
        runId,
        returned: returned.map((r) => r.issueKey),
      },
      'run-session: a close that had already flipped the session had not returned its issues — finishing it',
    );
  }
  return returned.map((r) => r.issueKey);
}

/**
 * Record that a run session ended, and give its issues back if it failed.
 */
export async function closeRunSession(args: {
  deviceId: string;
  sessionId: string;
  outcome: RunSessionOutcome;
  detail?: string;
}): Promise<ClosedRunSession | null> {
  const [row] = await db
    .select({ status: agentSessions.status, runId: agentSessions.pipelineRunId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.deviceId, args.deviceId),
        eq(agentSessions.kind, RUN_SESSION_KIND),
      ),
    );
  if (!row) return null;
  const failing = FAILING_OUTCOMES.includes(args.outcome);
  if ((terminalAgentSessionStatuses as readonly string[]).includes(row.status)) {
    return { alreadyTerminal: true, returned: await finishFailedClose(row.runId, args, failing) };
  }

  const flipped = await applyKernelTransition(db, {
    entity: 'session',
    to: failing ? 'failed' : 'completed',
    set: {
      failureReason: failing ? 'agent_exited_without_result' : null,
      failureDetail: args.detail ?? null,
      updatedAt: new Date(),
    },
    where: and(eq(agentSessions.id, args.sessionId), eq(agentSessions.status, row.status)),
    fromStatus: row.status,
    reason: `run_session_${args.outcome}`,
    actor: { type: 'system' },
    source: 'run-session-close',
  });
  if (flipped.length === 0) {
    return { alreadyTerminal: true, returned: await finishFailedClose(row.runId, args, failing) };
  }

  const returned = failing
    ? await returnIssuesForRun(row.runId ?? '', { reason: args.detail ?? `run ${args.outcome}` })
    : [];
  if (row.runId) await closeRunIfOneShot(row.runId, failing ? 'failed' : 'completed');
  logger.info(
    { runSessionId: args.sessionId, outcome: args.outcome, returned: returned.length },
    'run-session: closed by the box',
  );
  return { alreadyTerminal: false, returned: returned.map((r) => r.issueKey) };
}
