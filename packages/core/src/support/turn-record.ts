// A room session's record of one turn, beside the room's action log (ISS-1029). Each action a turn
// took names its session and turn (`turn-of-act.ts`); this read opens that turn: every tool the
// session called and what it was answered, and what it said, in order, scrubbed as any room text is
// and read only by the project's people. With it, "it found the cause before it replied" (REQ-77
// BC-7) is judged on what the turn read, not on the reply alone. The binding's owner project lists a
// room's turns by thread, and reads with each what started it and what it posted (REQ-92 BC-1, ISS-1118).

import { SUPPORT_ROUTING_DECISIONS, type SupportRoutingDecision } from '@forge/contracts/support';
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { turnStdoutLines } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requireDeclaredOn, requiresOnParam } from '../permissions/index.js';
import { sessionTurnSpan } from './session-turns.js';
import { type ActionRow, type RoomRow, roomById } from './store.js';
import { scrubbedForRoom } from './thread.js';

/** One step of a turn as a reader sees it. */
type TurnStep =
  | { kind: 'called'; tool: string; input: string }
  | { kind: 'answered'; text: string }
  | { kind: 'said'; text: string }
  /**
   * How the turn ended (ISS-1268): the result's `terminal_reason` (`completed`, or
   * `aborted_streaming` where a person stopped it) and its `modelUsage`, what each model spent.
   */
  | { kind: 'ended'; reason: string | null; models: Record<string, ModelSpend> };

/** One model's share of a turn, as its result's `modelUsage` names it. */
interface ModelSpend {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  contextWindow: number | null;
}

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** The result's `modelUsage`, by model. */
function spendOf(raw: unknown): Record<string, ModelSpend> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, Record<string, unknown> | null>).map(([model, u]) => [
      model,
      {
        inputTokens: count(u?.inputTokens),
        outputTokens: count(u?.outputTokens),
        costUsd: count(u?.costUSD),
        contextWindow: count(u?.contextWindow),
      },
    ]),
  );
}

/** How much of one tool answer a reader is shown; the rest is cut and says so. */
const ANSWER_SHOWN = 4_000;

const roomParam = zValidator(
  'param',
  z.object({ id: z.uuid(), roomId: z.uuid() }),
  invalid(
    'invalid path: a project uuid and a support room uuid (its `id` in GET /api/projects/:id/support/rooms, never its `rid`)',
  ),
);

/** Why a room's turns cannot be read here: none held, or a shared one its home project holds (ISS-1439). */
async function unknownRoomDetail(projectId: string, roomId: string): Promise<string> {
  const room = await roomById(roomId);
  if (room && room.projectId !== projectId) {
    return `room ${roomId} is an operations room project ${room.projectId} holds and this project only posts in; read its turns under that project (GET /api/projects/${room.projectId}/support/rooms/${roomId}/turns)`;
  }
  return `this project holds no support room ${roomId}`;
}

/** At most this many turns are listed, newest first. */
const TURNS_LISTED = 50;

const turnsQuery = zValidator(
  'query',
  z.strictObject({ thread: z.string().min(1).max(200).optional() }),
  invalid("invalid query: thread is the id of one of the room's threads"),
);

const turnParam = zValidator(
  'param',
  z.object({ id: z.uuid(), roomId: z.uuid(), turnId: z.uuid() }),
  invalid(
    'invalid path: a project uuid, a support room uuid (its `id` in GET /api/projects/:id/support/rooms, never its `rid`) and a turn uuid',
  ),
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
  if (l?.type === 'result') {
    const r = line as { terminal_reason?: unknown; modelUsage?: unknown };
    const reason = typeof r.terminal_reason === 'string' ? r.terminal_reason : null;
    return [{ kind: 'ended', reason, models: spendOf(r.modelUsage) }];
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
  if (step.kind === 'ended') return step;
  if (step.kind === 'called') return { ...step, input: await scrubbedForRoom(room, step.input) };
  return { ...step, text: await scrubbedForRoom(room, step.text) };
}

/** One turn of a room as its list shows it: the threads it acted in, its tools, and what it posted. */
export interface RoomTurnLine {
  id: string;
  sessionId: string;
  threads: string[];
  tools: string[];
  replied: boolean;
  refused: boolean;
  /**
   * The last routing decision the turn recorded (ISS-1243); null where it recorded none, which is
   * "no decision recorded", never a silence.
   */
  decision: SupportRoutingDecision | null;
  firstAt: string;
  lastAt: string;
}

/**
 * A room's routing decisions counted (ISS-1243): each decision its turns recorded, by kind, and the
 * turns that recorded none, so misrouting and silence are measured, not inferred.
 */
export type RoomDecisionCounts = Record<SupportRoutingDecision, number> & {
  undecidedTurns: number;
};

/**
 * The turns of a room, newest first, each as the actions it took name it (`turn-of-act.ts`); with
 * `thread`, the turns that acted in it. Null for a room the project does not hold.
 */
export async function roomTurnsOf(
  viewer: string,
  projectId: string,
  roomId: string,
  thread?: string,
): Promise<RoomTurnLine[] | null> {
  await requireDeclaredOn(projectId, viewer, 'project.read');
  const room = await roomById(roomId);
  if (!room || room.projectId !== projectId) return null;
  const a = supportActions;
  const inThread = turnsInThread(room.id, thread);
  const rows = await db
    .select({
      id: a.turnId,
      sessionId: a.sessionId,
      threads: sql<string[]>`array_agg(DISTINCT ${a.thread})`,
      tools: sql<string[]>`array_remove(array_agg(DISTINCT ${a.tool}), NULL)`,
      replied: sql<boolean>`bool_or(${a.kind} = 'reply')`,
      refused: sql<boolean>`bool_or(${a.kind} = 'refused')`,
      decision: sql<SupportRoutingDecision | null>`(array_agg(${a.input}->>'decision' ORDER BY ${a.createdAt} DESC) FILTER (WHERE ${a.kind} = 'routing_decided'))[1]`,
      firstAt: sql<Date>`min(${a.createdAt})`.mapWith((v) => new Date(v)),
      lastAt: sql<Date>`max(${a.createdAt})`.mapWith((v) => new Date(v)),
    })
    .from(a)
    .where(and(eq(a.roomId, room.id), isNotNull(a.turnId), isNotNull(a.sessionId), inThread))
    .groupBy(a.turnId, a.sessionId)
    .orderBy(desc(sql`min(${a.createdAt})`))
    .limit(TURNS_LISTED);
  return rows.map((r) => ({
    id: String(r.id),
    sessionId: String(r.sessionId),
    threads: r.threads,
    tools: r.tools,
    replied: r.replied,
    refused: r.refused,
    decision: r.decision ?? null,
    firstAt: r.firstAt.toISOString(),
    lastAt: r.lastAt.toISOString(),
  }));
}

/** The turns that acted in a thread of the room, as a filter on its actions; none without a thread. */
function turnsInThread(roomId: string, thread: string | undefined) {
  const a = supportActions;
  return thread
    ? inArray(
        a.turnId,
        db
          .select({ id: a.turnId })
          .from(a)
          .where(and(eq(a.roomId, roomId), eq(a.thread, thread), isNotNull(a.turnId))),
      )
    : undefined;
}

/**
 * Every routing decision a room's turns recorded, counted by decision, and the turns that recorded
 * none (ISS-1243); with `thread`, over the turns that acted in it.
 */
export async function roomDecisionCounts(
  roomId: string,
  thread?: string,
): Promise<RoomDecisionCounts> {
  const a = supportActions;
  const turns = db
    .select({
      decided: sql<number>`count(*) FILTER (WHERE ${a.kind} = 'routing_decided')`.as('decided'),
    })
    .from(a)
    .where(
      and(
        eq(a.roomId, roomId),
        isNotNull(a.turnId),
        isNotNull(a.sessionId),
        turnsInThread(roomId, thread),
      ),
    )
    .groupBy(a.turnId, a.sessionId)
    .as('turns');
  const [undecided] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(turns)
    .where(sql`${turns.decided} = 0`);
  const decided = await db
    .select({ decision: sql<string>`${a.input}->>'decision'`, n: sql<number>`count(*)::int` })
    .from(a)
    .where(
      and(
        eq(a.roomId, roomId),
        eq(a.kind, 'routing_decided'),
        isNotNull(a.turnId),
        turnsInThread(roomId, thread),
      ),
    )
    .groupBy(sql`${a.input}->>'decision'`);
  const counts = Object.fromEntries(SUPPORT_ROUTING_DECISIONS.map((d) => [d, 0])) as Record<
    SupportRoutingDecision,
    number
  >;
  for (const row of decided) {
    if ((SUPPORT_ROUTING_DECISIONS as readonly string[]).includes(row.decision)) {
      counts[row.decision as SupportRoutingDecision] = row.n;
    }
  }
  return { ...counts, undecidedTurns: undecided?.n ?? 0 };
}

/** A message that started a turn, or was written into it while it ran. */
interface TurnTrigger {
  thread: string;
  from: string | null;
  text: string;
  path: string;
  at: string;
}

/** How long before its turn was opened a turn's messages can have been claimed (`dispatch.ts:handOn`). */
const CLAIM_BEFORE_TURN_MS = 60_000;

const textIn = (v: unknown) =>
  v && typeof v === 'object' && 'text' in v ? String((v as { text: unknown }).text) : '';

/**
 * The messages a turn was handed: the claim that started it (`start` or `send`, the room's last
 * before the turn was opened) and each one written into it while it ran (`inject`). A turn whose
 * claim was another room's (a channel agent's session answers several) holds none of this room's.
 */
async function triggerOf(room: RoomRow, span: { startedAt: Date; endedAt: Date | null }) {
  const a = supportActions;
  const path = sql<string>`${a.output}->>'path'`;
  const from = new Date(span.startedAt.getTime() - CLAIM_BEFORE_TURN_MS);
  const until = span.endedAt ?? new Date();
  const handed = await db
    .select()
    .from(a)
    .where(
      and(
        eq(a.roomId, room.id),
        eq(a.kind, 'message_in'),
        gte(a.deliveredAt, from),
        lte(a.deliveredAt, until),
        sql`${path} IN ('start', 'send', 'inject')`,
      ),
    )
    .orderBy(asc(a.createdAt));
  const pathOf = (r: ActionRow) => (r.output as { path?: string } | null)?.path ?? '';
  const claims = handed.filter(
    (r) => pathOf(r) !== 'inject' && r.deliveredAt && r.deliveredAt <= span.startedAt,
  );
  const claimedAt = Math.max(0, ...claims.map((r) => r.deliveredAt?.getTime() ?? 0));
  return handed
    .filter((r) =>
      pathOf(r) === 'inject'
        ? r.deliveredAt && r.deliveredAt >= span.startedAt
        : r.deliveredAt?.getTime() === claimedAt,
    )
    .map(
      (r): TurnTrigger => ({
        thread: r.thread,
        from: r.actorLabel,
        text: textIn(r.input),
        path: pathOf(r),
        at: r.createdAt.toISOString(),
      }),
    );
}

/** What a turn did in the room, as each action recorded it: its replies, refusals and tool acts. */
async function actsOf(room: RoomRow, turnId: string) {
  const rows = await db
    .select()
    .from(supportActions)
    .where(and(eq(supportActions.roomId, room.id), eq(supportActions.turnId, turnId)))
    .orderBy(asc(supportActions.createdAt));
  return rows.map((r) => ({
    kind: r.kind,
    thread: r.thread,
    tool: r.tool,
    input: r.input,
    output: r.output,
    at: r.createdAt.toISOString(),
  }));
}

/**
 * What a turn decided for the messages it was handed (ISS-1243): each routing decision it recorded,
 * in order; a turn that recorded none reads "no decision recorded", whatever else it did, never a
 * silence.
 */
function routingOf(acts: Awaited<ReturnType<typeof actsOf>>) {
  const decisions = acts
    .filter((a) => a.kind === 'routing_decided')
    .map((a) => ({ thread: a.thread, ...(a.input as Record<string, unknown>), at: a.at }));
  return decisions.length > 0
    ? { recorded: true as const, decisions }
    : { recorded: false as const, decisions, reads: 'no decision recorded' as const };
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
  const span = named?.sessionId ? await sessionTurnSpan(turnId) : null;
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
  const [trigger, acts] = await Promise.all([triggerOf(room, span), actsOf(room, turnId)]);
  return {
    routing: routingOf(acts),
    sessionId: span.sessionId,
    turnId,
    startedAt: span.startedAt.toISOString(),
    endedAt: span.endedAt?.toISOString() ?? null,
    trigger,
    steps,
    acts,
    cut: more,
  };
}

/** `GET /:id/support/rooms/:roomId/turns[/:turnId]`: a room's turns, and the turn an action of the room names. */
export function mountTurnRecordRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.get(
    '/:id/support/rooms/:roomId/turns',
    roomParam,
    requiresOnParam('project.read', 'id'),
    turnsQuery,
    async (c) => {
      const { id, roomId } = c.req.valid('param');
      const turns = await roomTurnsOf(c.get('userId'), id, roomId, c.req.valid('query').thread);
      if (!turns) {
        return refused(
          c,
          [
            {
              code: 'SUPPORT_ROOM_UNKNOWN',
              path: '/roomId',
              detail: await unknownRoomDetail(id, roomId),
            },
          ],
          'SUPPORT_REFUSED',
        );
      }
      const thread = c.req.valid('query').thread;
      const decisions = await roomDecisionCounts(roomId, thread);
      return c.json({ turns, limit: TURNS_LISTED, decisions });
    },
  );
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
