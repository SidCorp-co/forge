import { and, asc, eq, gt, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessionTurnRoles,
  agentSessionTurns,
  type AgentSessionTurnRole,
} from '../db/schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Either the top-level db client or an in-flight drizzle transaction. */
export type DbOrTx = typeof db | Tx;

/**
 * Coerce the legacy `messages[].role` string into the per-turn enum. The older
 * agent runner sometimes emitted `'system'` for tool/preamble entries — those
 * map to `'tool'` so the row is preserved (they're never user-edited).
 */
export function messageRoleToTurnRole(entry: unknown): AgentSessionTurnRole | null {
  if (!entry || typeof entry !== 'object') return null;
  const raw = (entry as { role?: unknown }).role;
  if (typeof raw !== 'string') return null;
  if ((agentSessionTurnRoles as readonly string[]).includes(raw)) {
    return raw as AgentSessionTurnRole;
  }
  if (raw === 'system') return 'tool';
  return null;
}

/**
 * Whatever shape `messages[i]` had on disk, store it under `{ value: ... }` so
 * downstream code can always read `content.value` without losing the original
 * field set (timestamp, tool calls, attachments, etc.).
 */
export function normalizeTurnContent(entry: unknown): { value: unknown } {
  return { value: entry };
}

interface AppendedTurn {
  turnId: string;
  turnIndex: number;
  role: AgentSessionTurnRole;
}

interface SyncResult {
  appended: AppendedTurn[];
  truncatedFromTurnIndex: number | null;
}

/**
 * Reconcile the per-turn table with the new `messages` array.
 *
 * Strategy: compare lengths first, then tail content.
 *   next.length > prev.length  → insert rows for the new tail entries.
 *   next.length < prev.length  → DELETE turn_index >= next.length.
 *   next.length === prev.length → walk from tail and update any row whose
 *     content drifted (the desktop runner's `mergeMessages` replaces
 *     `messages[last]` in place while accumulating streamed assistant blocks
 *     — same length, different content). Walking from the tail and breaking
 *     on first-equal keeps this O(1) for the common streaming case.
 */
export async function syncTurnsWithMessages(
  sessionId: string,
  prev: unknown[],
  next: unknown[],
  dbClient: DbOrTx = db,
): Promise<SyncResult> {
  const prevLen = Array.isArray(prev) ? prev.length : 0;
  const nextLen = next.length;
  const prevArr = Array.isArray(prev) ? prev : [];

  if (nextLen > prevLen) {
    const newEntries = next.slice(prevLen);
    const values = newEntries
      .map((entry, i) => {
        const role = messageRoleToTurnRole(entry);
        if (!role) return null;
        return {
          agentSessionId: sessionId,
          turnIndex: prevLen + i,
          role,
          content: normalizeTurnContent(entry),
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    if (values.length === 0) {
      return { appended: [], truncatedFromTurnIndex: null };
    }

    const inserted = await dbClient
      .insert(agentSessionTurns)
      .values(values)
      .returning({
        id: agentSessionTurns.id,
        turnIndex: agentSessionTurns.turnIndex,
        role: agentSessionTurns.role,
      });

    // Guard against mocked clients that resolve `undefined` here (existing
    // route tests don't model the dual-write insert chain). Real production
    // calls always get an array back from drizzle's RETURNING.
    const safeInserted = Array.isArray(inserted) ? inserted : [];
    return {
      appended: safeInserted.map((r) => ({
        turnId: r.id,
        turnIndex: r.turnIndex,
        role: r.role,
      })),
      truncatedFromTurnIndex: null,
    };
  }

  if (nextLen < prevLen) {
    await dbClient
      .delete(agentSessionTurns)
      .where(
        and(
          eq(agentSessionTurns.agentSessionId, sessionId),
          gte(agentSessionTurns.turnIndex, nextLen),
        ),
      );
    return { appended: [], truncatedFromTurnIndex: nextLen };
  }

  // Same length: detect in-place mutations (streaming-tail pattern).
  for (let i = nextLen - 1; i >= 0; i--) {
    if (entriesEqual(prevArr[i], next[i])) break;
    const role = messageRoleToTurnRole(next[i]);
    if (!role) continue;
    await dbClient
      .update(agentSessionTurns)
      .set({ content: normalizeTurnContent(next[i]) as never })
      .where(
        and(
          eq(agentSessionTurns.agentSessionId, sessionId),
          eq(agentSessionTurns.turnIndex, i),
        ),
      );
  }
  return { appended: [], truncatedFromTurnIndex: null };
}

/** Stable structural equality via JSON. Sufficient for messages, which are
 * already JSON-round-trippable (they live in jsonb). */
function entriesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
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

/** Truncate turns past `keepThroughTurnIndex` (delete turn_index > keepThrough). */
export async function truncateTurnsAfter(
  sessionId: string,
  keepThroughTurnIndex: number,
  dbClient: DbOrTx = db,
) {
  await dbClient
    .delete(agentSessionTurns)
    .where(
      and(
        eq(agentSessionTurns.agentSessionId, sessionId),
        gt(agentSessionTurns.turnIndex, keepThroughTurnIndex),
      ),
    );
}

/** Resolve a turn id to its row. Returns null if the turn doesn't belong to the session. */
export async function findTurnInSession(sessionId: string, turnId: string) {
  const [row] = await db
    .select()
    .from(agentSessionTurns)
    .where(
      and(eq(agentSessionTurns.id, turnId), eq(agentSessionTurns.agentSessionId, sessionId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Replace one entry inside the legacy `agent_sessions.messages` jsonb so the
 * dual-write blob stays consistent with a per-turn row update.
 */
export function replaceMessageAt(
  messages: unknown,
  turnIndex: number,
  patch: (entry: unknown) => unknown,
): unknown[] {
  const arr = Array.isArray(messages) ? [...messages] : [];
  if (turnIndex < 0 || turnIndex >= arr.length) return arr;
  arr[turnIndex] = patch(arr[turnIndex]);
  return arr;
}

/** Truncate the legacy jsonb to keep `[0..keepThroughTurnIndex]` inclusive. */
export function sliceMessagesThrough(messages: unknown, keepThroughTurnIndex: number): unknown[] {
  const arr = Array.isArray(messages) ? messages : [];
  return arr.slice(0, keepThroughTurnIndex + 1);
}

/** SQL fragment to raise the agent_sessions row counter without re-reading. */
export function bumpUpdatedAt() {
  return sql`now()`;
}
