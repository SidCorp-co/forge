/**
 * A run session as core knows it: one box, one worktree, a GROUP of issues.
 *
 * Membership lives in `pipeline_runs.metadata.runIssues` because
 * `pipeline_runs.issue_id` is one column and a run carries many. Core only
 * ever reads it by run id — to say which issues came back when a box is lost —
 * so a jsonb array serves the access pattern and no migration ships for it.
 */

import { and, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, pipelineRuns, terminalAgentSessionStatuses } from '../db/schema.js';
import { logger } from '../logger.js';
import { openOneShotRun } from '../pipeline/runs.js';

/** What `metadata.type` a run session carries. */
// cm:guard this value is EXCLUDED by name from `alarmZombieSessions`'s third arm, which would otherwise select a run session that has not set `claude_session_id` yet. Two sweeps reaping one row is two writers on the same fact, and the one that lost would report a release that had already happened to somebody else.
// cm:edge lockstep -> packages/core/src/pipeline/sweeper.ts — the exclusion there and this constant are one decision; adding a type here without excluding it there gives the row two reapers.
export const RUN_SESSION_TYPE = 'run_session';

/** Where a run's issue group lives on its one-shot run. */
export const RUN_ISSUES_METADATA_KEY = 'runIssues';

export interface RunSession {
  sessionId: string;
  runId: string;
}

/**
 * Open the core-side record of a run session the box is about to spawn.
 */
// cm:guard `issueId` on the run stays NULL and the group goes to metadata. Naming the first of the group there records one issue for a run carrying several, and the partial unique index does not apply at `kind:'system'`, so nothing downstream would ever catch the substitution.
export async function openRunSession(args: {
  deviceId: string;
  projectId: string;
  issueKeys: string[];
  name: string;
}): Promise<RunSession> {
  if (args.issueKeys.length === 0) {
    throw new Error('openRunSession: a run session must carry at least one issue');
  }
  const run = await openOneShotRun({
    projectId: args.projectId,
    kind: 'system',
    metadata: {
      type: RUN_SESSION_TYPE,
      deviceId: args.deviceId,
      [RUN_ISSUES_METADATA_KEY]: args.issueKeys,
    },
  });
  const [row] = await db
    .insert(agentSessions)
    .values({
      projectId: args.projectId,
      deviceId: args.deviceId,
      pipelineRunId: run.id,
      title: `run: ${args.name}`,
      status: 'running',
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      metadata: { type: RUN_SESSION_TYPE, terminalName: args.name, deviceId: args.deviceId },
    })
    .returning({ id: agentSessions.id });
  if (!row) throw new Error('openRunSession: insert returned no row');
  logger.info(
    { runSessionId: row.id, runId: run.id, deviceId: args.deviceId, issues: args.issueKeys },
    'run-session: opened',
  );
  return { sessionId: row.id, runId: run.id };
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
// cm:guard keyed on the AGENT SESSION id, which is the identifier the close loop's reader is handed — a route keyed on the run would make the box hold a second identity for a fact core already owns, and the two would drift.
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
        sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
      ),
    );
  if (!row) return null;
  return (terminalAgentSessionStatuses as readonly string[]).includes(row.status);
}

/**
 * Is one issue still held by a live run session on this box?
 */
// cm:guard this is the SAME question `devices/admissible.ts` excludes on, asked for one key: an issue is held while a NON-TERMINAL run session names it. Answering from the run row alone would report a lease held by a session core has already reaped, and the box would keep retrying a return that had nothing left to return.
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
        sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
        sql`${pipelineRuns.metadata} -> ${RUN_ISSUES_METADATA_KEY} @> to_jsonb(${args.issueKey}::text)`,
      ),
    );
  return (row?.n ?? 0) > 0;
}

/**
 * Give one issue's lease back, per ISSUE and never per run.
 */
// cm:guard removes exactly ONE key and leaves the rest of the group held, so a run carrying three that returned one reads as exactly that. Emptying the group here, or keying the release on the run, would make a partial return indistinguishable from a clean one — the defect the close loop exists to expose (ISS-933 criterion 14).
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
       AND s.metadata->>'type' = ${RUN_SESSION_TYPE}
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
        sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    );
  return rows.map((r) => ({ sessionId: r.id, runId: r.runId, issueKeys: r.issues ?? [] }));
}
