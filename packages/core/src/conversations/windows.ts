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

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import type { ConversationAdapter, ConversationShape } from '../db/schema-conversations.js';
import {
  type ConversationWindowDecision,
  conversations,
  conversationWindows,
} from '../db/schema-conversations.js';
import type { Executor } from './db-executor.js';

/**
 * How long a window waits for the next message before it settles.
 */
// cm:why a settle delay and not a message count: two messages typed seconds apart are one thing somebody said, and answering each of them separately is two turns, two bills and two replies interleaved with the second question.
export const WINDOW_SETTLE_MS = 4000;

/**
 * How long a claim holds before the window is claimable again.
 */
// cm:guard a claim is a LEASE and never a flag: a core that claims a window and stops would otherwise wedge it forever under a non-null `claimed_at`, which is exactly the restart durability the row exists to provide. What makes the re-claim safe rather than a second answer is `windowDeliveryKey` — the key is derived from the window and not minted per attempt, so a reply already carrying it is found before anything is sent again (ISS-1004 rule 2).
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
// cm:guard the claim's own `claimed_at` and `claimed_by` TOGETHER are the generation token, and every write a claimant makes carries it — REQUIRED on all three, never optional, because an optional fence is one an unchanged caller slips past in silence: the lease that recovers a dead core also means two holders can believe they own one window, so a holder whose lease ran out must be refused at the moment it writes rather than trusted to have noticed. Without this fence the reservation and the close were both unconditional and the stale holder sent a second reply (ISS-1004 rule 2, review pass 1 F1).
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
// cm:guard derived from the window id and NOTHING else — not the attempt, not the clock, not a uuid minted here. A key that changes per attempt makes every retry a new delivery, which is the at-most-once property read backwards (ISS-1004 rule 2).
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
  now?: Date;
}

/**
 * Put this message in the conversation's collecting window, opening one if there
 * is none.
 */
// cm:guard the conflict target is the PARTIAL unique index over collecting windows, so a window already claimed is not a conflict and this opens its successor instead: a message that arrived after the turn read its messages would otherwise be appended to a decision that can no longer see it, which is a question asked and never answered (ISS-1004, review F2).
// cm:guard `last_seq` takes the GREATEST and `extended_at` the later clock rather than the incoming values outright: two collectors racing on one window can commit out of order, and taking the loser's numbers would shrink a window that had already grown.
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
      lastSeq: args.seq,
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
  // cm:guard the caller's OWN venue-id shape, which this module never interprets — it compares strings. It is how a core takes only the rooms its own sockets can deliver through: claiming a window another core's connection binds would hold it for a whole lease while nobody could answer it (ISS-1004).
  venuePrefixes?: readonly string[];
  now?: Date;
  settleMs?: number;
  leaseMs?: number;
}

/**
 * Claim the windows this adapter owes an answer, and hand them back.
 */
// cm:guard the claim is ONE statement whose inner select takes `FOR UPDATE SKIP LOCKED`: two cores reading the due set and then updating it would both see an unclaimed row and both route it, which is the double answer the row exists to prevent. Skip-locked is what makes the loser take the NEXT window rather than block on this one (ISS-1004 rule 1).
// cm:guard the second disjunct re-claims an EXPIRED lease and is not an escape from the first: a window whose holder died is owed an answer, and leaving it claimed forever is the silence with no owner the table was added to remove. Safe only because `windowDeliveryKey` is stable, which `route-window.ts` checks before it sends.
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

  // cm:guard the venue travels WITH the claim so the adapter never reads the store to find out which room it just took: an adapter importing a store module is the coupling `transport-free.test.ts` fails CI on, and the claimant needs exactly two of its fields (ISS-1002, ISS-1004).
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
// cm:guard conditional on the window still being OPEN and still held by the CLAIM that is closing it, and the caller is told when it was not: a close that overwrites another core's decision is the same double route the claim refused, arriving one statement later, and a holder whose lease expired mid-turn would otherwise settle a window somebody else is already routing (ISS-1004, review pass 1 F1).
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
// cm:guard called BEFORE the send and never after: a reply the server accepted and a dying core never recorded is indistinguishable from one never sent, unless the intent was durable first. A later claimant that finds this stamp and no delivered row closes the window `undetermined` and sends nothing — which is the honest answer, and the one rule 4 forbids treating as a failure (ISS-1004 rule 2, review F2).
// cm:guard it answers FALSE rather than throwing when the claim has moved on, and the caller must not send on a false: this is the only moment a holder whose lease expired can be told so, and it is deliberately re-callable by the holder that owns it, because one turn reserves both before a diversion and before its own send (ISS-1004, review pass 1 F1).
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
// cm:guard a release is NOT a close and the difference is the whole of rule 4: a core that finds it cannot deliver through this room has taken no decision, and writing one would tell a person their message was considered and refused when nobody looked at it. The window goes back to collecting and the next tick that CAN serve it takes it (ISS-1004).
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
 * The decisions this conversation's windows have settled on, newest first.
 */
// cm:guard the guards READ this and store nothing of their own: a window's decision is evidence of what was decided, already written for a person to read, and a counter beside it would be a second copy that a missed write silences a room with (ISS-1004 rule 3).
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
        sql`${conversationWindows.closedAt} is not null`,
        opts.since ? sql`${conversationWindows.closedAt} >= ${opts.since}` : sql`true`,
      ),
    )
    .orderBy(sql`${conversationWindows.closedAt} desc`)
    .limit(opts.limit ?? 20);
  return rows.flatMap((r) =>
    r.decision && r.closedAt ? [{ decision: r.decision, closedAt: r.closedAt }] : [],
  );
}
