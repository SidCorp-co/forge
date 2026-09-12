/**
 * A run session as core knows it: one box, one worktree, a GROUP of issues.
 *
 * Membership lives in `pipeline_runs.metadata.runIssues` because
 * `pipeline_runs.issue_id` is one column and a run carries many. Core only
 * ever reads it by run id — to say which issues came back when a box is lost —
 * so a jsonb array serves the access pattern and no migration ships for it.
 */

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, issues, pipelineRuns, terminalAgentSessionStatuses } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { closeRunIfOneShot, openOneShotRun } from '../pipeline/runs.js';
import { returnIssuesForRun } from './run-issue-return.js';

/** What `metadata.type` a run session carries. */
// cm:guard this value is EXCLUDED by name from `alarmZombieSessions`'s third arm, which would otherwise select a run session that has not set `claude_session_id` yet. Two sweeps reaping one row is two writers on the same fact, and the one that lost would report a release that had already happened to somebody else.
// cm:edge lockstep -> packages/core/src/pipeline/sweeper.ts — the exclusion there and this constant are one decision; adding a type here without excluding it there gives the row two reapers.
export const RUN_SESSION_TYPE = 'run_session';

/** Where a run's issue group lives on its one-shot run. */
export const RUN_ISSUES_METADATA_KEY = 'runIssues';

/** Where each issue's status AT OPEN lives, beside the group itself. */
// cm:guard a SECOND key beside `runIssues` and never a reshape of it: `releaseIssueLease` and `isIssueLeaseHeld` both match `runIssues` with `@> to_jsonb(<key>)`, so turning its elements into objects makes every lease on every box unreadable at once — and the containment query fails OPEN, reporting no lease held rather than erroring.
export const RUN_ISSUE_STATUSES_METADATA_KEY = 'runIssueStatuses';

export interface RunSession {
  sessionId: string;
  runId: string;
}

/**
 * Each issue's status right now, keyed as the run's metadata will hold it.
 */
// cm:guard a key with NO row is left out rather than recorded as null: the return path treats an absent entry as "nothing known, leave it alone", and a null would have to be told apart from a status at every reader.
async function readIssueStatuses(
  projectId: string,
  issueKeys: string[],
): Promise<Record<string, string>> {
  const seqs = issueKeys
    .map((k) => Number.parseInt(k.replace(/^ISS-/, ''), 10))
    .filter((n) => Number.isInteger(n));
  if (seqs.length === 0) return {};
  const rows = await db
    .select({ issSeq: issues.issSeq, status: issues.status })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.issSeq, seqs)));
  return Object.fromEntries(rows.map((r) => [`ISS-${r.issSeq}`, r.status]));
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
  // cm:guard read the statuses BEFORE the run exists, because the agent this run is about to spawn starts moving them immediately — a read taken afterwards records `in_progress` as the status to return to, and returning an issue to `in_progress` gives it back to nobody.
  const openingStatuses = await readIssueStatuses(args.projectId, args.issueKeys);
  const run = await openOneShotRun({
    projectId: args.projectId,
    kind: 'system',
    metadata: {
      type: RUN_SESSION_TYPE,
      deviceId: args.deviceId,
      [RUN_ISSUES_METADATA_KEY]: args.issueKeys,
      [RUN_ISSUE_STATUSES_METADATA_KEY]: openingStatuses,
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

/** How a box says a run session ended, and whether the work came back. */
// cm:guard the OUTCOME is the whole point of this verb. Before it, a run reached terminal only by going silent for ten minutes, so `runner_unreachable` was stamped on a box that died, a pane that crashed and a pane that finished alike — three different facts under one name, and the metric that measures fleet stability counted all of them. A close with no outcome would rebuild that.
export type RunSessionOutcome = 'ended' | 'killed_idle' | 'died';

const FAILING_OUTCOMES: readonly RunSessionOutcome[] = ['died'];

export interface ClosedRunSession {
  alreadyTerminal: boolean;
  returned: string[];
}

/**
 * Record that a run session ended, and give its issues back if it failed.
 */
// cm:guard `ended` and `killed_idle` return NOTHING and that asymmetry is the feature: both mean the agent had stopped working of its own accord, so the statuses it left behind are its own record. Only `died` — a process that went away mid-turn — is a reason to undo them.
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/run_sessions.rs — `close` is this route's only caller, and the outcome strings are the wire contract; a name the box sends that this union does not hold is refused rather than coerced, because a coerced `died` would return issues an agent had deliberately advanced.
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
        sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
      ),
    );
  if (!row) return null;
  if ((terminalAgentSessionStatuses as readonly string[]).includes(row.status)) {
    return { alreadyTerminal: true, returned: [] };
  }

  const failing = FAILING_OUTCOMES.includes(args.outcome);
  // cm:edge lockstep -> packages/core/src/lifecycle/transition.ts — the flip routes through the chokepoint so it leaves a `kernel_transitions` row, exactly as the reaper's does; `transition-guard.test.ts` fails a terminal status written here directly.
  const flipped = await applyKernelTransition(db, {
    entity: 'session',
    to: failing ? 'failed' : 'completed',
    set: {
      // cm:guard `agent_exited_without_result` and NOT `runner_unreachable`: the process going away mid-turn is an AGENT fault, and routing it through the transport cause is what made that bucket unreadable — 203 sessions over 7 days on two projects, of which the box was actually unreachable for a fraction nobody can now recover.
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
  if (flipped.length === 0) return { alreadyTerminal: true, returned: [] };

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
