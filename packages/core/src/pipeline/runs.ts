/**
 * ISS-101 — pipeline_runs lifecycle helpers.
 *
 * All writes to `pipeline_runs` go through these four functions. The
 * orchestrator/PM/interactive paths use them to open the right run for each
 * new job/session; the issue state-machine uses them to advance and close
 * the run on terminal transitions.
 */

import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, type PipelineRunKind, type PipelineRunStatus, pipelineRuns } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { markCloseDeferred, readDeployHolds, resolveDeployGate } from './deploy-confirmations.js';
import { hooks } from './hooks.js';
import {
  cascadeCancelChildJobs,
  reasonForOutcome,
  requestKillsForCascade,
} from './runs-cascade.js';

export type OpenIssueRun = { id: string; startedAt: Date };

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

  // Race-safe insert. `pipeline_runs_issue_open_uq` is partial
  // (kind='issue' AND status IN running|paused), so a duplicate INSERT from
  // two concurrent callers becomes a DO NOTHING and the loser re-selects.
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

  if (inserted[0]) {
    await hooks.emit('pipelineRunStatusChanged', {
      runId: inserted[0].id,
      projectId: args.projectId,
      issueId: args.issueId,
      kind: 'issue',
      fromStatus: null,
      toStatus: 'running',
      currentStep: null,
    });
    return inserted[0];
  }

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

/**
 * One-shot run for paths that aren't tied to an issue:
 *   - `pm`           — the PM coordinator job (project-scoped).
 *   - `interactive`  — a user-driven chat session.
 *   - `system`       — project-scoped jobs without an issueId (schedule
 *                      runs, skill pushes, MCP/CLI custom jobs).
 *
 * Each call creates a fresh row; no upsert is needed because there's no
 * per-issue uniqueness to enforce.
 */
export async function openOneShotRun(args: {
  projectId: string;
  kind: Extract<PipelineRunKind, 'pm' | 'interactive' | 'system'>;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(pipelineRuns)
    .values({
      projectId: args.projectId,
      issueId: null,
      kind: args.kind,
      status: 'running',
      metadata: args.metadata ?? {},
    })
    .returning({ id: pipelineRuns.id });
  if (!row) throw new Error('openOneShotRun: insert returned no row');
  await hooks.emit('pipelineRunStatusChanged', {
    runId: row.id,
    projectId: args.projectId,
    issueId: null,
    kind: args.kind,
    fromStatus: null,
    toStatus: 'running',
    currentStep: null,
  });
  return row;
}

/**
 * Stamp the current pipeline step onto a run. Cheap UPDATE; safe to call
 * on terminal runs (the WHERE clause filters them out so we don't reopen
 * a closed run by accident).
 */
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
export const RELEASE_DEPLOY_FAILED_STEP = 'release.deploy.failed';
export const RELEASE_DEPLOY_DONE_STEP = 'release.deploy.done';

export type CloseResult = 'settled' | 'deferred';

/**
 * What a caller asking for `completed` is actually allowed to write, given the
 * deploy confirmations on this run. `null` means the close is DEFERRED — a
 * deploy is still in flight and the confirmation that resolves it performs the
 * close instead.
 *
 * Only `completed` is gated: a run already heading for `failed` or `cancelled`
 * is not making a claim about a deploy.
 */
// cm:edge contract -> packages/core/src/integrations/coolify/confirm.ts — the poller is the other half: it settles the holds this reads, and calls back into `closeRun` when the last one resolves. Neither side works alone.
async function gatedOutcome(
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<'completed' | 'failed' | 'cancelled' | null> {
  if (outcome !== 'completed') return outcome;
  if (Object.keys(await readDeployHolds(runId)).length === 0) return 'completed';

  // cm:guard mark the deferral BEFORE resolving the verdict, never after — a confirmation settling the last hold in between would find no marker, neither side would close the run, and it would sit `running` until a sweeper found it 60 minutes later. Marking first is harmless when it turns out unnecessary: a stale marker only ever causes a `closeRun` on an already-terminal run, which no-ops.
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
  const { rows, cascade } = await db.transaction(async (tx) => {
    const updated = await applyKernelTransition(tx, {
      entity: 'run',
      to: resolved,
      set: { finishedAt: new Date(), updatedAt: new Date() },
      where: and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])),
      fromStatus: 'open',
      reason: reasonForOutcome(resolved),
      actor: { type: 'system' },
      source: 'runs',
    });
    const c =
      updated.length > 0
        ? await cascadeCancelChildJobs(tx, runId, reasonForOutcome(resolved))
        : null;
    return { rows: updated, cascade: c };
  });
  if (cascade) await requestKillsForCascade(cascade.killableJobs, reasonForOutcome(resolved));
  await emitCloseHook(rows, resolved, cascade?.cancelledJobIds ?? []);
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
 * Close a one-shot (pm | interactive) run that's reached terminal state.
 * No-ops on `kind='issue'` runs — those are closed by the issue
 * state-machine via `closeOpenRunForIssue`, never per-session/per-job, so
 * sibling jobs on the same issue don't trip over each other.
 *
 * For pm runs the caller is expected to skip the close when a retry is
 * scheduled (the retry shares the same run); see `jobs/lifecycle-routes.ts`
 * for the retry-aware call sites.
 */
// cm:guard NOT gated on deploy confirmations, and that is a statement about the run KINDS this one accepts: a hold is only ever written for the `issue` run a deploy was dispatched against, so a gate here could never fire and would only suggest one exists for pm/interactive/system runs.
export async function closeRunIfOneShot(
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  const { rows, cascade } = await db.transaction(async (tx) => {
    const updated = await applyKernelTransition(tx, {
      entity: 'run',
      to: outcome,
      set: { finishedAt: new Date(), updatedAt: new Date() },
      where: and(
        eq(pipelineRuns.id, runId),
        inArray(pipelineRuns.kind, ['pm', 'interactive', 'system']),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
      fromStatus: 'open',
      reason: reasonForOutcome(outcome),
      actor: { type: 'system' },
      source: 'runs',
    });
    const c =
      updated.length > 0
        ? await cascadeCancelChildJobs(tx, runId, reasonForOutcome(outcome))
        : null;
    return { rows: updated, cascade: c };
  });
  if (cascade) await requestKillsForCascade(cascade.killableJobs, reasonForOutcome(outcome));
  await emitCloseHook(rows, outcome, cascade?.cancelledJobIds ?? []);
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
  // cm:guard the gate is per-RUN, so the open run is named before it can be asked — an issue-keyed gate would have to guess which run a deploy hold belongs to.
  const open = await selectOpenIssueRun(issueId);
  if (!open) return 'settled';
  const resolved = await gatedOutcome(open.id, outcome);
  if (resolved === null) return 'deferred';
  const { rows, cascades } = await db.transaction(async (tx) => {
    const updatedRows = await applyKernelTransition(tx, {
      entity: 'run',
      to: resolved,
      set: { finishedAt: new Date(), updatedAt: new Date() },
      where: and(
        eq(pipelineRuns.kind, 'issue'),
        eq(pipelineRuns.issueId, issueId),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
      fromStatus: 'open',
      reason: reasonForOutcome(resolved),
      actor: { type: 'system' },
      source: 'runs',
    });
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
  const cascadedByRun = new Map(cascades.map((c) => [c.runId, c.result.cancelledJobIds]));
  await emitCloseHookPerRow(rows, resolved, cascadedByRun);
  return 'settled';
}

type CloseReturning = {
  id: string;
  projectId: string;
  issueId: string | null;
  kind: PipelineRunKind;
  currentStep: string | null;
};

// Emit `pipelineRunStatusChanged` per row the close actually updated.
// `fromStatus` is recorded as 'running' — the close UPDATE is gated on
// status IN ('running','paused') and the paused→terminal case is rare
// enough that recording the precise prior status would require an extra
// round-trip; the breadcrumb data carries `currentStep` for context.
//
// ISS-258 — the optional `cascadedJobIds` rides along on the same hook so
// the Sentry breadcrumb subscriber surfaces orphan cleanup without emitting
// a duplicate status_changed event.
async function emitCloseHook(
  rows: CloseReturning[] | undefined,
  toStatus: PipelineRunStatus,
  cascadedJobIds: string[] = [],
): Promise<void> {
  if (!rows || rows.length === 0) return;
  for (const r of rows) {
    await hooks.emit('pipelineRunStatusChanged', {
      runId: r.id,
      projectId: r.projectId,
      issueId: r.issueId,
      kind: r.kind,
      fromStatus: 'running',
      toStatus,
      currentStep: r.currentStep,
      cascadedJobIds,
    });
  }
}

async function emitCloseHookPerRow(
  rows: CloseReturning[] | undefined,
  toStatus: PipelineRunStatus,
  cascadedByRun: Map<string, string[]>,
): Promise<void> {
  if (!rows || rows.length === 0) return;
  for (const r of rows) {
    await hooks.emit('pipelineRunStatusChanged', {
      runId: r.id,
      projectId: r.projectId,
      issueId: r.issueId,
      kind: r.kind,
      fromStatus: 'running',
      toStatus,
      currentStep: r.currentStep,
      cascadedJobIds: cascadedByRun.get(r.id) ?? [],
    });
  }
}

/** The project a pipeline run belongs to, or `null` when there is no such run. */
export async function findRunProjectId(runId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: pipelineRuns.projectId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return row?.projectId ?? null;
}

/** One run, whole. Authorisation belongs to the caller, which knows the credential. */
export async function readPipelineRun(runId: string) {
  const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1);
  return row ?? null;
}

export type PipelineRunQuery = {
  projectId: string;
  issueId?: string | undefined;
  status?: PipelineRunStatus | undefined;
  limit: number;
};

// cm:guard the projection OMITS the `metadata` jsonb, and must keep omitting it (ISS-428): it is unbounded, and a list of fifty runs carrying fifty of them overflows the MCP response cap. `readPipelineRun` is where a caller that needs it goes.
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
      // cm:why ISS-789 — `status` alone cannot say whether anything is still working on a run; a correlated count keeps that answer in the same round-trip as the row it describes
      // cm:guard write the identifiers LITERALLY here — do NOT interpolate `${jobs.pipelineRunId}` / `${pipelineRuns.id}`. Drizzle renders a column reference inside a raw sql template UNQUALIFIED (`"id"`, not `"pipeline_runs"."id"`), so inside this subquery the bare `"id"` binds to jobs.id and the correlation becomes `jobs.pipeline_run_id = jobs.id` — always false, count always 0. It compiles, typechecks, and is wrong; it shipped in 65bb8a0b and only real data caught it.
      liveJobs: sql<number>`(
        SELECT count(*)::int FROM jobs lj
        WHERE lj.pipeline_run_id = pipeline_runs.id
          AND lj.status IN ('queued','dispatched','running')
      )`.mapWith(Number),
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
