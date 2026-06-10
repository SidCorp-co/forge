/**
 * ISS-238 — Refuse-on-missing-skill guard for the orchestrator.
 *
 * When an auto-stage has its top-level toggle on but no `skill_registrations`
 * row, dispatch is impossible. Instead of silently logging and skipping (the
 * old behaviour, which let issues loop the reconciler rescue path), pause the
 * open `pipeline_run` with a typed reason, surface an operator-facing comment,
 * and emit the existing `pipelineRunStatusChanged` hook so the Sentry
 * breadcrumb subscriber + WS broadcaster fire without new plumbing.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, comments, issues, pipelineRuns, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from './hooks.js';
import { PIPELINE_STEPS } from './registry.js';

export const PAUSE_REASON_PREFIX = 'missing_skill:';

export function buildMissingSkillReason(stage: IssueStatus): string {
  return `${PAUSE_REASON_PREFIX}${stage}`;
}

/**
 * Operator-facing comment body. English-only per the project rule. Mirrors
 * the spec template (Vietnamese in the issue description was translated).
 *
 * The toggle name is resolved from PIPELINE_STEPS so we surface the correct
 * `auto<Job>` key (e.g. `developed` → `autoReview`, not the naive
 * `autoDeveloped`). Falls back to `auto<Stage>` only for unmapped stages.
 */
export function buildMissingSkillCommentBody(stage: IssueStatus): string {
  const step = PIPELINE_STEPS.find((s) => s.status === stage);
  const toggle =
    step?.toggle ?? `auto${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
  return [
    `🛑 **Pipeline halted at stage \`${stage}\`**`,
    '',
    'Reason: stage is enabled in `pipelineConfig` but no skill is registered for it.',
    '',
    'Required action:',
    `- Register a skill for stage \`${stage}\` (via /forge-config or the Skills page), or`,
    `- Disable the \`${toggle}\` toggle in pipelineConfig if this stage should not auto-dispatch.`,
    '',
    'The pipeline will resume automatically once the missing registration is added.',
  ].join('\n');
}

export interface PausePipelineRunMissingSkillInput {
  runId: string;
  projectId: string;
  issueId: string;
  stage: IssueStatus;
  currentStep: string | null;
}

export interface PausePipelineRunMissingSkillResult {
  paused: boolean;
  alreadyPaused: boolean;
}

/**
 * Pause the open issue-run with `metadata.pauseReason = "missing_skill:<stage>"`.
 *
 * - Idempotent via WHERE status='running' (re-entry hits 0 rows updated).
 * - On 0 rows updated, select once to disambiguate `alreadyPaused` (already
 *   carrying the matching reason) vs terminal (we should not have been called).
 * - Emits `pipelineRunStatusChanged` only on the effective pause so the
 *   existing Sentry breadcrumb subscriber fires once per real transition.
 */
export async function pausePipelineRunMissingSkill(
  input: PausePipelineRunMissingSkillInput,
): Promise<PausePipelineRunMissingSkillResult> {
  const reason = buildMissingSkillReason(input.stage);

  const updated = await db
    .update(pipelineRuns)
    .set({
      status: 'paused',
      metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object('pauseReason', ${reason}::text)`,
      updatedAt: new Date(),
    })
    .where(and(eq(pipelineRuns.id, input.runId), eq(pipelineRuns.status, 'running')))
    .returning({ id: pipelineRuns.id });

  if (updated.length > 0) {
    await hooks.emit('pipelineRunStatusChanged', {
      runId: input.runId,
      projectId: input.projectId,
      issueId: input.issueId,
      kind: 'issue',
      fromStatus: 'running',
      toStatus: 'paused',
      currentStep: input.currentStep,
    });
    return { paused: true, alreadyPaused: false };
  }

  // Disambiguate: already paused with the same reason vs terminal vs not found.
  const [row] = await db
    .select({ status: pipelineRuns.status, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, input.runId))
    .limit(1);
  if (!row) return { paused: false, alreadyPaused: false };
  const existingReason =
    typeof (row.metadata as Record<string, unknown> | null)?.pauseReason === 'string'
      ? ((row.metadata as Record<string, unknown>).pauseReason as string)
      : null;
  return {
    paused: false,
    alreadyPaused: row.status === 'paused' && existingReason === reason,
  };
}

/**
 * Insert an operator-facing comment authored by the project creator
 * (`projects.createdBy`, audit-only). FK on `comments.author_id` is satisfied
 * by the creator; no-op when the project has no resolvable creator
 * (defensive — mirrors `budget-check.postBudgetExhaustedComment`).
 */
export async function postMissingSkillComment(args: {
  projectId: string;
  issueId: string;
  stage: IssueStatus;
}): Promise<void> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!row?.createdBy) return;

  try {
    await db.insert(comments).values({
      issueId: args.issueId,
      authorId: row.createdBy,
      body: buildMissingSkillCommentBody(args.stage),
      isAi: true,
    } as never);
  } catch (err) {
    logger.warn(
      { err, issueId: args.issueId, stage: args.stage },
      'missing-skill-guard: failed to post comment, continuing',
    );
  }
}
