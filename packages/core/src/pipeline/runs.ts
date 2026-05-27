/**
 * ISS-101 — pipeline_runs lifecycle helpers.
 *
 * All writes to `pipeline_runs` go through these four functions. The
 * orchestrator/PM/interactive paths use them to open the right run for each
 * new job/session; the issue state-machine uses them to advance and close
 * the run on terminal transitions.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type PipelineRunKind, type PipelineRunStatus, pipelineRuns } from '../db/schema.js';
import { hooks } from './hooks.js';
import { broadcastAbortEvents, cascadeCancelChildJobs, reasonForOutcome } from './runs-cascade.js';

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
  // Fast path — open run already exists.
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
 * Stamp current_step on a run regardless of status. Used by post-terminal
 * substeps like Coolify release.deploy.* — the issue state-machine has
 * already closed the run by the time the deploy outcome arrives, but the UI
 * still needs to render the deploy result on the existing run row.
 */
export async function setCurrentStepForce(runId: string, step: string): Promise<void> {
  await db
    .update(pipelineRuns)
    .set({ currentStep: step, updatedAt: new Date() })
    .where(eq(pipelineRuns.id, runId));
}

/**
 * Mark a run terminal. No-op when the run is already terminal so callers
 * can call this from both the issue state-machine (issue-runs) and the
 * session/job lifecycle (pm/interactive runs) without coordinating.
 */
export async function closeRun(
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  const { rows, cascade } = await db.transaction(async (tx) => {
    const updated = await tx
      .update(pipelineRuns)
      .set({ status: outcome, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])))
      .returning({
        id: pipelineRuns.id,
        projectId: pipelineRuns.projectId,
        issueId: pipelineRuns.issueId,
        kind: pipelineRuns.kind,
        currentStep: pipelineRuns.currentStep,
      });
    const updatedRows = updated ?? [];
    const c =
      updatedRows.length > 0
        ? await cascadeCancelChildJobs(tx, runId, reasonForOutcome(outcome))
        : null;
    return { rows: updatedRows, cascade: c };
  });
  if (cascade)
    await broadcastAbortEvents(cascade.deviceBySession, reasonForOutcome(outcome), runId);
  await emitCloseHook(rows, outcome, cascade?.cancelledJobIds ?? []);
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
export async function closeRunIfOneShot(
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  const { rows, cascade } = await db.transaction(async (tx) => {
    const updated = await tx
      .update(pipelineRuns)
      .set({ status: outcome, finishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(pipelineRuns.id, runId),
          inArray(pipelineRuns.kind, ['pm', 'interactive', 'system']),
          inArray(pipelineRuns.status, ['running', 'paused']),
        ),
      )
      .returning({
        id: pipelineRuns.id,
        projectId: pipelineRuns.projectId,
        issueId: pipelineRuns.issueId,
        kind: pipelineRuns.kind,
        currentStep: pipelineRuns.currentStep,
      });
    const updatedRows = updated ?? [];
    const c =
      updatedRows.length > 0
        ? await cascadeCancelChildJobs(tx, runId, reasonForOutcome(outcome))
        : null;
    return { rows: updatedRows, cascade: c };
  });
  if (cascade)
    await broadcastAbortEvents(cascade.deviceBySession, reasonForOutcome(outcome), runId);
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
): Promise<void> {
  const { rows, cascades } = await db.transaction(async (tx) => {
    const updated = await tx
      .update(pipelineRuns)
      .set({ status: outcome, finishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(pipelineRuns.kind, 'issue'),
          eq(pipelineRuns.issueId, issueId),
          inArray(pipelineRuns.status, ['running', 'paused']),
        ),
      )
      .returning({
        id: pipelineRuns.id,
        projectId: pipelineRuns.projectId,
        issueId: pipelineRuns.issueId,
        kind: pipelineRuns.kind,
        currentStep: pipelineRuns.currentStep,
      });
    const updatedRows = updated ?? [];
    const cs = await Promise.all(
      updatedRows.map(async (r) => ({
        runId: r.id,
        result: await cascadeCancelChildJobs(tx, r.id, reasonForOutcome(outcome)),
      })),
    );
    return { rows: updatedRows, cascades: cs };
  });
  for (const c of cascades) {
    await broadcastAbortEvents(c.result.deviceBySession, reasonForOutcome(outcome), c.runId);
  }
  const cascadedByRun = new Map(cascades.map((c) => [c.runId, c.result.cancelledJobIds]));
  await emitCloseHookPerRow(rows, outcome, cascadedByRun);
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
