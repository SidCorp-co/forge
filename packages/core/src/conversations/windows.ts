/**
 * The collector window: the unit a routing decision is taken over.
 *
 * A window opens on the first message nothing has routed yet, is extended by
 * later ones rather than opening a second, and is claimed before it routes. It
 * is a row and not a timer in a process, so a core that dies leaves the messages
 * inside it findable rather than lost, and two cores cannot both answer the same
 * thing somebody said.
 *
 * Nothing here knows a transport. The adapter that collected the messages is the
 * one that drains them, and it asks for its own adapter's work by name.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import type { ConversationAdapter, ConversationShape } from '../db/schema-conversations.js';
import {
  type ConversationWindowDecision,
  type ConversationWindowOrigin,
  conversations,
  conversationWindows,
} from '../db/schema-conversations.js';
import type { Executor } from './db-executor.js';

/**
 * How long a window waits for the next message before it settles.
 */
export const WINDOW_SETTLE_MS = 4000;

/**
 * How long a claim holds before the window is claimable again.
 */
export const CLAIM_LEASE_MS = 120_000;

/** A window taken off the queue, with the venue it belongs to. */
export interface ClaimedWindow extends ConversationWindowRow {
  venueExternalId: string;
  venueShape: ConversationShape;
}

export interface ConversationWindowRow {
  id: string;
  conversationId: string;
  projectId: string;
  adapter: ConversationAdapter;
  openedAt: Date;
  extendedAt: Date;
  firstSeq: number;
  lastSeq: number;
  claimedAt: Date | null;
  claimedBy: string | null;
  deliveryReservedAt: Date | null;
  closedAt: Date | null;
  decision: ConversationWindowDecision | null;
  decisionDetail: unknown;
}

/**
 * Which claim a write belongs to.
 */
export interface WindowClaim {
  claimedAt: Date;
  claimedBy: string;
}

/** The claim a row was returned under, for a caller that holds it. */
export function claimOf(row: ConversationWindowRow): WindowClaim | null {
  return row.claimedAt && row.claimedBy
    ? { claimedAt: row.claimedAt, claimedBy: row.claimedBy }
    : null;
}

function heldBy(claim: WindowClaim) {
  return and(
    eq(conversationWindows.claimedAt, claim.claimedAt),
    eq(conversationWindows.claimedBy, claim.claimedBy),
  );
}

/**
 * The delivery key for a window's reply.
 */
export function windowDeliveryKey(windowId: string): string {
  return `window:${windowId}`;
}

const selection = {
  id: conversationWindows.id,
  conversationId: conversationWindows.conversationId,
  projectId: conversationWindows.projectId,
  adapter: conversationWindows.adapter,
  openedAt: conversationWindows.openedAt,
  extendedAt: conversationWindows.extendedAt,
  firstSeq: conversationWindows.firstSeq,
  lastSeq: conversationWindows.lastSeq,
  claimedAt: conversationWindows.claimedAt,
  claimedBy: conversationWindows.claimedBy,
  deliveryReservedAt: conversationWindows.deliveryReservedAt,
  closedAt: conversationWindows.closedAt,
  decision: conversationWindows.decision,
  decisionDetail: conversationWindows.decisionDetail,
};

export interface OpenOrExtendArgs {
  conversationId: string;
  projectId: string;
  adapter: ConversationAdapter;
  /** The sequence number of the message that just landed. */
  seq: number;
  /** The newest seq the window covers when it opens over a range; defaults to `seq` (ISS-1034 heartbeat). */
  lastSeq?: number | undefined;
  /** Who opened it: the inbound collector (default) or the heartbeat tick. */
  origin?: ConversationWindowOrigin | undefined;
  now?: Date;
}

/**
 * Put this message in the conversation's collecting window, opening one if there
 * is none.
 */
export async function openOrExtendWindow(
  args: OpenOrExtendArgs,
  tx: Executor = defaultDb,
): Promise<ConversationWindowRow> {
  const now = args.now ?? new Date();
  const [row] = await tx
    .insert(conversationWindows)
    .values({
      conversationId: args.conversationId,
      projectId: args.projectId,
      adapter: args.adapter,
      openedAt: now,
      extendedAt: now,
      firstSeq: args.seq,
      lastSeq: args.lastSeq ?? args.seq,
      origin: args.origin ?? 'inbound',
    })
    .onConflictDoUpdate({
      target: conversationWindows.conversationId,
      targetWhere: sql`claimed_at IS NULL AND closed_at IS NULL`,
      set: {
        extendedAt: sql`greatest(${conversationWindows.extendedAt}, excluded.extended_at)`,
        lastSeq: sql`greatest(${conversationWindows.lastSeq}, excluded.last_seq)`,
      },
    })
    .returning(selection);
  if (!row) {
    throw new Error(
      `conversation_windows: neither opened nor extended a window for conversation ${args.conversationId}`,
    );
  }
  return row as ConversationWindowRow;
}

export interface ClaimArgs {
  adapter: ConversationAdapter;
  /** Names the core in the log; the claim itself is the conditional update. */
  claimant: string;
  limit: number;
  /**
   * Only windows whose venue id starts with one of these.
   */
  venuePrefixes?: readonly string[];
  now?: Date;
  settleMs?: number;
  leaseMs?: number;
}

/**
 * Claim the windows this adapter owes an answer, and hand them back.
 */
export async function claimDueWindows(
  args: ClaimArgs,
  tx: Executor = defaultDb,
): Promise<ClaimedWindow[]> {
  const now = args.now ?? new Date();
  const settleBefore = new Date(now.getTime() - (args.settleMs ?? WINDOW_SETTLE_MS));
  const leaseBefore = new Date(now.getTime() - (args.leaseMs ?? CLAIM_LEASE_MS));

  const prefixes = args.venuePrefixes;
  if (prefixes && prefixes.length === 0) return [];
  const venueFilter = prefixes
    ? sql`exists (select 1 from ${conversations} c where c.id = ${conversationWindows.conversationId} and c.external_id like any (${sql.param(prefixes.map((p) => `${p}%`))}))`
    : sql`true`;

  const due = tx
    .select({ id: conversationWindows.id })
    .from(conversationWindows)
    .where(
      and(
        eq(conversationWindows.adapter, args.adapter),
        isNull(conversationWindows.closedAt),
        or(
          and(
            isNull(conversationWindows.claimedAt),
            lte(conversationWindows.extendedAt, settleBefore),
          ),
          lte(conversationWindows.claimedAt, leaseBefore),
        ),
        venueFilter,
      ),
    )
    .orderBy(asc(conversationWindows.extendedAt))
    .limit(args.limit)
    .for('update', { skipLocked: true });

  const rows = (await tx
    .update(conversationWindows)
    .set({ claimedAt: now, claimedBy: args.claimant })
    .where(sql`${conversationWindows.id} in ${due}`)
    .returning(selection)) as ConversationWindowRow[];
  if (rows.length === 0) return [];

  const venues = await tx
    .select({
      id: conversations.id,
      externalId: conversations.externalId,
      shape: conversations.shape,
    })
    .from(conversations)
    .where(inArray(conversations.id, [...new Set(rows.map((r) => r.conversationId))]));
  const byId = new Map(venues.map((v) => [v.id, v]));
  return rows.flatMap((row) => {
    const venue = byId.get(row.conversationId);
    return venue ? [{ ...row, venueExternalId: venue.externalId, venueShape: venue.shape }] : [];
  });
}

/**
 * Close a claimed window under the decision that was taken.
 */
export async function closeWindow(
  args: {
    windowId: string;
    decision: ConversationWindowDecision;
    detail?: unknown;
    claim: WindowClaim;
    now?: Date;
  },
  tx: Executor = defaultDb,
): Promise<ConversationWindowRow | null> {
  const [row] = await tx
    .update(conversationWindows)
    .set({
      closedAt: args.now ?? new Date(),
      decision: args.decision,
      decisionDetail: (args.detail ?? null) as never,
    })
    .where(
      and(
        eq(conversationWindows.id, args.windowId),
        isNull(conversationWindows.closedAt),
        heldBy(args.claim),
      ),
    )
    .returning(selection);
  return (row as ConversationWindowRow | undefined) ?? null;
}

/**
 * Write down that this window's reply is about to be handed to the transport.
 */
export async function reserveDelivery(
  windowId: string,
  claim: WindowClaim,
  tx: Executor = defaultDb,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await tx
    .update(conversationWindows)
    .set({ deliveryReservedAt: now })
    .where(
      and(
        eq(conversationWindows.id, windowId),
        isNull(conversationWindows.closedAt),
        heldBy(claim),
      ),
    )
    .returning({ id: conversationWindows.id });
  return rows.length > 0;
}

/**
 * Give a claimed window back without deciding anything.
 */
export async function releaseWindow(
  windowId: string,
  claim: WindowClaim,
  tx: Executor = defaultDb,
): Promise<void> {
  await tx
    .update(conversationWindows)
    .set({ claimedAt: null, claimedBy: null })
    .where(
      and(
        eq(conversationWindows.id, windowId),
        isNull(conversationWindows.closedAt),
        heldBy(claim),
      ),
    );
}

export async function getWindow(
  windowId: string,
  tx: Executor = defaultDb,
): Promise<ConversationWindowRow | null> {
  const [row] = await tx
    .select(selection)
    .from(conversationWindows)
    .where(eq(conversationWindows.id, windowId))
    .limit(1);
  return (row as ConversationWindowRow | undefined) ?? null;
}

/**
 * This conversation's windows, oldest first, for a reader rather than a guard.
 */
export async function listWindowsForConversation(
  conversationId: string,
  limit: number,
  tx: Executor = defaultDb,
): Promise<ConversationWindowRow[]> {
  const rows = await tx
    .select(selection)
    .from(conversationWindows)
    .where(eq(conversationWindows.conversationId, conversationId))
    .orderBy(desc(conversationWindows.firstSeq))
    .limit(limit);
  return (rows as ConversationWindowRow[]).reverse();
}

/**
 * The decisions this conversation's windows have settled on, newest first.
 */
export async function recentDecisions(
  conversationId: string,
  opts: { since?: Date; limit?: number } = {},
  tx: Executor = defaultDb,
): Promise<Array<{ decision: ConversationWindowDecision; closedAt: Date }>> {
  const rows = await tx
    .select({ decision: conversationWindows.decision, closedAt: conversationWindows.closedAt })
    .from(conversationWindows)
    .where(
      and(
        eq(conversationWindows.conversationId, conversationId),
        isNotNull(conversationWindows.closedAt),
        opts.since ? gte(conversationWindows.closedAt, opts.since) : sql`true`,
      ),
    )
    .orderBy(desc(conversationWindows.closedAt))
    .limit(opts.limit ?? 20);
  return rows.flatMap((r) =>
    r.decision && r.closedAt ? [{ decision: r.decision, closedAt: r.closedAt }] : [],
  );
}
