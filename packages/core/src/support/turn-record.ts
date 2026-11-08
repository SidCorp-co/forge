// A room session's record of one turn, beside the room's action log (ISS-1029). Each action a turn
// took names its session and turn (`turn-of-act.ts`); this read opens that turn: every tool the
// session called and what it was answered, and what it said, in order, scrubbed as any room text is
// and read only by the project's people. With it, "it found the cause before it replied" (REQ-77
// BC-7) is judged on what the turn read, not on the reply alone.

import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { boxTurnOfToken, turnStdoutLines } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requireDeclaredOn, requiresOnParam } from '../permissions/index.js';
import { type RoomRow, roomById } from './store.js';
import { scrubbedForRoom } from './thread.js';

/** One step of a turn as a reader sees it. */
type TurnStep =
  | { kind: 'called'; tool: string; input: string }
  | { kind: 'answered'; text: string }
  | { kind: 'said'; text: string };

/** How much of one tool answer a reader is shown; the rest is cut and says so. */
const ANSWER_SHOWN = 4_000;

const turnParam = zValidator(
  'param',
  z.object({ id: z.uuid(), roomId: z.uuid(), turnId: z.uuid() }),
  invalid('invalid path: a project uuid, a support room uuid and a turn uuid'),
);

const cut = (text: string, at: number) =>
  text.length > at ? `${text.slice(0, at)} [cut: ${text.length - at} more characters]` : text;

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : ''))
          .join('\n')
      : '';

/** The steps of one stream-json line: an assistant's text and calls, a tool's answers. */
function stepsOf(line: unknown): TurnStep[] {
  const l = line as { type?: unknown; message?: { content?: unknown } } | null;
  const blocks = Array.isArray(l?.message?.content)
    ? (l.message.content as Record<string, unknown>[])
    : [];
  if (l?.type === 'assistant') {
    return blocks.flatMap((b): TurnStep[] =>
      b.type === 'text'
        ? [{ kind: 'said', text: String(b.text ?? '') }]
        : b.type === 'tool_use'
          ? [{ kind: 'called', tool: String(b.name ?? ''), input: JSON.stringify(b.input ?? {}) }]
          : [],
    );
  }
  if (l?.type === 'user') {
    return blocks.flatMap((b): TurnStep[] =>
      b.type === 'tool_result'
        ? [{ kind: 'answered', text: cut(textOf(b.content), ANSWER_SHOWN) }]
        : [],
    );
  }
  return [];
}

async function scrubbed(room: RoomRow, step: TurnStep): Promise<TurnStep> {
  if (step.kind === 'called') return { ...step, input: await scrubbedForRoom(room, step.input) };
  return { ...step, text: await scrubbedForRoom(room, step.text) };
}

/** The turn a room's action names, read for a project reader; null when no action of the room names it. */
export async function turnRecordOf(
  viewer: string,
  projectId: string,
  roomId: string,
  turnId: string,
) {
  await requireDeclaredOn(projectId, viewer, 'project.read');
  const room = await roomById(roomId);
  if (!room || room.projectId !== projectId) return null;
  const [named] = await db
    .select({ sessionId: supportActions.sessionId })
    .from(supportActions)
    .where(and(eq(supportActions.roomId, room.id), eq(supportActions.turnId, turnId)))
    .limit(1);
  const span = named?.sessionId ? await boxTurnOfToken(turnId) : null;
  if (!span || span.sessionId !== named?.sessionId) return null;
  const { lines, cut: more } = await turnStdoutLines(
    span.sessionId,
    span.startedAt,
    span.endedAt ?? new Date(),
  );
  const steps = await Promise.all(
    lines
      .flatMap((data) => stepsOf((data as { line?: unknown } | null)?.line))
      .map((s) => scrubbed(room, s)),
  );
  return {
    sessionId: span.sessionId,
    turnId,
    startedAt: span.startedAt.toISOString(),
    endedAt: span.endedAt?.toISOString() ?? null,
    steps,
    cut: more,
  };
}

/** `GET /:id/support/rooms/:roomId/turns/:turnId`: the turn an action of the room names. */
export function mountTurnRecordRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.get(
    '/:id/support/rooms/:roomId/turns/:turnId',
    turnParam,
    requiresOnParam('project.read', 'id'),
    noQuery,
    async (c) => {
      const { id, roomId, turnId } = c.req.valid('param');
      const turn = await turnRecordOf(c.get('userId'), id, roomId, turnId);
      if (!turn) {
        return refused(
          c,
          [
            {
              code: 'SUPPORT_TURN_UNKNOWN',
              path: '/turnId',
              detail: `no action of support room ${roomId} in this project names turn ${turnId}; a turn is read by the turnId an action of the room carries`,
            },
          ],
          'SUPPORT_REFUSED',
        );
      }
      return c.json({ turn });
    },
  );
}
