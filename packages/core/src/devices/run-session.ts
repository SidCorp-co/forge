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
import { canonicalIssueKey, issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import {
  announceOneShotRun,
  closeRunIfOneShot,
  insertOneShotRun,
  type OneShotRunSpec,
} from '../pipeline/runs.js';
import { returnIssuesForRun } from './run-issue-return.js';

/** What `metadata.type` a run session carries. */
// cm:guard this value is EXCLUDED by name from `alarmZombieSessions`'s third arm, which would otherwise select a run session that has not set `claude_session_id` yet. Two sweeps reaping one row is two writers on the same fact, and the one that lost would report a release that had already happened to somebody else.
// cm:edge lockstep -> packages/core/src/pipeline/sweeper.ts — the exclusion there and this constant are one decision; adding a type here without excluding it there gives the row two reapers.
export const RUN_SESSION_TYPE = 'run_session';

/** Where a run's issue group lives on its one-shot run. */
export const RUN_ISSUES_METADATA_KEY = 'runIssues';

/** The box's own run id for this dispatch, so the two records can be joined. */
// cm:guard STORED and never read for control. The box mints this id first, into its own sqlite registry, and core mints a `pipeline_runs` id of its own; without one side recording the other's there is no key at all between a row in `~/.local/share/forge-runner/ledger.sqlite` and the run session that answers for it, and a person holding one has to guess. It is recorded because the route was already being handed it and dropping it on the floor is a 200 that does nothing with a field the caller sent (ISS-1050 criterion 6).
export const BOX_RUN_ID_METADATA_KEY = 'boxRunId';

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
// cm:guard the caller may type the project's own prefix or the legacy one — `pool list` shows the first — and what is STORED is always canonical. The stored keys are matched by string containment in SQL (`admissible.ts`, `runSessionsForIssue` below) and never parsed, so a run opened under `FD-977` among historical `ISS-977` rows is a set no single query matches and its issues never come back (ISS-992).
// cm:edge lockstep -> packages/core/src/lib/issue-ref.ts#canonicalIssueKey
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
// cm:guard `issueId` on the run stays NULL and the group goes to metadata. Naming the first of the group there records one issue for a run carrying several, and the partial unique index does not apply at `kind:'system'`, so nothing downstream would ever catch the substitution.
/**
 * The session a device already has open for this box run, if it has one.
 */
// cm:guard scoped by DEVICE as well as by the box run id. A run id is minted on the box, so two boxes could in principle answer with the same one; unscoped, one box's retry would be handed the other box's session and would then beat, close and release issues it never held.
// cm:guard non-terminal ONLY. A retry of a declaration whose session has already been closed or reaped is a genuinely new run of the same work, and handing it the dead session would give it one nothing beats — reaped again ten minutes later, returning issues from under a run that is working.
async function openSessionForBoxRun(
  executor: Tx,
  args: {
    deviceId: string;
    boxRunId: string;
  },
): Promise<RunSession | null> {
  const [row] = await executor
    .select({ sessionId: agentSessions.id, runId: pipelineRuns.id })
    .from(agentSessions)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, agentSessions.pipelineRunId))
    .where(
      and(
        eq(agentSessions.deviceId, args.deviceId),
        sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
        sql`${pipelineRuns.metadata}->>${BOX_RUN_ID_METADATA_KEY} = ${args.boxRunId}`,
      ),
    )
    .limit(1);
  return row ? { sessionId: row.sessionId, runId: row.runId } : null;
}

/**
 * The advisory-lock key two requests for one box run both compute.
 */
// cm:guard the lock is TRANSACTION-scoped and its key is derived, not stored, so nothing has to be cleaned up and no row has to exist first: `pg_advisory_xact_lock` is released by the commit or the rollback, including the rollback a crashed backend does for us. Advisory keys share one namespace database-wide, which is why the text carries the `run-session:` prefix — a collision with another feature's key would serialize two unrelated calls, never mix their answers up.
// cm:guard keyed on device AND box run id, the same pair `openSessionForBoxRun` reads on. Locking on the box run id alone would make two boxes that minted the same id wait for each other for no reason; locking on the device alone would serialize every declaration a busy box makes.
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
  // cm:guard the box run id is an IDEMPOTENCY key and not only a join key. The box writes its row
  // first and then calls this; if core commits and the answer is lost — a timeout, a dropped
  // connection, a write-back that failed on the box — the box still has no session id and its next
  // sweep sends the same declaration again. Minting a second session there leaves the first with
  // nothing beating it, so core reaps it after ten minutes and `returnIssuesForRun` pulls those
  // issues back from under the live duplicate: the exact failure this issue exists to end, arriving
  // from inside the fix (ISS-1050).
  // cm:guard this read is the FAST PATH and is not what makes the key hold. On its own it is a
  // check followed by a create, and two requests that both arrive before either commits both see
  // nothing and each open a session — the duplicate above, reached by a different road. The read
  // that decides is the one inside the transaction below, taken after
  // `pg_advisory_xact_lock(boxRunLockKey(...))`, where the loser of the race blocks until the
  // winner commits and then finds the winner's row. Deleting this read costs a lock acquisition on
  // every retry and changes no answer; deleting the locked one loses the guarantee.
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
      return existing;
    }
  }
  const canonical = await canonicaliseIssueKeys(args.projectId, args.issueKeys);
  // cm:guard read the statuses BEFORE the run exists, because the agent this run is about to spawn starts moving them immediately — a read taken afterwards records `in_progress` as the status to return to, and returning an issue to `in_progress` gives it back to nobody.
  const openingStatuses = await readIssueStatuses(args.projectId, canonical.seqs);
  const spec: OneShotRunSpec = {
    projectId: args.projectId,
    kind: 'system',
    metadata: {
      type: RUN_SESSION_TYPE,
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
        status: 'running',
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        metadata: { type: RUN_SESSION_TYPE, terminalName: args.name, deviceId: args.deviceId },
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
    return claimed.existing;
  }
  const opened = claimed.opened;
  if (!opened)
    throw new Error('openRunSession: the claim returned neither a session nor an answer');
  await announceOneShotRun(opened.runId, spec);
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
