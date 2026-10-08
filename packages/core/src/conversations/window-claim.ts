/**
 * The writes a core makes on a window it has claimed. Each is conditional on the
 * claim it was handed, so a core whose lease lapsed writes nothing over the core
 * that took the window from it.
 */

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import {
  type ConversationAdapter,
  type ConversationWindowDecision,
  conversationWindows,
} from '../db/schema-conversations.js';
import type { Executor } from './db-executor.js';
import { type ConversationWindowRow, type WindowClaim, windowSelection } from './windows.js';

function heldBy(claim: WindowClaim) {
  return and(
    eq(conversationWindows.claimedAt, claim.claimedAt),
    eq(conversationWindows.claimedBy, claim.claimedBy),
  );
}

/** Close a claimed window under the decision that was taken. */
export async function closeWindow(
  args: {
    windowId: string;
    decision: ConversationWindowDecision;
    detail?: unknown;
    claim: WindowClaim;
  },
  tx: Executor = defaultDb,
): Promise<ConversationWindowRow | null> {
  const [row] = await tx
    .update(conversationWindows)
    .set({
      closedAt: new Date(),
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
    .returning(windowSelection);
  return (row as ConversationWindowRow | undefined) ?? null;
}

/**
 * Write how the rest of a continued turn settled onto the window it closed under. A window closed on
 * a partial reply carries `continuing: true` and keeps its record open for exactly this one write:
 * `continued` names the rest's decision and the blocks it dropped, and `continuing` turns false. A
 * second write, a window never closed as continuing, or a claim that moved on writes nothing.
 */
export async function settleContinuedWindow(
  args: { windowId: string; claim: WindowClaim; continued: Record<string, unknown> },
  tx: Executor = defaultDb,
): Promise<boolean> {
  const rows = await tx
    .update(conversationWindows)
    .set({
      decisionDetail: sql`${conversationWindows.decisionDetail} || jsonb_build_object('continuing', false, 'continued', ${JSON.stringify(args.continued)}::jsonb)`,
    })
    .where(
      and(
        eq(conversationWindows.id, args.windowId),
        isNotNull(conversationWindows.closedAt),
        heldBy(args.claim),
        sql`${conversationWindows.decisionDetail} ->> 'continuing' = 'true'`,
      ),
    )
    .returning({ id: conversationWindows.id });
  return rows.length > 0;
}

interface SplitTailArgs {
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

/** Write down that this window's reply is about to be handed to the transport. */
export async function reserveDelivery(windowId: string, claim: WindowClaim): Promise<boolean> {
  const rows = await defaultDb
    .update(conversationWindows)
    .set({ deliveryReservedAt: new Date() })
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

/** Give a claimed window back without deciding anything. */
export async function releaseWindow(windowId: string, claim: WindowClaim): Promise<void> {
  await defaultDb
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
