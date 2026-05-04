import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { type IssueStatus, comments, issues } from '../../db/schema.js';
import { applyStatusTransition } from '../../issues/apply-transition.js';
import { hooks } from '../../pipeline/hooks.js';
import {
  type DeviceScopedMcpToolFactory,
  assertPmActor,
  zodToMcpSchema,
} from './lib.js';

/**
 * `forge_pm.flag_blocker` (Epic 3, ISS-19) — PM-agent posts a blocker
 * comment on an issue. When `severity='high'`, additionally moves the
 * issue to `on_hold` via the shared state-machine helper so the same
 * `transition` hook + WS broadcast fire as for a manual transition.
 *
 * Idempotent on already-on-hold issues; closed issues cannot be put on
 * hold (returns `transitioned: false` with reason).
 */

const inputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid(),
    severity: z.enum(['low', 'medium', 'high']),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export const forgePmFlagBlockerTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_pm.flag_blocker',
  description:
    'PM agent records a blocker on an issue (low/medium/high). Writes a comment; severity=high also transitions the issue to on_hold via the state machine. Requires PM-actor capability.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertPmActor(device, input.projectId);

    const [issue] = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        status: issues.status,
        reopenCount: issues.reopenCount,
      })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .limit(1);
    if (!issue) throw new Error('NOT_FOUND: issue not found');
    if (issue.projectId !== input.projectId) {
      throw new Error('BAD_REQUEST: issue belongs to a different project');
    }

    const body = `**PM blocker flagged** (severity: ${input.severity})\n\n${input.reason}`;
    const [inserted] = await db
      .insert(comments)
      .values({
        issueId: input.issueId,
        authorId: device.ownerId,
        body,
        parentId: null,
      })
      .returning({
        id: comments.id,
        issueId: comments.issueId,
        body: comments.body,
        parentId: comments.parentId,
      });
    if (!inserted) throw new Error('forge_pm.flag_blocker: comment insert returned no row');

    await hooks.emit('commentCreated', {
      issueId: input.issueId,
      projectId: input.projectId,
      actor: { type: 'device', id: device.id },
      commentId: inserted.id,
      body: inserted.body,
      parentId: inserted.parentId,
    });

    // Comment was just persisted; if we throw from the transition the caller
    // will retry and duplicate the comment. So errors from the state machine
    // (illegal transition, stale concurrent update) are surfaced as
    // `transitioned:false + blockedReason` rather than re-thrown.
    let transitioned = false;
    let blockedReason: string | null = null;
    if (input.severity === 'high') {
      if (issue.status === 'on_hold') {
        // already paused — nothing more to do
      } else if (issue.status === 'closed') {
        blockedReason = 'cannot_hold_closed_issue';
      } else {
        try {
          await applyStatusTransition(
            {
              id: issue.id,
              projectId: issue.projectId,
              status: issue.status as IssueStatus,
              reopenCount: issue.reopenCount,
            },
            'on_hold',
            device,
          );
          transitioned = true;
        } catch (err) {
          blockedReason =
            err instanceof Error
              ? `transition_failed: ${err.message.split(':')[0] ?? 'UNKNOWN'}`
              : 'transition_failed';
        }
      }
    }

    return {
      commentId: inserted.id,
      transitioned,
      ...(blockedReason ? { blockedReason } : {}),
    };
  },
});
