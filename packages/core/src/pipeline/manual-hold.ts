/**
 * manualHold-block model.
 *
 * Single decision point for any unrecoverable pipeline failure (worker /fail,
 * lost worker session detected by stuck-watcher / stale-detector, adapter
 * dispatch error). Replaces the previous multi-tier silent retry chain
 * (`retry.ts` exponential backoff + sweeper recovery budget +
 * `pipeline_failed` escalation).
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
import { comments, issues, projects } from '../db/schema.js';
import type { JobType } from '../db/schema.js';
import { logger } from '../logger.js';
import { recordHoldSet } from '../observability/hold-metrics.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

export type ManualHoldTrigger = 'job_failed' | 'session_lost' | 'adapter_error';

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
  /**
   * ISS-198 — explicit auto-clear horizon for this hold. `null` = indefinite
   * (operator must clear). A `Date` schedules the sweeper to auto-clear once
   * `now() > holdUntil` (subject to anti-ping-pong). Required — every caller
   * computes this via {@link computeHoldUntil} so the policy lives in one place.
   */
  holdUntil: Date | null;
}

export interface SetManualHoldBlockInput {
  issueId: string;
  context: IssueFailureContext;
}

/**
 * Set manualHold + failure_context on an issue, post a summary comment, and
 * broadcast `pipeline.decision_required` to the project room. Loads
 * projectId + ownerId from the issue→project join internally so callers
 * (watchers, lifecycle, dispatcher) only need the issueId they already
 * hold. Idempotent: a second call on an already-blocked issue overwrites
 * the context (latest failure wins) without spamming duplicate comments.
 *
 * No-op if the issue does not exist (warning logged); the issue may have
 * been deleted between failure and block.
 */
export async function setManualHoldBlock(input: SetManualHoldBlockInput): Promise<void> {
  const { issueId, context } = input;

  const [row] = await db
    .select({
      manualHold: issues.manualHold,
      projectId: issues.projectId,
      ownerId: projects.ownerId,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, issueId))
    .limit(1);

  if (!row) {
    logger.warn({ issueId }, 'manual-hold: issue not found, skipping block');
    return;
  }

  const { projectId, ownerId, manualHold: wasAlreadyBlocked } = row;

  await db
    .update(issues)
    .set({
      manualHold: true,
      manualHoldUntil: context.holdUntil,
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
      // ISS-198 — emit holdUntil so the UI can render the countdown badge
      // without an extra fetch. ISO string keeps the WS payload JSON-safe.
      holdUntil: context.holdUntil ? context.holdUntil.toISOString() : null,
    },
  });

  logger.warn(
    {
      issueId,
      step: context.step,
      trigger: context.trigger,
      kind: context.classification.kind,
      reason: context.classification.reason,
      holdUntil: context.holdUntil ? context.holdUntil.toISOString() : null,
    },
    'manual-hold: pipeline blocked, operator action required',
  );

  recordHoldSet({
    kind: context.classification.kind,
    indefinite: context.holdUntil === null,
  });
}

function buildBlockComment(ctx: IssueFailureContext): string {
  const actions = ctx.suggestedActions.map((a) => {
    if (a === 'resume') return '**Resume** — retry the same step from current status';
    if (a === 'skip-step') return '**Skip step** — advance status to the next stage and continue';
    return '**Close** — abandon this issue';
  });
  // ISS-198 — surface holdUntil so an operator reading the comment knows
  // whether the system will retry on its own.
  let holdLine: string;
  if (ctx.holdUntil) {
    const iso = ctx.holdUntil.toISOString();
    const minutes = Math.max(1, Math.round((ctx.holdUntil.getTime() - Date.now()) / 60_000));
    holdLine = `**Auto-resume at:** ${iso} (in ${minutes} min)`;
  } else {
    holdLine = '**Auto-resume:** manual only — an operator must resume this issue.';
  }
  return [
    `🛑 **Pipeline blocked at step: \`${ctx.step}\`**`,
    ``,
    `Issue status stays at its current stage — no automatic status change.`,
    `\`manualHold\` was set; the dispatcher will skip this issue until an operator resumes.`,
    ``,
    `**Trigger:** ${ctx.trigger}`,
    `**Classification:** ${ctx.classification.kind} — ${ctx.classification.reason}`,
    `**Attempts before block:** ${ctx.attempts}`,
    holdLine,
    ``,
    `**Available actions:**`,
    ...actions.map((a) => `- ${a}`),
  ].join('\n');
}
