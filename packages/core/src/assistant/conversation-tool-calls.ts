// cm:why the audit row (`chat_logs.tool_calls`) is the only place a call's `ranAs` lives; the transcript blocks a room serves never carried it, so the Context panel reads it here, read-only, rather than the write path growing a second copy of it.

import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db as defaultDb } from '../db/client.js';
import { chatLogs } from '../db/schema.js';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readableConversation } from './conversation-access.js';

/** How many of a room's newest turns a read carries. */
export const TOOL_CALL_TURNS = 200;

/** One audited call as a reader of the room is shown it. */
export interface RoomToolCall {
  turnId: string;
  at: string;
  name: string;
  arguments: string;
  round: number;
  isError: boolean;
  durationMs: number | null;
  /** Null where the call ran as somebody other than this reader. */
  resultPreview: string | null;
  resultIssueRefs: string[];
  /** False on a row audited before `ranAs` was recorded: who it ran as is unknown, not nobody. */
  ranAsRecorded: boolean;
  ranAs: string | null;
  refusalCode: string | null;
}

interface AuditRow {
  id: string;
  createdAt: Date;
  toolCalls: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * The calls of every audited turn, oldest first. A call's result is shown to
 * the person it ran as, or when it ran as nobody; another member's result stays
 * theirs, since it was read with permissions this reader may not hold.
 */
export function roomToolCalls(rows: readonly AuditRow[], readerId: string): RoomToolCall[] {
  const out: RoomToolCall[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.toolCalls)) continue;
    for (const raw of row.toolCalls) {
      if (!raw || typeof raw !== 'object') continue;
      const call = raw as Record<string, unknown>;
      const name = str(call.name);
      if (!name) continue;
      const ranAsRecorded = 'ranAs' in call;
      const ranAs = ranAsRecorded ? str(call.ranAs) : null;
      const own = ranAsRecorded && (ranAs === null || ranAs === readerId);
      out.push({
        turnId: row.id,
        at: row.createdAt.toISOString(),
        name,
        arguments: str(call.arguments) ?? '',
        round: typeof call.round === 'number' ? call.round : 1,
        isError: call.isError === true,
        durationMs: typeof call.durationMs === 'number' ? call.durationMs : null,
        resultPreview: own ? str(call.resultPreview) : null,
        resultIssueRefs: Array.isArray(call.resultIssueRefs)
          ? call.resultIssueRefs.filter((r): r is string => typeof r === 'string')
          : [],
        ranAsRecorded,
        ranAs,
        refusalCode: str(call.refusalCode),
      });
    }
  }
  return out;
}

export async function readRoomToolCalls(
  conversationId: string,
  readerId: string,
  dbi = defaultDb,
): Promise<RoomToolCall[]> {
  const rows = await dbi
    .select({ id: chatLogs.id, createdAt: chatLogs.createdAt, toolCalls: chatLogs.toolCalls })
    .from(chatLogs)
    .where(eq(chatLogs.sessionId, conversationId))
    .orderBy(desc(chatLogs.createdAt))
    .limit(TOOL_CALL_TURNS);
  return roomToolCalls(rows.reverse(), readerId);
}

export const conversationToolCallRoutes = new Hono<{ Variables: AuthVars }>();

conversationToolCallRoutes.get(
  '/:id/tool-calls',
  zValidator('param', z.object({ id: z.uuid() }), (r) => {
    if (!r.success)
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await readableConversation(id, userId);
    return c.json({ conversationId: id, calls: await readRoomToolCalls(id, userId) });
  },
);
