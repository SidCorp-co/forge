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
import { type PipelineRunKind, pipelineRuns } from '../db/schema.js';

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
    .where(
      and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])),
    );
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
  await db
    .update(pipelineRuns)
    .set({ status: outcome, finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])),
    );
}

/**
 * Stamp `current_step` on the issue's open run, if one exists. No-op when the
 * issue has no open run (e.g. a status change before the first job has been
 * queued for this issue). Used by the issue state-machine to keep the run
 * timeline in sync with the issue's `status`.
 */
export async function setCurrentStepForOpenIssueRun(
  issueId: string,
  step: string,
): Promise<void> {
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
  await db
    .update(pipelineRuns)
    .set({ status: outcome, finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(pipelineRuns.id, runId),
        inArray(pipelineRuns.kind, ['pm', 'interactive', 'system']),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
    );
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
  await db
    .update(pipelineRuns)
    .set({ status: outcome, finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(pipelineRuns.kind, 'issue'),
        eq(pipelineRuns.issueId, issueId),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
    );
}
