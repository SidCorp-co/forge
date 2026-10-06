import { and, asc, eq, gt, gte, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type AgentSessionTurnRole, agentSessions, agentSessionTurns } from '../db/schema.js';

/** Either the top-level db client or an in-flight drizzle transaction. */
export type DbOrTx = typeof db | Tx;

/** The turn role each canonical entry type is stored under. */
const TURN_ROLE_OF_TYPE: Readonly<Record<string, AgentSessionTurnRole>> = {
  user: 'user',
  assistant: 'assistant',
  system: 'tool',
  tool_use: 'tool',
  tool_result: 'tool',
};

export function messageRoleToTurnRole(entry: unknown): AgentSessionTurnRole | null {
  if (!entry || typeof entry !== 'object') return null;
  const type = (entry as { type?: unknown }).type;
  return typeof type === 'string' ? (TURN_ROLE_OF_TYPE[type] ?? null) : null;
}

/**
 * The text of a session's first user message, in the shape `dispatchChatTurn` writes it
 * (`{ type: 'user', content }`); null where it has none, which a re-dispatch reports by name.
 */
export function firstUserMessageText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    if (messageRoleToTurnRole(m) !== 'user') continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return null;
}

/** One transcript entry as a turn row holds it under `content.value`. */
export type TranscriptEntry = Record<string, unknown>;

function entryRefusal(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return `entry is ${Array.isArray(entry) ? 'an array' : typeof entry}, not an object`;
  }
  if (messageRoleToTurnRole(entry) !== null) return null;
  const type = (entry as { type?: unknown }).type;
  return `entry has \`type: ${JSON.stringify(type)}\`, which names no turn role (${Object.keys(TURN_ROLE_OF_TYPE).join(', ')})`;
}

/** A whole reported transcript, refused by INDEX where an entry is not in the canonical shape. */
export function canonicalTranscript(
  raw: unknown,
): { ok: true; messages: TranscriptEntry[] } | { ok: false; index: number; why: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, index: -1, why: `messages is ${typeof raw}, not an array` };
  }
  for (let i = 0; i < raw.length; i += 1) {
    const why = entryRefusal(raw[i]);
    if (why) return { ok: false, index: i, why };
  }
  return { ok: true, messages: raw as TranscriptEntry[] };
}

interface PlannedTurn {
  turnIndex: number;
  role: AgentSessionTurnRole;
  entry: unknown;
}

/** The row writes that turn the standing transcript `prev` into `next`. */
export interface TranscriptPlan {
  update: PlannedTurn[];
  insert: PlannedTurn[];
  truncateFrom: number | null;
}

export function planTranscriptWrite(
  prev: readonly unknown[],
  next: readonly unknown[],
): TranscriptPlan {
  const plan: TranscriptPlan = {
    update: [],
    insert: [],
    truncateFrom: next.length < prev.length ? next.length : null,
  };
  for (let i = 0; i < next.length; i += 1) {
    const entry = next[i];
    if (i < prev.length && entriesEqual(prev[i], entry)) continue;
    const role = messageRoleToTurnRole(entry);
    // a reported transcript was refused at its door; one reaching here is a producer's defect
    if (!role) throw new Error(`agent_session_turns: messages[${i}] ${entryRefusal(entry)}`);
    (i < prev.length ? plan.update : plan.insert).push({ turnIndex: i, role, entry });
  }
  return plan;
}

/** Stable structural equality via JSON; entries are JSON-round-trippable (they live in jsonb). */
function entriesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** A session's transcript, oldest first. */
export async function readTranscript(
  sessionId: string,
  dbClient: DbOrTx = db,
): Promise<TranscriptEntry[]> {
  const rows = await dbClient
    .select({ content: agentSessionTurns.content })
    .from(agentSessionTurns)
    .where(eq(agentSessionTurns.agentSessionId, sessionId))
    .orderBy(asc(agentSessionTurns.turnIndex));
  return rows.map((r) => (r.content as { value: TranscriptEntry }).value);
}

/**
 * How many entries the transcript of the `agent_sessions` row being selected holds. The outer
 * column is spelled out: drizzle renders a single-table column unqualified, which inside this
 * subquery would name the turn row's own `id`.
 */
export const transcriptLength = sql<number>`(SELECT count(*)::int FROM agent_session_turns t WHERE t.agent_session_id = "agent_sessions"."id")`;

/** The fingerprint of the selected row's transcript, computed by Postgres over the stored rows. */
export const transcriptFingerprint = sql<string>`md5(coalesce((SELECT string_agg(t.content::text, ',' ORDER BY t.turn_index) FROM agent_session_turns t WHERE t.agent_session_id = "agent_sessions"."id"), ''))`;

/**
 * Hold a session's transcript for the rest of the transaction. Every transcript writer takes the
 * session row first, so the rows it reads after this are the ones it writes over; false when the
 * session does not exist.
 */
export async function lockTranscript(tx: Tx, sessionId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .for('update');
  return rows.length > 0;
}

interface AppendedTurn {
  turnId: string;
  turnIndex: number;
  role: AgentSessionTurnRole;
}

export interface TranscriptWrite {
  appended: AppendedTurn[];
  truncatedFromTurnIndex: number | null;
}

/**
 * Write `next` as the session's whole transcript, diffed row by row against what stands. `prev` is
 * the standing transcript where the caller already read it under {@link lockTranscript}.
 */
export async function writeTranscript(
  tx: Tx,
  sessionId: string,
  next: readonly unknown[],
  prev?: readonly unknown[],
): Promise<TranscriptWrite> {
  if (!(await lockTranscript(tx, sessionId))) {
    throw new Error(`agent_session_turns: session ${sessionId} does not exist`);
  }
  const plan = planTranscriptWrite(prev ?? (await readTranscript(sessionId, tx)), next);
  if (plan.truncateFrom !== null) {
    await tx
      .delete(agentSessionTurns)
      .where(
        and(
          eq(agentSessionTurns.agentSessionId, sessionId),
          gte(agentSessionTurns.turnIndex, plan.truncateFrom),
        ),
      );
  }
  for (const t of plan.update) {
    await tx
      .update(agentSessionTurns)
      .set({ role: t.role, content: { value: t.entry } })
      .where(
        and(
          eq(agentSessionTurns.agentSessionId, sessionId),
          eq(agentSessionTurns.turnIndex, t.turnIndex),
        ),
      );
  }
  if (plan.insert.length === 0) return { appended: [], truncatedFromTurnIndex: plan.truncateFrom };
  const inserted = await tx
    .insert(agentSessionTurns)
    .values(
      plan.insert.map((t) => ({
        agentSessionId: sessionId,
        turnIndex: t.turnIndex,
        role: t.role,
        content: { value: t.entry },
      })),
    )
    .returning({
      turnId: agentSessionTurns.id,
      turnIndex: agentSessionTurns.turnIndex,
      role: agentSessionTurns.role,
    });
  return { appended: inserted, truncatedFromTurnIndex: plan.truncateFrom };
}

/** Cursor-paginated turn fetch. Used by the GET /turns endpoint. */
export async function loadTurns(
  sessionId: string,
  opts: { afterTurnIndex?: number; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const baseConds = [eq(agentSessionTurns.agentSessionId, sessionId)] as const;
  const where =
    opts.afterTurnIndex !== undefined
      ? and(...baseConds, gt(agentSessionTurns.turnIndex, opts.afterTurnIndex))
      : and(...baseConds);

  const rows = await db
    .select()
    .from(agentSessionTurns)
    .where(where)
    .orderBy(asc(agentSessionTurns.turnIndex))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const last = trimmed[trimmed.length - 1];
  return {
    turns: trimmed,
    nextCursor: hasMore && last ? last.id : null,
  };
}

/** Cut a session's transcript to its first `length` entries. */
export async function truncateTranscript(tx: Tx, sessionId: string, length: number): Promise<void> {
  await lockTranscript(tx, sessionId);
  await tx
    .delete(agentSessionTurns)
    .where(
      and(
        eq(agentSessionTurns.agentSessionId, sessionId),
        gte(agentSessionTurns.turnIndex, length),
      ),
    );
}

/** Resolve a turn id to its row. Returns null if the turn doesn't belong to the session. */
export async function findTurnInSession(sessionId: string, turnId: string) {
  const [row] = await db
    .select()
    .from(agentSessionTurns)
    .where(and(eq(agentSessionTurns.id, turnId), eq(agentSessionTurns.agentSessionId, sessionId)))
    .limit(1);
  return row ?? null;
}

/**
 * Extract a non-empty string prompt from a `messages[i].content` value. The
 * legacy schema lets `content` be either a string or an array of structured
 * blocks (Anthropic-style `[{ type: 'text', text: '…' }, …]`). Returns the
 * trimmed string, or empty string if nothing dispatchable can be recovered.
 */
export function extractPromptString(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}
