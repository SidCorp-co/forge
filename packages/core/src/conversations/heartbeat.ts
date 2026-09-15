/**
 * ISS-1034 — the heartbeat: a periodic look at rooms whose handle asked for one.
 *
 * A heartbeat is an evaluation, not a recovery of unrouted messages: the
 * collector still opens a window for every message that lands. What this adds
 * is a second chance for a room the last turn found nothing to say in — once
 * the agent has been quiet for the handle's interval, the unanswered person
 * messages are put in a fresh window and routed by the same path under the
 * same guards.
 */
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { agentSelves, type PresenceConfig } from '../db/schema-agent-selves.js';
import {
  type ConversationAdapter,
  type ConversationWindowDecision,
  conversationParticipants,
  conversations,
  conversationWindows,
} from '../db/schema-conversations.js';
import { logger } from '../logger.js';
import type { Executor } from './db-executor.js';
import { heartbeatOf } from './presence.js';
import { GUARD_WINDOW } from './proactivity.js';
import { readMessages, type StoredConversationMessage } from './store.js';
import { openOrExtendWindow } from './windows.js';

export type HeartbeatSkip =
  | 'window-open'
  | 'last-window-not-quiet'
  | 'no-messages'
  | 'newest-not-a-person'
  | 'agent-spoke-recently'
  | 'heartbeat-recent'
  | 'nothing-unanswered';

export interface HeartbeatFacts {
  /** The decision of the newest closed window, or null where none has closed. */
  lastSettledDecision: ConversationWindowDecision | null;
  /** Whether a window is collecting or claimed right now. */
  windowOpen: boolean;
  /** The room's recent messages, oldest first. */
  messages: readonly StoredConversationMessage[];
  /** The users whose messages count as the agent's: the room's handles. */
  agentUserIds: ReadonlySet<string>;
  /** When the newest heartbeat window was opened, or null. */
  lastHeartbeatAt: Date | null;
  intervalMs: number;
  now: Date;
}

export type HeartbeatVerdict =
  | { due: true; firstSeq: number; lastSeq: number }
  | { due: false; reason: HeartbeatSkip };

function isAgent(m: StoredConversationMessage, agents: ReadonlySet<string>): boolean {
  return m.role === 'assistant' || (m.authorUserId !== null && agents.has(m.authorUserId));
}

/**
 * Whether a room is owed a heartbeat window, and over which messages.
 */
// cm:guard every clause of criterion 36 is a separate reason and the range is the FIRST unanswered person message to the newest, not the collector's watermark: a window opened from the watermark would be empty when nothing arrived since the settled one, and an empty window is routed as a turn about nothing (ISS-1034 criteria 36-38).
export function heartbeatDue(facts: HeartbeatFacts): HeartbeatVerdict {
  if (facts.windowOpen) return { due: false, reason: 'window-open' };
  if (facts.lastSettledDecision !== 'nothing-to-say') {
    return { due: false, reason: 'last-window-not-quiet' };
  }
  const newest = facts.messages[facts.messages.length - 1];
  if (!newest) return { due: false, reason: 'no-messages' };
  if (isAgent(newest, facts.agentUserIds)) return { due: false, reason: 'newest-not-a-person' };
  const since = facts.now.getTime() - facts.intervalMs;
  const lastAgent = [...facts.messages].reverse().find((m) => isAgent(m, facts.agentUserIds));
  if (lastAgent && lastAgent.createdAt.getTime() > since) {
    return { due: false, reason: 'agent-spoke-recently' };
  }
  if (facts.lastHeartbeatAt && facts.lastHeartbeatAt.getTime() > since) {
    return { due: false, reason: 'heartbeat-recent' };
  }
  const firstUnanswered = facts.messages.find(
    (m) =>
      !isAgent(m, facts.agentUserIds) &&
      (!lastAgent || m.createdAt.getTime() > lastAgent.createdAt.getTime()),
  );
  if (!firstUnanswered) return { due: false, reason: 'nothing-unanswered' };
  return { due: true, firstSeq: firstUnanswered.seq, lastSeq: newest.seq };
}

export interface HeartbeatTickResult {
  /** Rooms with at least one handle whose heartbeat is enabled. */
  rooms: number;
  opened: number;
  skipped: Partial<Record<HeartbeatSkip, number>>;
}

interface Candidate {
  conversationId: string;
  projectId: string;
  adapter: ConversationAdapter;
  intervalMs: number;
  agentUserIds: Set<string>;
}

// cm:guard the candidates are the rooms whose HANDLE asked, read off `agent_selves.presence` joined through the live handle participants, and a room with two enabled handles takes the shorter interval: the heartbeat is per handle in the self and per room in the tick, and the room is owed a look as soon as either handle's clock says so (ISS-1034 criterion 38).
async function candidates(tx: Executor): Promise<Candidate[]> {
  const rows = await tx
    .select({
      conversationId: conversationParticipants.conversationId,
      projectId: conversationParticipants.projectId,
      userId: conversationParticipants.userId,
      adapter: conversations.adapter,
      presence: agentSelves.presence,
    })
    .from(conversationParticipants)
    .innerJoin(agentSelves, eq(agentSelves.userId, conversationParticipants.userId))
    .innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
    .where(
      and(
        eq(conversationParticipants.kind, 'handle'),
        isNull(conversationParticipants.removedAt),
        isNull(conversations.archivedAt),
        sql`(${agentSelves.presence} -> 'heartbeat' ->> 'enabled')::boolean is true`,
      ),
    );
  const byRoom = new Map<string, Candidate>();
  for (const r of rows) {
    if (!r.userId || !r.projectId) continue;
    const { intervalMs } = heartbeatOf(r.presence as PresenceConfig);
    const seen = byRoom.get(r.conversationId);
    if (seen) {
      seen.intervalMs = Math.min(seen.intervalMs, intervalMs);
      seen.agentUserIds.add(r.userId);
      continue;
    }
    byRoom.set(r.conversationId, {
      conversationId: r.conversationId,
      projectId: r.projectId,
      adapter: r.adapter,
      intervalMs,
      agentUserIds: new Set([r.userId]),
    });
  }
  return [...byRoom.values()];
}

async function factsFor(c: Candidate, now: Date, tx: Executor): Promise<HeartbeatFacts> {
  const [settled] = await tx
    .select({ decision: conversationWindows.decision })
    .from(conversationWindows)
    .where(
      and(
        eq(conversationWindows.conversationId, c.conversationId),
        isNotNull(conversationWindows.closedAt),
      ),
    )
    .orderBy(desc(conversationWindows.closedAt))
    .limit(1);
  const [open] = await tx
    .select({ id: conversationWindows.id })
    .from(conversationWindows)
    .where(
      and(
        eq(conversationWindows.conversationId, c.conversationId),
        isNull(conversationWindows.closedAt),
      ),
    )
    .limit(1);
  const [beat] = await tx
    .select({ openedAt: conversationWindows.openedAt })
    .from(conversationWindows)
    .where(
      and(
        eq(conversationWindows.conversationId, c.conversationId),
        eq(conversationWindows.origin, 'heartbeat'),
      ),
    )
    .orderBy(desc(conversationWindows.openedAt))
    .limit(1);
  return {
    lastSettledDecision: settled?.decision ?? null,
    windowOpen: open !== undefined,
    messages: await readMessages(c.conversationId, GUARD_WINDOW, tx),
    agentUserIds: c.agentUserIds,
    lastHeartbeatAt: beat?.openedAt ?? null,
    intervalMs: c.intervalMs,
    now,
  };
}

/**
 * One tick: open a heartbeat window in every room that is owed one.
 */
// cm:guard the open goes through `openOrExtendWindow` and nothing else, and that is what makes two ticks safe: its conflict target is the partial unique index over collecting windows, so the second tick's insert lands on the first's row and extends it — one window between them, routed once by the drain that owns the adapter (ISS-1034 criteria 37, 65).
export async function runHeartbeatTick(
  now: Date = new Date(),
  dbi: typeof defaultDb = defaultDb,
): Promise<HeartbeatTickResult> {
  const rooms = await candidates(dbi);
  const result: HeartbeatTickResult = { rooms: rooms.length, opened: 0, skipped: {} };
  for (const room of rooms) {
    // cm:guard the facts are read and the window opened in ONE transaction under a per-room advisory lock, because the collecting index alone is not the whole fence: tick A opens, the drain claims (a claimed window leaves the index's predicate), and tick B — which read "due" before A committed — would open a second heartbeat over the same messages. Under the lock B re-reads after A's commit and finds the window open or the heartbeat recent (codex F3, criterion 65).
    const verdict = await dbi.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('conversation_heartbeat'), hashtext(${room.conversationId}))`,
      );
      const due = heartbeatDue(await factsFor(room, now, tx as unknown as Executor));
      if (!due.due) return due;
      await openOrExtendWindow(
        {
          conversationId: room.conversationId,
          projectId: room.projectId,
          adapter: room.adapter,
          seq: due.firstSeq,
          lastSeq: due.lastSeq,
          origin: 'heartbeat',
          now,
        },
        tx as unknown as Executor,
      );
      return due;
    });
    if (!verdict.due) {
      result.skipped[verdict.reason] = (result.skipped[verdict.reason] ?? 0) + 1;
      continue;
    }
    result.opened += 1;
  }
  return result;
}

export const HEARTBEAT_TICK_MS = 60_000;

/**
 * Start ticking. Returns the stop.
 */
// cm:guard the tick lives with the conversations runtime and NOT as a pass of `pipeline/sweeper.ts`: that file coordinates six modules against the archmap limit and a seventh is refused, and a room's heartbeat is the store's own concern rather than the pipeline's. Two cores ticking at once open one window between them (criterion 65), so nothing here elects a leader (ISS-1034).
// cm:guard a tick still running is never overlapped by the next, the rule every drain in this tree follows: two ticks over one candidate list would read the same facts and both decide "due" before either row lands.
export function startConversationHeartbeat(
  tick: () => Promise<unknown> = () => runHeartbeatTick(),
  intervalMs: number = HEARTBEAT_TICK_MS,
): () => void {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    void tick()
      .catch((err) => logger.error({ err }, 'conversations: the heartbeat tick failed'))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
