/**
 * ISS-1030 — `POST /api/agent-sessions/:id/events`: the raw stream-json lines a
 * chat turn produced, delivered by the device that produced them.
 *
 * This is the chat path's answer to `POST /api/jobs/:id/events`. It exists
 * because chat never touches the `jobs` table (`transport/agent_sessions.rs`),
 * so a chat turn has no job row to hang events off, and without a carrier the
 * runner had to build the transcript itself in Rust — which is why every tool
 * frame a chat turn ever produced was thrown away.
 *
 * The runner does not parse here. It numbers lines and posts them; core folds
 * them with `jobs/session-transcript.ts`, the same reducer the pipeline path
 * uses.
 */

import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { agentSessionEvents } from '../db/schema-agent-session-events.js';
import { maybeDeriveIncrementalFor } from '../jobs/session-transcript.js';
import type { AuthVars } from '../middleware/auth.js';
import {
  assertDeviceOwnsSession,
  badRequest,
  forbidden,
  idParamSchema,
  loadSessionOr404,
} from './session-access.js';

/** How many lines one POST may carry, matching the runner's own chunking. */
const MAX_BATCH = 100;

const eventInputSchema = z
  .object({
    seq: z.number().int().min(1),
    kind: z.literal('stdout'),
    data: z.record(z.string(), z.unknown()),
    ts: z.iso.datetime().optional(),
  })
  .strict();

const eventBatchSchema = z
  .object({
    events: z.array(eventInputSchema).min(1).max(MAX_BATCH),
  })
  .strict();

type LineEvent = z.infer<typeof eventInputSchema>;

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

/**
 * Why core cannot represent this line, or null when it can.
 *
 * "Cannot represent" is not "this frame carries nothing the transcript shows".
 * A `stream_event`, or a frame kind the CLI adds tomorrow, is a line the fold
 * knowingly folds to nothing and it is stored as it arrived. What is refused is
 * a payload the fold would DROP WITHOUT A TRACE: `applyEventsToState` skips a
 * null `data.line` on sight, and `parseStreamMessages` answers `{messages:[]}`
 * for anything that is not an object with a `type`. Stored, those look exactly
 * like a quiet turn.
 */
function unrepresentable(event: LineEvent): string | null {
  const line = (event.data as { line?: unknown }).line;
  if (line === undefined || line === null) {
    return 'carries no `data.line`; the fold skips such a row on sight, so it would be stored and never read';
  }
  if (typeof line !== 'object' || Array.isArray(line)) {
    return `has a \`data.line\` of type ${Array.isArray(line) ? 'array' : typeof line}; a stream-json line is a JSON object`;
  }
  const type = (line as { type?: unknown }).type;
  if (typeof type !== 'string' || type.length === 0) {
    return 'has a `data.line` with no `type` string; every stream-json frame names its own type and the parser reads nothing else first';
  }
  return null;
}

/** The first thing wrong with this batch, phrased so the runner can log it. */
function refusalFor(events: LineEvent[]): { seq: number; why: string } | null {
  const seen = new Set<number>();
  for (const event of events) {
    if (seen.has(event.seq)) {
      return {
        seq: event.seq,
        why: 'appears twice in one batch; a seq is one line for the life of a session',
      };
    }
    seen.add(event.seq);
    const why = unrepresentable(event);
    if (why) return { seq: event.seq, why };
  }
  return null;
}

export const agentSessionEventsRoutes = new Hono<{ Variables: AuthVars }>();

agentSessionEventsRoutes.post(
  '/:id/events',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', eventBatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: sessionId } = c.req.valid('param');
    const { events } = c.req.valid('json');

    if (!c.get('deviceId'))
      throw forbidden('only the device running this session may post its lines');

    const session = await loadSessionOr404(sessionId);
    assertDeviceOwnsSession(c, session);
    if ((terminalAgentSessionStatuses as readonly string[]).includes(session.status)) {
      throw conflict('agent session is in a terminal state', 'SESSION_TERMINATED');
    }

    const refusal = refusalFor(events);
    if (refusal) {
      throw new HTTPException(400, {
        message: `stream-json line at seq ${refusal.seq} ${refusal.why}`,
        cause: { code: 'UNREPRESENTABLE_LINE', details: refusal },
      });
    }

    const inserted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`);
      const claimed = await tx
        .select({ seq: agentSessionEvents.seq, kind: agentSessionEvents.kind })
        .from(agentSessionEvents)
        .where(
          and(
            eq(agentSessionEvents.agentSessionId, sessionId),
            inArray(
              agentSessionEvents.seq,
              events.map((e) => e.seq),
            ),
          ),
        );
      const taken = claimed.find((row) => row.kind !== 'stdout');
      if (taken) {
        throw conflict(
          `seq ${taken.seq} is already held by a \`${taken.kind}\` row core wrote; this turn's lines were numbered from a base that is no longer free`,
          'SEQ_TAKEN_BY_CORE',
        );
      }
      return tx
        .insert(agentSessionEvents)
        .values(
          events.map((e) => ({
            agentSessionId: sessionId,
            kind: e.kind,
            data: e.data,
            seq: e.seq,
            ...(e.ts ? { ts: new Date(e.ts) } : {}),
          })),
        )
        .onConflictDoNothing({
          target: [agentSessionEvents.agentSessionId, agentSessionEvents.seq],
        })
        .returning({ seq: agentSessionEvents.seq });
    });

    void maybeDeriveIncrementalFor({ kind: 'chat' }, sessionId, events.length);

    return c.json(
      {
        accepted: inserted.length,
        duplicates: events.length - inserted.length,
        firstSeq: events[0]?.seq ?? null,
        lastSeq: events[events.length - 1]?.seq ?? null,
      },
      200,
    );
  },
);
