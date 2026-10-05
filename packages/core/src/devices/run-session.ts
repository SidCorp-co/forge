/**
 * A run session as core knows it: one box, one worktree, a GROUP of issues.
 *
 * Membership lives in `pipeline_runs.metadata` because `issue_id` is one column and a run
 * carries many. Under TWO keys: `runIssues` is what the run is still carrying, which
 * `releaseIssueLease` shrinks so `run-issue-return.ts` gives back only what a lost box owes;
 * `runGroup` is what it was opened over, which nothing rewrites (ISS-1273).
 *
 * It is no longer what says who HOLDS an issue (ISS-1109). No index can
 * constrain an array element, so nothing refused the second taker and every
 * reader wrote its own predicate; the lease is a row in `issue_leases` and
 * `issues/issue-lease.ts` is the only thing that writes or reads it.
 */

import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
  RUN_ISSUES_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import { scrubSecretsDeep } from '@forge/observability';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  insertSessionRow,
  liveMasterSessionId,
  settleHandBacks,
  transitionSessions,
} from '../agent-sessions/index.js';
import { db, type Tx } from '../db/client.js';
import { agentSessions, issues, pipelineRuns, terminalAgentSessionStatuses } from '../db/schema.js';
import {
  heldIssuePrefixes,
  type IssueLeaseRelease,
  refuseHeldTakeForSeqs,
  releaseIssueLeaseRow,
  takeIssueLeases,
} from '../issues/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { canonicalIssueKey, issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import {
  closeRunIfOneShot,
  closeRunIfOneShotInTx,
  insertOneShotRun,
  lockRunForClose,
  type OneShotRunSpec,
  type RunFailureCause,
  writeRunMetadata,
} from '../pipeline/index.js';
import { type GateCondition, RUN_GATE_METADATA_KEY } from './gate-report.js';
import { projectAdmission, runnerNotAdmitted } from './pool-admission.js';
import { devicesPorts } from './ports.js';

/** The box's own run id for this dispatch, so the two records can be joined. */
export const BOX_RUN_ID_METADATA_KEY = 'boxRunId';

/**
 * The BOX's gate condition when the run opened — not this dispatch's own admission,
 * which a hook holding no control capability cannot attribute to a run (ISS-1192).
 */
export { RUN_GATE_METADATA_KEY } from './gate-report.js';

interface RunSession {
  sessionId: string;
  runId: string;
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
): Promise<RunSession | null> {
  const [row] = await executor
    .select({
      sessionId: agentSessions.id,
      runId: pipelineRuns.id,
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
  return row ? { sessionId: row.sessionId, runId: row.runId } : null;
}

export async function openRunSession(args: {
  deviceId: string;
  projectId: string;
  issueKeys: string[];
  name: string;
  boxRunId?: string;
  gate?: GateCondition;
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
      return { sessionId: existing.sessionId, runId: existing.runId };
    }
  }
  // After the replay, so a committed open whose reply was lost is answered, not orphaned.
  const admission = await projectAdmission({ projectId: args.projectId, deviceId: args.deviceId });
  if (!admission.admitted) {
    throw runnerNotAdmitted({
      reason: admission.reason,
      projectId: args.projectId,
      deviceId: args.deviceId,
    });
  }
  // cm:guard a run works issues the policy says how to run; a project with none is refused here by
  // the same name the job claim uses, before any run, session or lease is written.
  await devicesPorts().requirePolicy(args.projectId);
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
  // cm:guard an unstarted issue a live blocks edge holds (ISSUE_BLOCKED), and a flow's build without its approved design (ISS-53) are refused as the job claim refuses them
  await refuseHeldTakeForSeqs(args.projectId, canonical.seqs);
  const openingStatuses = await readIssueStatuses(args.projectId, canonical.seqs);
  const spec: OneShotRunSpec = {
    projectId: args.projectId,
    kind: 'system',
    metadata: {
      type: RUN_SESSION_KIND,
      deviceId: args.deviceId,
      [RUN_ISSUES_METADATA_KEY]: canonical.keys,
      [RUN_GROUP_METADATA_KEY]: canonical.keys,
      [RUN_ISSUE_STATUSES_METADATA_KEY]: openingStatuses,
      ...(args.boxRunId ? { [BOX_RUN_ID_METADATA_KEY]: args.boxRunId } : {}),
      ...(args.gate ? { [RUN_GATE_METADATA_KEY]: args.gate } : {}),
    },
  };
  const claimed = await db.transaction(async (tx) => {
    if (args.boxRunId) {
      await lockXact(tx, 'runSession', `${args.deviceId}:${args.boxRunId}`);
      const winner = await openSessionForBoxRun(tx, {
        deviceId: args.deviceId,
        boxRunId: args.boxRunId,
      });
      if (winner) return { existing: winner };
    }
    const run = await insertOneShotRun(tx, spec);
    const row = await insertSessionRow(tx, {
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
    });
    // Inside the transaction on purpose: a key somebody live already holds
    // rolls the run and the session back with it, so a refused open leaves a
    // box with nothing rather than with half a group.
    await takeIssueLeases(tx, {
      projectId: args.projectId,
      deviceId: args.deviceId,
      sessionId: row.id,
      runId: run.id,
      issueKeys: canonical.keys,
    });
    return { opened: { sessionId: row.id, runId: run.id } };
  });
  if (claimed.existing) {
    logger.info(
      { ...claimed.existing, boxRunId: args.boxRunId, deviceId: args.deviceId },
      'run-session: another request opened this box run while we were opening it, answering with theirs',
    );
    return { sessionId: claimed.existing.sessionId, runId: claimed.existing.runId };
  }
  const opened = claimed.opened;
  if (!opened)
    throw new Error('openRunSession: the claim returned neither a session nor an answer');
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
 * Give one issue's lease back, per ISSUE and per PROJECT, never per run.
 *
 * Two writes, because there are two records: the lease row, which says who is
 * holding the issue, and the run's membership array, which says what this run
 * was carrying and is what `returnIssuesForRun` reads to give statuses back.
 * Dropping the key from membership without dropping the lease would leave the
 * issue held by a run that no longer claims it.
 *
 * Total on purpose: a release that matched nothing, and one that matched more
 * than it could identify, are answers rather than throws, and the route turns
 * each into the refusal a box reads.
 */
export async function releaseIssueLease(args: {
  deviceId: string;
  issueKey: string;
  projectId?: string | null;
}): Promise<IssueLeaseRelease> {
  // One transaction, because they are two halves of one act. With the lease
  // dropped and committed on its own, a replacement open on this same device
  // can take the lease back before the UPDATE below runs — and that UPDATE
  // would then strip membership from the NEW run while leaving its lease
  // standing. The run then holds an issue that `returnIssuesForRun` will not
  // give back when the box dies.
  return await db.transaction(async (tx) => {
    const outcome = await releaseIssueLeaseRow(tx, args);
    if (!outcome.released) return outcome;
    // Narrowed to the project whose row went: the same key names a different
    // issue in every other project this box serves, and a run of one of those
    // is still carrying it (ISS-1139).
    const carrying = (await tx.execute(sql`
      SELECT r.id
        FROM pipeline_runs r
        JOIN agent_sessions s ON s.pipeline_run_id = r.id
       WHERE s.device_id = ${args.deviceId}
         AND s.kind = ${RUN_SESSION_KIND}
         AND r.project_id = ${outcome.projectId}
         AND r.metadata -> ${RUN_ISSUES_METADATA_KEY} @> to_jsonb(${args.issueKey}::text)
    `)) as unknown as Array<{ id: string }>;
    for (const run of new Set(carrying.map((r) => r.id))) {
      await writeRunMetadata(
        run,
        {
          value: sql`jsonb_set(
            COALESCE(${pipelineRuns.metadata}, '{}'::jsonb),
            ARRAY[${RUN_ISSUES_METADATA_KEY}],
            COALESCE(
              (SELECT jsonb_agg(k)
                 FROM jsonb_array_elements_text(
                   COALESCE(${pipelineRuns.metadata} -> ${RUN_ISSUES_METADATA_KEY}, '[]'::jsonb)
                 ) AS k
                WHERE k <> ${args.issueKey}),
              '[]'::jsonb))`,
          when: sql`${pipelineRuns.metadata} -> ${RUN_ISSUES_METADATA_KEY} @> to_jsonb(${args.issueKey}::text)`,
          touch: false,
        },
        tx,
      );
    }
    return outcome;
  });
}
/** How a box says a run session ended, and whether the work came back. */
type RunSessionOutcome = 'ended' | 'killed_idle' | 'died';

const FAILING_OUTCOMES: readonly RunSessionOutcome[] = ['died'];

interface ClosedRunSession {
  alreadyTerminal: boolean;
  returned: string[];
}

/** A close over a session already terminal: its flip handed the issues back, and a one-shot run it
 *  failed is closed here if the first close did not get that far. */
async function finishFailedClose(
  runId: string | null,
  failing: boolean,
  cause: RunFailureCause,
): Promise<string[]> {
  if (failing && runId) await closeRunIfOneShot(runId, 'failed', cause);
  return [];
}

/** Why a run fails when its run session ends on a failing outcome. */
function runSessionCause(args: {
  sessionId: string;
  outcome: RunSessionOutcome;
  detail?: string;
}): RunFailureCause {
  const said = args.detail ? `: ${args.detail}` : ', and the box gave no detail';
  return {
    code: 'agent_exited_without_result',
    detail: `its run session ${args.sessionId} ended \`${args.outcome}\`${said}`,
  };
}

/**
 * Record that a run session ended. Once the flip commits, it hands back what it left `in_progress`,
 * whatever the outcome, and answers those keys.
 */
export async function closeRunSession(input: {
  deviceId: string;
  sessionId: string;
  outcome: RunSessionOutcome;
  detail?: string;
}): Promise<ClosedRunSession | null> {
  const args =
    input.detail === undefined ? input : { ...input, detail: scrubSecretsDeep(input.detail) };
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
  const cause = runSessionCause(args);
  if ((terminalAgentSessionStatuses as readonly string[]).includes(row.status)) {
    return { alreadyTerminal: true, returned: await finishFailedClose(row.runId, failing, cause) };
  }

  // The run is locked first and closed with the session's flip, in one transaction (ISS-219).
  const closed = await db.transaction(async (tx) => {
    if (row.runId) await lockRunForClose(tx, row.runId);
    const flip = await transitionSessions(
      tx,
      {
        to: failing ? 'failed' : 'completed',
        set: {
          failureReason: failing ? 'agent_exited_without_result' : null,
          failureDetail: args.detail ?? null,
          updatedAt: new Date(),
        },
        where: and(eq(agentSessions.id, args.sessionId), eq(agentSessions.status, row.status)),
        reason: `run_session_${args.outcome}`,
        actor: { type: 'system' },
        source: 'run-session-close',
      },
      { handBack: 'caller' },
    );
    if (flip.rows.length > 0 && row.runId) {
      await closeRunIfOneShotInTx(tx, row.runId, failing ? 'failed' : 'completed', cause);
    }
    return flip;
  });
  if (closed.rows.length === 0) {
    return { alreadyTerminal: true, returned: await finishFailedClose(row.runId, failing, cause) };
  }

  // The close has committed, so the hand-back it owes is done now and its keys answered.
  const returned = await settleHandBacks(
    closed.owedHandBacks,
    `its run session ended (run_session_${args.outcome})`,
  );
  logger.info(
    { runSessionId: args.sessionId, outcome: args.outcome },
    'run-session: closed by the box',
  );
  return { alreadyTerminal: false, returned };
}
