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
import { env } from '../config/env.js';
import { db as defaultDb } from '../db/client.js';
import type { ConversationAdapter, ConversationShape } from '../db/schema-conversations.js';
import {
  type ConversationWindowCutReason,
  type ConversationWindowDecision,
  type ConversationWindowOrigin,
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
 * How long a window may keep collecting before it is due whether or not it has settled.
 */
// cm:guard a second clock beside the settle and not a replacement for it: a room whose messages arrive under `WINDOW_SETTLE_MS` apart moved `extended_at` before the window was ever due, so it was never claimed, never closed, and wrote no decision — the ownerless silence this table exists to remove, reached through the mechanism that removes it (ISS-1086). What the hold promises is ELIGIBILITY: the guards, the model's own decline, the drain's tick and the turn all still follow, so no reader may take it for a reply deadline.
// cm:why 15s is a tuning start and not a measurement: six people talking at once wait at most this long before their window reaches a turn, and the three durations every close records (`collectedMs`, `routingDelayMs`, `replyMs`) are what a later change of this number is judged against.
export const WINDOW_HOLD_MS = 15_000;

/** The hold in force: the deployment's override, else today's constant. */
export function resolveHoldMs(
  override: number | undefined = env.CONVERSATION_WINDOW_HOLD_MS,
): number {
  return override ?? WINDOW_HOLD_MS;
}

/**
 * How long a claim holds before the window is claimable again.
 */
// cm:guard a claim is a LEASE and never a flag: a core that claims a window and stops would otherwise wedge it forever under a non-null `claimed_at`, which is exactly the restart durability the row exists to provide. What makes the re-claim safe rather than a second answer is `windowDeliveryKey` — the key is derived from the window and not minted per attempt, so a reply already carrying it is found before anything is sent again (ISS-1004 rule 2).
export const CLAIM_LEASE_MS = 120_000;

/** A window taken off the queue, with the venue it belongs to. */
export interface ClaimedWindow extends ConversationWindowRow {
  venueExternalId: string;
  venueShape: ConversationShape;
  /**
   * When this window became due under the clocks the claim used.
   */
  // cm:guard computed in the claim's own RETURNING and not re-derived at the close: the close does not know which `settleMs` and `holdMs` the claimant passed (the web adapter claims at settle 0), and a `routingDelayMs` computed from the module constants there would be wrong by up to a settle for every web window — a measurement that lies is worse than none (ISS-1086 criterion 26).
  dueAt: Date;
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
  /** Why it stopped collecting; null until claimed, and null on a row claimed before ISS-1086. */
  cutReason: ConversationWindowCutReason | null;
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
  cutReason: conversationWindows.cutReason,
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
  // cm:guard the caller's OWN venue-id shape, which this module never interprets — it compares strings. It is how a core takes only the rooms its own sockets can deliver through: claiming a window another core's connection binds would hold it for a whole lease while nobody could answer it (ISS-1004).
  venuePrefixes?: readonly string[];
  now?: Date;
  settleMs?: number;
  /** How long a window may collect before it is due regardless of quiet; `resolveHoldMs()` absent. */
  holdMs?: number;
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
  const settleMs = args.settleMs ?? WINDOW_SETTLE_MS;
  const holdMs = args.holdMs ?? resolveHoldMs();
  const settleBefore = new Date(now.getTime() - settleMs);
  const holdBefore = new Date(now.getTime() - holdMs);
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
            // cm:guard due on EITHER clock: quiet for `settleMs`, or open for `holdMs` however recently it was extended. The second disjunct is the whole of ISS-1086 — without it a window extended every few seconds is never in this set.
            or(
              lte(conversationWindows.extendedAt, settleBefore),
              lte(conversationWindows.openedAt, holdBefore),
            ),
          ),
          lte(conversationWindows.claimedAt, leaseBefore),
        ),
        venueFilter,
        // cm:guard one conversation's windows are claimed in the order they were OPENED, and a later one waits while an earlier one is unclosed — held, or released with its lease lapsed. Without this the overflow split can bridge a claimed range: A holds 0–59, its successor B (60–69) is claimed elsewhere, C collects 70–71, and A's split lowers C to 50–71, so B's messages are answered twice under two delivery keys. The wait costs at most one turn, or one lease where the holder died. The order is TOTAL: `opened_at`, then `first_seq`, then the id, so two windows opened in the same millisecond still have exactly one earlier one and the fence has no gap to slip through (ISS-1086, whole-set review F1 and its recheck).
        sql`not exists (select 1 from conversation_windows earlier where earlier.conversation_id = ${conversationWindows.conversationId} and earlier.closed_at is null and (earlier.opened_at, earlier.first_seq, earlier.id) < (${conversationWindows.openedAt}, ${conversationWindows.firstSeq}, ${conversationWindows.id}))`,
      ),
    )
    .orderBy(asc(conversationWindows.extendedAt))
    .limit(args.limit)
    .for('update', { skipLocked: true });

  const rows = (await tx
    .update(conversationWindows)
    .set({
      claimedAt: now,
      claimedBy: args.claimant,
      // cm:guard COALESCE so the FIRST claim's reason stands: a re-claim after a lapsed lease finds a window that has been quiet for the whole lease and would otherwise stamp `quiet` over a `deadline`, telling the turn the room had finished when it was cut mid-sentence (ISS-1086 criterion 5).
      cutReason: sql`coalesce(${conversationWindows.cutReason}, case when ${conversationWindows.extendedAt} <= ${settleBefore.toISOString()}::timestamptz then 'quiet' else 'deadline' end)`,
    })
    .where(sql`${conversationWindows.id} in ${due}`)
    .returning({
      ...selection,
      dueAt:
        sql`least(${conversationWindows.extendedAt} + ${settleMs} * interval '1 millisecond', ${conversationWindows.openedAt} + ${holdMs} * interval '1 millisecond')`.mapWith(
          conversationWindows.openedAt,
        ),
    })) as (ConversationWindowRow & { dueAt: Date })[];
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

export interface SplitTailArgs {
  windowId: string;
  conversationId: string;
  projectId: string;
  adapter: ConversationAdapter;
  claim: WindowClaim;
  /** The last seq this window keeps; everything after it goes to the successor. */
  prefixLastSeq: number;
  /** The messages past the cap, when the first of them arrived, and when the last did. */
  tail: { firstSeq: number; lastSeq: number; firstAt: Date; lastAt: Date };
}

/**
 * Keep the head of a window that collected more than a turn may carry, and hand
 * the tail to the collecting successor. False when the claim has moved on.
 */
// cm:guard ONE transaction and the shrink FIRST, under the claim: a successor opened before the shrink committed would cover seqs this window still claims, and two windows answering one message is the double reply the claim exists to prevent. A shrink that touches no row means the lease moved on, and the caller must then take no turn (ISS-1086 criteria 23, 24).
// cm:guard its own upsert and not `openOrExtendWindow`, because this is the ONE writer allowed to lower `first_seq` and `opened_at`: the heartbeat opens ranges over messages already routed, and an inbound collector that lowered `first_seq` on conflict would swallow that range into a window that answers it twice. Here the tail has been waiting since its first message arrived, so the successor's hold starts there and counts the wait the head already cost it; its quiet clock starts at the tail's LAST arrival, because a successor stamped with the first would read as quiet on the spot while the room was still typing (whole-set review F2).
export async function splitWindowTail(
  args: SplitTailArgs,
  dbi: typeof defaultDb = defaultDb,
): Promise<boolean> {
  return dbi.transaction(async (tx) => {
    const shrunk = await tx
      .update(conversationWindows)
      .set({ lastSeq: args.prefixLastSeq, cutReason: 'overflow' })
      .where(
        and(
          eq(conversationWindows.id, args.windowId),
          isNull(conversationWindows.closedAt),
          heldBy(args.claim),
        ),
      )
      .returning({ id: conversationWindows.id });
    if (shrunk.length === 0) return false;
    await tx
      .insert(conversationWindows)
      .values({
        conversationId: args.conversationId,
        projectId: args.projectId,
        adapter: args.adapter,
        openedAt: args.tail.firstAt,
        extendedAt: args.tail.lastAt,
        firstSeq: args.tail.firstSeq,
        lastSeq: args.tail.lastSeq,
        origin: 'inbound',
      })
      .onConflictDoUpdate({
        target: conversationWindows.conversationId,
        targetWhere: sql`claimed_at IS NULL AND closed_at IS NULL`,
        set: {
          firstSeq: sql`least(${conversationWindows.firstSeq}, excluded.first_seq)`,
          lastSeq: sql`greatest(${conversationWindows.lastSeq}, excluded.last_seq)`,
          openedAt: sql`least(${conversationWindows.openedAt}, excluded.opened_at)`,
          extendedAt: sql`greatest(${conversationWindows.extendedAt}, excluded.extended_at)`,
        },
      });
    return true;
  });
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
 * This conversation's windows, oldest first, for a reader rather than a guard.
 */
// cm:guard it carries the SEQ RANGE and not only the decision, because the two answers a person needs are different: a guard asks what was decided lately, and a screen asks which messages a decision was about. Without the range a silence renders at the end of the thread whatever it was taken over, which is the difference between "it said nothing to THAT" and "it has said nothing since" (ISS-1004 criterion 28).
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
// cm:guard the guards READ this and store nothing of their own: a window's decision is evidence of what was decided, already written for a person to read, and a counter beside it would be a second copy that a missed write silences a room with (ISS-1004 rule 3).
// cm:guard the timestamp comparisons are drizzle OPERATORS and never a `sql` fragment carrying a Date: a fragment's parameter is sent untyped, and `postgres` refuses a Date with "The string argument must be of type string" — so every call carrying a `since` threw, `route-window.ts` caught it, and EVERY window closed `unreachable` over a room that was never asked. It went unseen because the unit lane mocks the executor and no integration case routed a window whose guard reached this (ISS-1004, found by the web adapter's own e2e).
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
