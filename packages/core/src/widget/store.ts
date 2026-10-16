// The widget's own rows: its principals, its visitor sessions and the drafts they decide.

import type { WidgetFeedbackDraft, WidgetPageContext } from '@forge/contracts/widget';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { widgetDrafts, widgetPrincipals, widgetSessions } from '../db/schema-widget.js';
import { openStatusToken, statusUrlOf } from './tokens.js';

export type SessionRow = typeof widgetSessions.$inferSelect;
export type DraftRow = typeof widgetDrafts.$inferSelect;
type Executor = Tx | typeof db;

export async function principalOf(tx: Executor, bindingId: string): Promise<string | null> {
  const [row] = await tx
    .select({ userId: widgetPrincipals.userId })
    .from(widgetPrincipals)
    .where(eq(widgetPrincipals.bindingId, bindingId))
    .limit(1);
  return row?.userId ?? null;
}

export async function insertPrincipal(
  tx: Tx,
  row: { bindingId: string; projectId: string; userId: string },
): Promise<void> {
  await tx.insert(widgetPrincipals).values(row);
}

export async function insertSession(
  tx: Tx,
  row: typeof widgetSessions.$inferInsert,
): Promise<SessionRow> {
  const [stored] = await tx.insert(widgetSessions).values(row).returning();
  if (!stored) throw new Error('widget: a session insert returned no row');
  return stored;
}

/** A live session by its token's SHA-256: not past its expiry. */
export async function liveSessionByHash(hash: string, now: Date): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(widgetSessions)
    .where(and(eq(widgetSessions.tokenHash, hash), gt(widgetSessions.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

export async function sessionOfConversation(conversationId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(widgetSessions)
    .where(eq(widgetSessions.conversationId, conversationId))
    .limit(1);
  return row ?? null;
}

/**
 * Whether a visitor id names a visitor this binding already saw: a frame may hand back the id it
 * kept, and continues as that visitor; an id the binding never issued is a new visitor.
 */
export async function knownVisitor(bindingId: string, visitorId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: widgetSessions.id })
    .from(widgetSessions)
    .where(and(eq(widgetSessions.bindingId, bindingId), eq(widgetSessions.visitorId, visitorId)))
    .limit(1);
  return row !== undefined;
}

/** The visitor id this binding gave the client user it signed before, so they stay one visitor. */
export async function visitorOfSignedUser(
  bindingId: string,
  signedUserId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ visitorId: widgetSessions.visitorId })
    .from(widgetSessions)
    .where(
      and(eq(widgetSessions.bindingId, bindingId), eq(widgetSessions.signedUserId, signedUserId)),
    )
    .orderBy(desc(widgetSessions.createdAt))
    .limit(1);
  return row?.visitorId ?? null;
}

/** Spend one turn of the conversation's cap; false where the cap is already met. */
export async function spendTurn(tx: Executor, sessionId: string, cap: number): Promise<boolean> {
  const rows = await tx
    .update(widgetSessions)
    .set({ turns: sql`${widgetSessions.turns} + 1` })
    .where(and(eq(widgetSessions.id, sessionId), lt(widgetSessions.turns, cap)))
    .returning({ id: widgetSessions.id });
  return rows.length > 0;
}

export async function setPageContext(
  tx: Executor,
  sessionId: string,
  context: WidgetPageContext,
): Promise<void> {
  await tx
    .update(widgetSessions)
    .set({ pageContext: context })
    .where(eq(widgetSessions.id, sessionId));
}

/** Discard every pending draft of the session and store a new one, as one write. */
export async function replacePendingDraft(
  session: Pick<SessionRow, 'id' | 'projectId'>,
  draft: Pick<DraftRow, 'kind' | 'title' | 'did' | 'saw' | 'expected' | 'whereSeen'>,
): Promise<{ draft: DraftRow; discarded: DraftRow[] }> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const discarded = await tx
      .update(widgetDrafts)
      .set({ state: 'discarded', decidedAt: now })
      .where(and(eq(widgetDrafts.sessionId, session.id), eq(widgetDrafts.state, 'pending')))
      .returning();
    const [stored] = await tx
      .insert(widgetDrafts)
      .values({ sessionId: session.id, projectId: session.projectId, ...draft })
      .returning();
    if (!stored) throw new Error('widget: a draft insert returned no row');
    return { draft: stored, discarded };
  });
}

export async function draftOfSession(sessionId: string, draftId: string): Promise<DraftRow | null> {
  const [row] = await db
    .select()
    .from(widgetDrafts)
    .where(and(eq(widgetDrafts.id, draftId), eq(widgetDrafts.sessionId, sessionId)))
    .limit(1);
  return row ?? null;
}

/** The draft, locked for this transaction, while it still waits on the visitor. */
export async function lockPendingDraft(tx: Tx, draftId: string): Promise<DraftRow | null> {
  const [row] = await tx
    .select()
    .from(widgetDrafts)
    .where(and(eq(widgetDrafts.id, draftId), eq(widgetDrafts.state, 'pending')))
    .for('update')
    .limit(1);
  return row ?? null;
}

export async function markDraftFiled(
  tx: Tx,
  draftId: string,
  filed: { feedbackId: string; feedbackKey: string; statusTokenEnc: Buffer },
): Promise<void> {
  await tx
    .update(widgetDrafts)
    .set({ state: 'filed', ...filed, decidedAt: new Date() })
    .where(eq(widgetDrafts.id, draftId));
}

export async function discardPendingDraft(
  sessionId: string,
  draftId: string,
): Promise<DraftRow | null> {
  const [row] = await db
    .update(widgetDrafts)
    .set({ state: 'discarded', decidedAt: new Date() })
    .where(
      and(
        eq(widgetDrafts.id, draftId),
        eq(widgetDrafts.sessionId, sessionId),
        eq(widgetDrafts.state, 'pending'),
      ),
    )
    .returning();
  return row ?? null;
}

export async function draftsOfSession(sessionId: string): Promise<DraftRow[]> {
  return db
    .select()
    .from(widgetDrafts)
    .where(eq(widgetDrafts.sessionId, sessionId))
    .orderBy(asc(widgetDrafts.createdAt));
}

export async function pendingDraftOf(sessionId: string): Promise<DraftRow | null> {
  const [row] = await db
    .select()
    .from(widgetDrafts)
    .where(and(eq(widgetDrafts.sessionId, sessionId), eq(widgetDrafts.state, 'pending')))
    .orderBy(desc(widgetDrafts.createdAt))
    .limit(1);
  return row ?? null;
}

export function draftView(row: DraftRow): WidgetFeedbackDraft {
  return {
    draftId: row.id,
    title: row.title,
    did: row.did,
    saw: row.saw,
    expected: row.expected,
    whereSeen: row.whereSeen,
    kind: row.kind,
    state: row.state,
    filed:
      row.state === 'filed' && row.feedbackKey && row.statusTokenEnc
        ? {
            feedbackKey: row.feedbackKey,
            statusUrl: statusUrlOf(openStatusToken(row.statusTokenEnc)),
          }
        : null,
  };
}
