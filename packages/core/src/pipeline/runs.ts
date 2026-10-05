import { RUN_MACHINE } from '@forge/contracts/run-machine';
/**
 * ISS-101 — pipeline_runs lifecycle helpers.
 *
 * All writes to `pipeline_runs` go through these four functions. The
 * orchestrator/PM/interactive paths use them to open the right run for each
 * new job/session; the issue state-machine uses them to advance and close
 * the run on terminal transitions.
 */

import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { jobs, type PipelineRunKind, type PipelineRunStatus, pipelineRuns } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { transition } from '../lifecycle/index.js';
import { markCloseDeferred, readDeployHolds, resolveDeployGate } from './deploy-confirmations.js';
import {
  cascadeCancelChildJobs,
  reasonForOutcome,
  requestKillsForCascade,
} from './runs-cascade.js';

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
  const { cascade } = await db.transaction(async (tx) => {
    const updated = (
      await transition(tx, RUN_MACHINE, {
        to: resolved,
        set: { finishedAt: new Date(), updatedAt: new Date() },
        where: and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])),
        reason: reasonForOutcome(resolved),
        actor: { type: 'system' },
        source: 'runs',
      })
    ).rows;
    const c =
      updated.length > 0
        ? await cascadeCancelChildJobs(tx, runId, reasonForOutcome(resolved))
        : null;
    return { rows: updated, cascade: c };
  });
  if (cascade) await requestKillsForCascade(cascade.killableJobs, reasonForOutcome(resolved));
  return 'settled';
}

/**
 * Stamp `current_step` on the issue's open run, if one exists. No-op when the
 * issue has no open run (e.g. a status change before the first job has been
 * queued for this issue). Used by the issue state-machine to keep the run
 * timeline in sync with the issue's `status`.
 */
export async function setCurrentStepForOpenIssueRun(issueId: string, step: string): Promise<void> {
  await db
    .update(pipelineRuns)
    .set({ currentStep: step, updatedAt: new Date() })
    .where(
      and(
        eq(pipelineRuns.kind, 'issue'),
        eq(pipelineRuns.issueId, issueId),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
    );
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
  const { cascade } = await db.transaction(async (tx) => {
    const updated = (
      await transition(tx, RUN_MACHINE, {
        to: outcome,
        set: { finishedAt: new Date(), updatedAt: new Date() },
        where: and(
          eq(pipelineRuns.id, runId),
          inArray(pipelineRuns.kind, ['interactive', 'system']),
          inArray(pipelineRuns.status, ['running', 'paused']),
        ),
        reason: reasonForOutcome(outcome),
        actor: { type: 'system' },
        source: 'runs',
      })
    ).rows;
    const c =
      updated.length > 0
        ? await cascadeCancelChildJobs(tx, runId, reasonForOutcome(outcome))
        : null;
    return { rows: updated, cascade: c };
  });
  if (cascade) await requestKillsForCascade(cascade.killableJobs, reasonForOutcome(outcome));
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

  const { rows, cascade } = await db.transaction(async (tx) => {
    const updated = (
      await transition(tx, RUN_MACHINE, {
        to: 'cancelled',
        set: {
          finishedAt: new Date(),
          updatedAt: new Date(),
          metadata: sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || ${JSON.stringify({
            cancelledFrom: before.status,
          })}::jsonb`,
        },
        where: and(
          eq(pipelineRuns.id, runId),
          inArray(pipelineRuns.kind, ['interactive', 'system']),
          inArray(pipelineRuns.status, ['completed', 'failed']),
        ),
        reason: reasonForOutcome('cancelled'),
        actor: { type: 'system' },
        source: 'runs',
      })
    ).rows;
    const c =
      updated.length > 0
        ? await cascadeCancelChildJobs(tx, runId, reasonForOutcome('cancelled'))
        : null;
    return { rows: updated, cascade: c };
  });
  if (cascade) await requestKillsForCascade(cascade.killableJobs, reasonForOutcome('cancelled'));
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
  const { cascades } = await db.transaction(async (tx) => {
    const updatedRows = (
      await transition(tx, RUN_MACHINE, {
        to: resolved,
        set: { finishedAt: new Date(), updatedAt: new Date() },
        where: and(
          eq(pipelineRuns.kind, 'issue'),
          eq(pipelineRuns.issueId, issueId),
          inArray(pipelineRuns.status, ['running', 'paused']),
        ),
        reason: reasonForOutcome(resolved),
        actor: { type: 'system' },
        source: 'runs',
      })
    ).rows;
    const cs = await Promise.all(
      updatedRows.map(async (r) => ({
        runId: r.id,
        result: await cascadeCancelChildJobs(tx, r.id, reasonForOutcome(resolved)),
      })),
    );
    return { rows: updatedRows, cascades: cs };
  });
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

type PipelineRunQuery = {
  projectId: string;
  issueId?: string | undefined;
  status?: PipelineRunStatus | undefined;
  limit: number;
};

export async function listPipelineRuns(q: PipelineRunQuery) {
  const conds: SQL[] = [eq(pipelineRuns.projectId, q.projectId)];
  if (q.issueId) conds.push(eq(pipelineRuns.issueId, q.issueId));
  if (q.status) conds.push(eq(pipelineRuns.status, q.status));

  return db
    .select({
      id: pipelineRuns.id,
      projectId: pipelineRuns.projectId,
      issueId: pipelineRuns.issueId,
      kind: pipelineRuns.kind,
      status: pipelineRuns.status,
      currentStep: pipelineRuns.currentStep,
      startedAt: pipelineRuns.startedAt,
      finishedAt: pipelineRuns.finishedAt,
      createdAt: pipelineRuns.createdAt,
      updatedAt: pipelineRuns.updatedAt,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(and(...conds))
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(q.limit);
}

/** How many jobs a run holds, by status. */
export async function countRunJobsByStatus(runId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.pipelineRunId, runId))
    .groupBy(jobs.status);

  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.count);
  return out;
}
