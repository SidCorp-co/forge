// A secret a room kept as written (ISS-1353): a member's message the screen did not catch held a
// credential, and `support_actions.input.text` served it to every reader of the room's record. A
// person holding project admin redacts it here, naming the action: its text becomes `[Filtered]` on
// the room's record and in its thread's conversation, in one transaction with the record of who did
// it and why. The value is never read back, compared or answered; nothing else of the message moves.

import { supportRedactRequestSchema } from '@forge/contracts/support';
import { FILTERED, scrubLogText } from '@forge/observability';
import { and, eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { redactInboundContent } from '../conversations/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { no, type Outcome } from './outcome.js';
import { insertAction } from './store.js';

export interface Redacted {
  action: string;
  message: string | null;
  redactedBy: string;
  at: string;
}

/** The member message `actionId` names in room `roomId` of project `projectId`, redacted by `userId`. */
export async function redactMemberMessage(input: {
  projectId: string;
  roomId: string;
  actionId: string;
  userId: string;
  reason: string;
}): Promise<Outcome<Redacted>> {
  return db.transaction(async (tx) => {
    const [held] = await tx
      .select({
        id: supportActions.id,
        thread: supportActions.thread,
        conversationId: supportActions.conversationId,
        externalId: supportActions.externalId,
        text: sql<string | null>`${supportActions.input}->>'text'`,
      })
      .from(supportActions)
      .where(
        and(
          eq(supportActions.id, input.actionId),
          eq(supportActions.roomId, input.roomId),
          eq(supportActions.projectId, input.projectId),
          eq(supportActions.kind, 'message_in'),
          eq(supportActions.actorKind, 'member'),
        ),
      )
      .for('update')
      .limit(1);
    if (!held) {
      return no(
        'SUPPORT_ACTION_UNKNOWN',
        '/actionId',
        `room ${input.roomId} of this project holds no member message ${input.actionId}; name a message_in action a member wrote, as the room's actions read lists it. Nothing was redacted.`,
      );
    }
    if (held.text === FILTERED) {
      return no(
        'SUPPORT_ACTION_REDACTED',
        '/actionId',
        `message ${input.actionId} already reads ${FILTERED} on the room's record; nothing was changed.`,
      );
    }
    await tx
      .update(supportActions)
      .set({
        input: sql`jsonb_set(${supportActions.input}, '{text}', ${JSON.stringify(FILTERED)}::jsonb)`,
      })
      .where(eq(supportActions.id, held.id));
    if (held.conversationId && held.externalId) {
      await redactInboundContent(tx, {
        conversationId: held.conversationId,
        externalId: held.externalId,
        content: FILTERED,
      });
    }
    const at = new Date();
    await insertAction(
      {
        roomId: input.roomId,
        projectId: input.projectId,
        conversationId: held.conversationId,
        thread: held.thread,
        kind: 'secret_redacted',
        // core made the act; the Forge account that asked for it is the record's `by`
        actorKind: 'core',
        input: { action: held.id, message: held.externalId, reason: scrubLogText(input.reason) },
        output: { by: input.userId, at: at.toISOString() },
      },
      tx,
    );
    return {
      ok: true,
      value: {
        action: held.id,
        message: held.externalId,
        redactedBy: input.userId,
        at: at.toISOString(),
      },
    };
  });
}

/** `POST /api/projects/:id/support/rooms/:roomId/actions/:actionId/redaction`, a project admin's act. */
export function mountRedactRoute(routes: Hono<{ Variables: AuthVars }>): void {
  routes.post(
    '/:id/support/rooms/:roomId/actions/:actionId/redaction',
    zValidator(
      'param',
      z.object({ id: z.uuid(), roomId: z.uuid(), actionId: z.uuid() }),
      invalid(
        'invalid path: a project uuid, a support room uuid (its `id` in GET /api/projects/:id/support/rooms, never its `rid`) and an action uuid',
      ),
    ),
    requiresOnParam('project.admin', 'id'),
    strictBody(supportRedactRequestSchema, '{ reason }'),
    async (c) => {
      const { id, roomId, actionId } = c.req.valid('param');
      const outcome = await redactMemberMessage({
        projectId: id,
        roomId,
        actionId,
        userId: c.get('userId'),
        reason: c.req.valid('json').reason,
      });
      if (!outcome.ok) return refused(c, outcome.refusals, 'SUPPORT_REFUSED');
      return c.json(outcome.value);
    },
  );
}
