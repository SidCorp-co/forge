/**
 * pipeline_runs lifecycle helpers: opening the run a job or session works
 * under, advancing its current step and closing it when its issue ends.
 * Pause, resume and cancel live in `run-pause.ts` and `runs-control.ts`.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterCommit, db, type Tx } from '../db/client.js';
import { type PipelineRunKind, type PipelineRunStatus, pipelineRuns } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { markCloseDeferred, readDeployHolds, resolveDeployGate } from './deploy-confirmations.js';
import { closeRunsInTx, reasonForOutcome, requestKillsForCascade } from './runs-cascade.js';

type OpenIssueRun = { id: string; startedAt: Date };

/**
 * Open (or look up) the open `kind='issue'` run for an issue. Idempotent
 * under concurrent callers — the partial unique index
 * `pipeline_runs_issue_open_uq` rejects duplicates, so we INSERT with
 * `ON CONFLICT DO NOTHING` and re-select on collision.
 */
export async function openIssueRun(args: {
  projectId: string;
  issueId: string;
}): Promise<OpenIssueRun> {
  const existing = await selectOpenIssueRun(args.issueId);
  if (existing) return existing;

  const inserted = await db
    .insert(pipelineRuns)
    .values({
      projectId: args.projectId,
      issueId: args.issueId,
      kind: 'issue',
      status: 'running',
    })
    .onConflictDoNothing({
      target: pipelineRuns.issueId,
      where: sql`kind = 'issue' AND status IN ('running','paused')`,
    })
    .returning({ id: pipelineRuns.id, startedAt: pipelineRuns.startedAt });

  if (inserted[0]) return inserted[0];

  const winner = await selectOpenIssueRun(args.issueId);
  if (!winner) throw new Error('openIssueRun: no row after ON CONFLICT DO NOTHING');
  return winner;
}

async function selectOpenIssueRun(issueId: string): Promise<OpenIssueRun | null> {
  const [row] = await db
    .select({ id: pipelineRuns.id, startedAt: pipelineRuns.startedAt })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.kind, 'issue'),
        eq(pipelineRuns.issueId, issueId),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** What a one-shot run is opened as, shared by the two halves below. */
export interface OneShotRunSpec {
  projectId: string;
  kind: Extract<PipelineRunKind, 'interactive' | 'system'>;
  metadata?: Record<string, unknown>;
}

/** The row half of opening a one-shot run, on whatever executor is handed in. */
export async function insertOneShotRun(
  executor: Tx,
  args: OneShotRunSpec,
): Promise<{ id: string }> {
  const [row] = await executor
    .insert(pipelineRuns)
    .values({
      projectId: args.projectId,
      issueId: null,
      kind: args.kind,
      status: 'running',
      metadata: args.metadata ?? {},
    })
    .returning({ id: pipelineRuns.id });
  if (!row) throw new Error('insertOneShotRun: insert returned no row');
  return row;
}

export async function openOneShotRun(args: OneShotRunSpec): Promise<{ id: string }> {
  return insertOneShotRun(db, args);
}

/** Stamp the current step on a run; the WHERE clause skips terminal runs, so none reopens. */
export async function setCurrentStep(runId: string, step: string): Promise<void> {
  await db
    .update(pipelineRuns)
    .set({ currentStep: step, updatedAt: new Date() })
    .where(and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])));
}

/**
 * Substep markers stamped on `current_step` while a deploy is being proved.
 * They live here rather than beside the dispatcher because the close path is
 * the one that has to write them at the moment it refuses to close.
 */
export const RELEASE_DEPLOY_IN_FLIGHT_STEP = 'release.deploy.in_flight';
const RELEASE_DEPLOY_FAILED_STEP = 'release.deploy.failed';
export const RELEASE_DEPLOY_DONE_STEP = 'release.deploy.done';

type CloseResult = 'settled' | 'deferred';

/**
 * What a caller asking for `completed` is actually allowed to write, given the
 * deploy confirmations on this run. `null` means the close is DEFERRED — a
 * deploy is still in flight and the confirmation that resolves it performs the
 * close instead.
 *
 * Only `completed` is gated: a run already heading for `failed` or `cancelled`
 * is not making a claim about a deploy.
 */
async function gatedOutcome(
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<'completed' | 'failed' | 'cancelled' | null> {
  if (outcome !== 'completed') return outcome;
  if (Object.keys(await readDeployHolds(runId)).length === 0) return 'completed';

  await markCloseDeferred(runId);
  const gate = resolveDeployGate(await readDeployHolds(runId));
  if (gate.verdict === 'clear') return 'completed';
  if (gate.verdict === 'failed') {
    logger.warn(
      { runId, detail: gate.detail },
      'run close: deploy confirmation failed — closing the run `failed` rather than `completed`',
    );
    await setCurrentStep(runId, `${RELEASE_DEPLOY_FAILED_STEP} (${gate.detail})`);
    return 'failed';
  }
  await setCurrentStep(runId, `${RELEASE_DEPLOY_IN_FLIGHT_STEP} (${gate.confirmed}/${gate.total})`);
  logger.info(
    { runId, confirmed: gate.confirmed, total: gate.total },
    'run close deferred: a dispatched deploy is not confirmed yet',
  );
  return null;
}

/**
 * Mark a run terminal. No-op when the run is already terminal so callers
 * can call this from both the issue state-machine (issue-runs) and the
 * session/job lifecycle (pm/interactive runs) without coordinating.
 *
 * Returns `deferred` when a dispatched deploy has not reported back yet — the
 * run is deliberately left `running` and nothing was written.
 */
export async function closeRun(
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<CloseResult> {
  const resolved = await gatedOutcome(runId, outcome);
  if (resolved === null) return 'deferred';
  const { cascades } = await db.transaction((tx) =>
    closeRunsInTx(tx, {
      to: resolved,
      where: and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])),
      reason: reasonForOutcome(resolved),
      actor: { type: 'system' },
      source: 'runs',
    }),
  );
  for (const c of cascades) {
    await requestKillsForCascade(c.result.killableJobs, reasonForOutcome(resolved));
  }
  return 'settled';
}

/**
 * Close a one-shot (interactive | system) run that's reached terminal state.
 * No-ops on `kind='issue'` runs — those are closed by the issue
 * state-machine via `closeOpenRunForIssue`, never per-session/per-job, so
 * sibling jobs on the same issue don't trip over each other.
 */
export async function closeRunIfOneShot(
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  await db.transaction((tx) => closeRunIfOneShotInTx(tx, runId, outcome));
}

/**
 * `closeRunIfOneShot` inside a transaction the caller holds, for a close that has to commit with
 * the write that caused it. The cascade's kills are requested once that transaction commits.
 * Answers whether this call closed the run.
 */
export async function closeRunIfOneShotInTx(
  tx: Tx,
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<boolean> {
  const { rows, cascades } = await closeRunsInTx(tx, {
    to: outcome,
    where: and(
      eq(pipelineRuns.id, runId),
      inArray(pipelineRuns.kind, ['interactive', 'system']),
      inArray(pipelineRuns.status, ['running', 'paused']),
    ),
    reason: reasonForOutcome(outcome),
    actor: { type: 'system' },
    source: 'runs',
  });
  for (const c of cascades) {
    afterCommit(() => {
      void requestKillsForCascade(c.result.killableJobs, reasonForOutcome(outcome));
    });
  }
  return rows.length > 0;
}

interface CancelConcludedResult {
  /** True when this call flipped the run. */
  cancelled: boolean;
  /** What the run said before the flip, whether or not it moved. */
  was: PipelineRunStatus | null;
}

export async function cancelConcludedRun(runId: string): Promise<CancelConcludedResult> {
  const [before] = await db
    .select({ status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!before) return { cancelled: false, was: null };

  const { rows, cascades } = await db.transaction((tx) =>
    closeRunsInTx(tx, {
      to: 'cancelled',
      where: and(
        eq(pipelineRuns.id, runId),
        inArray(pipelineRuns.kind, ['interactive', 'system']),
        inArray(pipelineRuns.status, ['completed', 'failed']),
      ),
      set: {
        metadata: sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || ${JSON.stringify({
          cancelledFrom: before.status,
        })}::jsonb`,
      },
      reason: reasonForOutcome('cancelled'),
      actor: { type: 'system' },
      source: 'runs',
    }),
  );
  for (const c of cascades) {
    await requestKillsForCascade(c.result.killableJobs, reasonForOutcome('cancelled'));
  }
  return { cancelled: rows.length > 0, was: before.status };
}

/**
 * Close the open issue-run for an issue, if any. The partial unique index
 * guarantees at most one open issue-run per issue, so this is unambiguous.
 * No-op when the issue has no open run (e.g. an issue whose pipeline never
 * fired a job).
 */
export async function closeOpenRunForIssue(
  issueId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<CloseResult> {
  const open = await selectOpenIssueRun(issueId);
  if (!open) return 'settled';
  const resolved = await gatedOutcome(open.id, outcome);
  if (resolved === null) return 'deferred';
  const { cascades } = await db.transaction((tx) =>
    closeRunsInTx(tx, {
      to: resolved,
      where: and(
        eq(pipelineRuns.kind, 'issue'),
        eq(pipelineRuns.issueId, issueId),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
      reason: reasonForOutcome(resolved),
      actor: { type: 'system' },
      source: 'runs',
    }),
  );
  for (const c of cascades) {
    await requestKillsForCascade(c.result.killableJobs, reasonForOutcome(resolved));
  }
  return 'settled';
}

/** One run, whole. Authorisation belongs to the caller, which knows the credential. */
export async function readPipelineRun(runId: string) {
  const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1);
  return row ?? null;
}
