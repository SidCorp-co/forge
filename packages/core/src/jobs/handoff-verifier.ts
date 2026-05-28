/**
 * Lifecycle-time step-handoff verifier (proposal Y).
 *
 * Called from `lifecycle-routes.ts:/complete` immediately after the jobs row
 * has been updated to `status='done'`. Resolves the project's handoff
 * policy from `agentConfig.pipelineConfig.states[<stageStatus>].userPromptPolicy.handoffs`
 * (same path the prompt builder reads). When the policy requires a handoff
 * write, this function:
 *
 *   1. Inspects the agent's last assistant text (passed in by the runner via
 *      `summary` in the /complete body).
 *   2. Looks up the `memories` row that should have been written.
 *   3. Returns a verdict — `ok` to continue with the normal done path, or
 *      a `failure` with `failureKind` / `failureReason` so the caller flips
 *      the row to `status='failed'` and the existing retry / hold machinery
 *      kicks in.
 *
 * Does NOT mutate the jobs row itself — caller decides whether to flip
 * status (keeps the test surface narrow + the side-effect graph explicit).
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type JobType, issueStepContexts, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { isHandoffStep } from '../memory/step-handoff-schema.js';
import { extractStageStatus } from './stage-overrides.js';

export interface HandoffVerifyVerdict {
  ok: boolean;
  failureKind?: 'permanent' | 'transient';
  failureReason?: string;
  /** Sentry breadcrumb category for observability — set on both ok+warn paths. */
  breadcrumb?: string;
}

interface HandoffPolicy {
  enabled: boolean;
  requireHandoffWrite: boolean;
  missingMarkerPolicy: 'fail' | 'warn' | 'silent';
}

const OK: HandoffVerifyVerdict = { ok: true };

async function loadHandoffPolicyForJob(args: {
  projectId: string;
  jobType: JobType;
  payload: unknown;
}): Promise<HandoffPolicy | null> {
  const stageStatus = extractStageStatus(args.payload);
  if (!stageStatus) return null;
  try {
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, args.projectId))
      .limit(1);
    if (!row?.agentConfig) return null;
    const ac = row.agentConfig as Record<string, unknown>;
    const pc = ac.pipelineConfig as Record<string, unknown> | undefined;
    const states = (pc?.states ?? {}) as Record<string, unknown>;
    const stage = states[stageStatus] as Record<string, unknown> | undefined;
    const upp = stage?.userPromptPolicy as Record<string, unknown> | undefined;
    const handoffs = upp?.handoffs as
      | { enabled?: boolean; requireHandoffWrite?: boolean; missingMarkerPolicy?: string }
      | undefined;
    if (!handoffs) return null;
    return {
      enabled: handoffs.enabled === true,
      requireHandoffWrite: handoffs.requireHandoffWrite !== false,
      missingMarkerPolicy:
        handoffs.missingMarkerPolicy === 'fail' || handoffs.missingMarkerPolicy === 'silent'
          ? handoffs.missingMarkerPolicy
          : 'warn',
    };
  } catch (err) {
    logger.warn(
      { err, projectId: args.projectId, jobType: args.jobType },
      'handoff-verifier: loadHandoffPolicy failed; defaulting to no enforcement',
    );
    return null;
  }
}

async function findHandoffRow(args: {
  projectId: string;
  issueId: string;
  step: JobType;
  attempt: number;
}): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: issueStepContexts.id })
    .from(issueStepContexts)
    .where(
      and(
        eq(issueStepContexts.projectId, args.projectId),
        eq(issueStepContexts.issueId, args.issueId),
        eq(issueStepContexts.kind, 'handoff'),
        eq(issueStepContexts.step, args.step),
        eq(issueStepContexts.attempt, args.attempt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Verify that a completed handoff-emitting job actually wrote its handoff
 * row before declaring victory. Returns the verdict; caller mutates the
 * job row + emits hooks based on the result.
 */
export async function verifyHandoffOrSkip(args: {
  projectId: string;
  jobType: JobType;
  issueId: string | null;
  pipelineRunId: string | null;
  attempt: number;
  payload: unknown;
  lastAssistantText: string;
}): Promise<HandoffVerifyVerdict> {
  // Steps that don't emit handoffs (clarify / release / custom / pm) are
  // exempt regardless of policy — there's nothing to verify.
  if (!isHandoffStep(args.jobType)) return OK;

  const policy = await loadHandoffPolicyForJob({
    projectId: args.projectId,
    jobType: args.jobType,
    payload: args.payload,
  });
  if (!policy?.enabled || !policy.requireHandoffWrite) return OK;
  if (!args.issueId || !args.pipelineRunId) {
    // Handoff scope requires an issue + run. Jobs without either bypassed
    // the issue-bound pipeline pathway entirely — don't enforce.
    return OK;
  }

  const lastText = args.lastAssistantText.trim();
  const endsDone = lastText.endsWith('DONE');
  const endsGiveUp = lastText.endsWith('HANDOFF_GIVE_UP');

  if (endsGiveUp) {
    return {
      ok: false,
      failureKind: 'permanent',
      failureReason: 'handoff_validation_failed: agent emitted HANDOFF_GIVE_UP',
      breadcrumb: 'pipeline.handoff_validation_failed',
    };
  }

  if (endsDone) {
    const row = await findHandoffRow({
      projectId: args.projectId,
      issueId: args.issueId,
      step: args.jobType,
      attempt: args.attempt,
    });
    if (!row) {
      return {
        ok: false,
        failureKind: 'permanent',
        failureReason:
          'handoff_not_written: agent emitted DONE but no issue_step_contexts row was found',
        breadcrumb: 'pipeline.handoff_not_written',
      };
    }
    return { ok: true, breadcrumb: 'pipeline.handoff_written_ok' };
  }

  // Neither DONE nor HANDOFF_GIVE_UP — branch on policy.
  switch (policy.missingMarkerPolicy) {
    case 'fail':
      return {
        ok: false,
        failureKind: 'permanent',
        failureReason: `handoff_no_done_marker: last text did not end with DONE or HANDOFF_GIVE_UP (got ${JSON.stringify(lastText.slice(-80))})`,
        breadcrumb: 'pipeline.handoff_no_done_marker',
      };
    case 'warn':
      logger.warn(
        {
          projectId: args.projectId,
          issueId: args.issueId,
          runId: args.pipelineRunId,
          step: args.jobType,
          attempt: args.attempt,
          tail: lastText.slice(-80),
        },
        'handoff-verifier: missing DONE marker (warn mode — finalizing anyway)',
      );
      return { ok: true, breadcrumb: 'pipeline.handoff_marker_missing' };
    case 'silent':
      return OK;
  }
}
