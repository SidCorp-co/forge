/**
 * manualHold-block model.
 *
 * Single decision point for any unrecoverable pipeline failure (worker /fail,
 * watchdog kill, adapter dispatch error). Replaces the previous multi-tier
 * silent retry chain (`retry.ts` exponential backoff + sweeper recovery
 * budget + `pipeline_failed` escalation).
 *
 * Semantics:
 *   - Issue.status STAYS at the current step (no mutation by failure logic).
 *   - Issue.manual_hold = true → dispatcher L1 short-circuits with skip
 *     reason 'manual_hold' → no new automation jobs spawn.
 *   - Issue.failure_context = jsonb with classification + evidence so the
 *     operator UI can render the failure card.
 *   - WS event 'pipeline.decision_required' fires so subscribers (web UI,
 *     dev app) update without polling.
 *   - One issue comment posted summarizing the block reason.
 *
 * Operator action (clearing manualHold via /resume or /skip-step API) is
 * the ONLY thing that re-enables dispatch. There is no auto-recovery.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import type { JobType } from '../db/schema.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

export type ManualHoldTrigger = 'job_failed' | 'watchdog_kill' | 'adapter_error';

export type FailureClassificationKind =
  | 'transient_network'
  | 'permanent_invalid'
  | 'unknown';

export interface IssueFailureContext {
  /** Pipeline step at which the failure happened (job type). */
  step: JobType;
  /** What triggered the block. */
  trigger: ManualHoldTrigger;
  /** Classification + raw evidence for the operator UI. */
  classification: {
    kind: FailureClassificationKind;
    reason: string;
    evidence: Record<string, unknown>;
  };
  /** Total attempts the system made before blocking (includes auto_retry_once if any). */
  attempts: number;
  /** ISO timestamp of the failure that caused the block. */
  lastFailureAt: string;
  /** Pre-computed action menu the UI renders. Order = display order. */
  suggestedActions: Array<'resume' | 'skip-step' | 'close'>;
}

export interface SetManualHoldBlockInput {
  issueId: string;
  projectId: string;
  ownerId: string;
  context: IssueFailureContext;
}

/**
 * Set manualHold + failure_context on an issue, post a summary comment, and
 * broadcast `pipeline.decision_required` to the project room. Idempotent:
 * a second call on an already-blocked issue overwrites the context (latest
 * failure wins) without spamming duplicate comments.
 */
export async function setManualHoldBlock(input: SetManualHoldBlockInput): Promise<void> {
  const { issueId, projectId, ownerId, context } = input;

  const [existing] = await db
    .select({ manualHold: issues.manualHold })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const wasAlreadyBlocked = existing?.manualHold === true;

  await db
    .update(issues)
    .set({
      manualHold: true,
      failureContext: context as never,
      updatedAt: new Date(),
    })
    .where(eq(issues.id, issueId));

  if (!wasAlreadyBlocked) {
    try {
      await db.insert(comments).values({
        issueId,
        authorId: ownerId,
        body: buildBlockComment(context),
        isAi: true,
      } as never);
    } catch (err) {
      logger.warn(
        { err, issueId },
        'manual-hold: failed to post block comment, continuing',
      );
    }
  }

  roomManager.publish(projectRoom(projectId), {
    event: 'pipeline.decision_required',
    data: {
      issueId,
      step: context.step,
      trigger: context.trigger,
      classification: context.classification,
      attempts: context.attempts,
    },
  });

  logger.warn(
    {
      issueId,
      step: context.step,
      trigger: context.trigger,
      kind: context.classification.kind,
      reason: context.classification.reason,
    },
    'manual-hold: pipeline blocked, operator action required',
  );
}

function buildBlockComment(ctx: IssueFailureContext): string {
  const actions = ctx.suggestedActions.map((a) => {
    if (a === 'resume') return '**Resume** — retry the same step from current status';
    if (a === 'skip-step') return '**Skip step** — advance status to the next stage and continue';
    return '**Close** — abandon this issue';
  });
  return [
    `🛑 **Pipeline blocked at step: \`${ctx.step}\`**`,
    ``,
    `Issue status stays at its current stage — no automatic status change.`,
    `\`manualHold\` was set; the dispatcher will skip this issue until an operator resumes.`,
    ``,
    `**Trigger:** ${ctx.trigger}`,
    `**Classification:** ${ctx.classification.kind} — ${ctx.classification.reason}`,
    `**Attempts before block:** ${ctx.attempts}`,
    ``,
    `**Available actions:**`,
    ...actions.map((a) => `- ${a}`),
  ].join('\n');
}
