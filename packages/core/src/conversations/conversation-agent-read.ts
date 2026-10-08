import { and, eq, sql } from 'drizzle-orm';
import { noTurnCredentialDeviceReason, pickTurnCredentialDevice } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import {
  CONVERSATION_AGENT_MARKER,
  type ConversationAgentMeta,
  heldBecause,
  readConversationAgentMeta,
} from './conversation-agent-meta.js';

/**
 * At most one live runner-hosted turn per room.
 */
export async function hasInFlightConversationAgentTurn(
  projectId: string,
  conversationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.status, 'running'),
        sql`${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'conversationId' = ${conversationId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The session already answering this window, if one was dispatched for it.
 */
export async function conversationAgentTurnForWindow(
  windowId: string,
): Promise<{ sessionId: string } | null> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        sql`${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'windowId' = ${windowId}`,
        sql`${agentSessions.startedAt} IS NOT NULL`,
      ),
    )
    .limit(1);
  return row ? { sessionId: row.id } : null;
}

/** What a person is told about a runner-hosted turn while it is not yet an answer. */
type ConversationAgentTurnState = 'dispatched' | 'running' | 'delivered' | 'held' | 'failed';

export interface ConversationAgentTurnRow {
  windowId: string;
  sessionId: string;
  state: ConversationAgentTurnState;
  /** On `failed` only: which failure it was, in the sentence the venue was shown. */
  reason: string | null;
  /**
   * The reply the screen held, where it held one: why, for every reader of the room, and the text
   * as the session wrote it for the person it answered — the session acted as them — and nobody else.
   */
  held: { reason: string; reply: string | null } | null;
}

/**
 * Every runner-hosted turn this room has held, newest last.
 */
export async function readConversationAgentTurns(
  conversationId: string,
  viewerId: string | null,
): Promise<ConversationAgentTurnRow[]> {
  const rows = await db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      runtimeState: agentSessions.runtimeState,
      metadata: agentSessions.metadata,
      createdAt: agentSessions.createdAt,
    })
    .from(agentSessions)
    .where(
      sql`${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'conversationId' = ${conversationId}`,
    );
  const out: ConversationAgentTurnRow[] = [];
  for (const row of [...rows].sort((a, b) => +a.createdAt - +b.createdAt)) {
    const meta = readConversationAgentMeta(row.metadata);
    if (meta) out.push(agentTurnRow(row, meta, viewerId));
  }
  return out;
}

/** One turn as `viewerId` reads it; null reads as nobody in particular. */
export function agentTurnRow(
  row: { id: string; status: string; runtimeState: string | null },
  meta: ConversationAgentMeta,
  viewerId: string | null,
): ConversationAgentTurnRow {
  return {
    windowId: meta.windowId,
    sessionId: row.id,
    state: turnState(row, meta),
    reason: meta.failure ?? (interruptedDelivery(meta) ? DELIVERY_INTERRUPTED : null),
    held: meta.held
      ? {
          reason: heldBecause(meta.held.refusals),
          reply: viewerId !== null && meta.asker?.userId === viewerId ? meta.held.text : null,
        }
      : null,
  };
}

/**
 * How long a claimed-but-undelivered turn is read as being delivered rather than lost.
 */
const DELIVERY_INTERRUPTED_AFTER_MS = 10 * 60 * 1000;

/** What the venue is told when a delivery was claimed and then never finished. */
const DELIVERY_INTERRUPTED = 'the reply was interrupted before it reached this room';

function interruptedDelivery(meta: ConversationAgentMeta): boolean {
  if (meta.deliveredAt || meta.failure || !meta.claimedAt) return false;
  const at = Date.parse(meta.claimedAt);
  return Number.isFinite(at) && Date.now() - at > DELIVERY_INTERRUPTED_AFTER_MS;
}

export function turnState(
  row: { status: string; runtimeState: string | null },
  meta: ConversationAgentMeta,
): ConversationAgentTurnState {
  if (meta.failure) return 'failed';
  if (meta.held) return 'held';
  if (meta.deliveredAt) return 'delivered';
  if (interruptedDelivery(meta)) return 'failed';
  if (meta.claimedAt) return 'running';
  if (row.status !== 'running') return 'dispatched';
  return row.runtimeState ? 'running' : 'dispatched';
}
/** Why Agent mode cannot answer here right now, in a sentence; null where a box can. */
export async function conversationAgentUnavailableReason(
  projectId: string,
): Promise<string | null> {
  if (await pickTurnCredentialDevice(projectId)) return null;
  return (await noTurnCredentialDeviceReason(projectId)) === 'runner-outdated'
    ? 'the runners paired to this project are too old to act as the person asking; update forge-runner'
    : 'this project has no runner paired';
}
