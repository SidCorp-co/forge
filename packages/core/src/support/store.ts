// Reads and writes of the support tables, which only the `support` domain writes.

import type { FeedbackPhase } from '@forge/contracts/feedback';
import type {
  SupportActionKind,
  SupportActorKind,
  SupportFixState,
} from '@forge/contracts/support';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  supportActions,
  supportFeedbackLinks,
  supportFixes,
  supportRooms,
} from '../db/schema-support.js';

export type RoomRow = typeof supportRooms.$inferSelect;
export type ActionRow = typeof supportActions.$inferSelect;
export type FixRow = typeof supportFixes.$inferSelect;
export type LinkRow = typeof supportFeedbackLinks.$inferSelect;
type Exec = Tx | typeof db;

export async function roomOfBinding(bindingId: string, exec: Exec = db): Promise<RoomRow | null> {
  const [row] = await exec
    .select()
    .from(supportRooms)
    .where(eq(supportRooms.bindingId, bindingId))
    .limit(1);
  return row ?? null;
}

export async function roomById(roomId: string): Promise<RoomRow | null> {
  const [row] = await db.select().from(supportRooms).where(eq(supportRooms.id, roomId)).limit(1);
  return row ?? null;
}

export async function roomOfPrincipal(userId: string): Promise<RoomRow | null> {
  const [row] = await db
    .select()
    .from(supportRooms)
    .where(eq(supportRooms.principalUserId, userId))
    .limit(1);
  return row ?? null;
}

export async function roomsOfProject(projectId: string): Promise<RoomRow[]> {
  return db
    .select()
    .from(supportRooms)
    .where(eq(supportRooms.projectId, projectId))
    .orderBy(asc(supportRooms.createdAt));
}

export async function insertRoom(
  tx: Tx,
  values: typeof supportRooms.$inferInsert,
): Promise<RoomRow> {
  const [row] = await tx.insert(supportRooms).values(values).returning();
  if (!row) throw new Error('support: inserting a room returned no row');
  return row;
}

export async function setRoomSession(tx: Exec, roomId: string, sessionId: string): Promise<void> {
  await tx.update(supportRooms).set({ sessionId }).where(eq(supportRooms.id, roomId));
}

export interface NewAction {
  roomId: string;
  projectId: string;
  conversationId: string | null;
  thread: string;
  kind: SupportActionKind;
  actorKind: SupportActorKind;
  actorKey?: string | null;
  actorLabel?: string | null;
  tool?: string | null;
  input?: unknown;
  output?: unknown;
  externalId?: string | null;
  fixId?: string | null;
  feedbackId?: string | null;
  /** A `message_in` that is not for the session (a confirm, one past the limit) is taken at once. */
  deliveredAt?: Date | null;
}

export async function insertAction(action: NewAction, exec: Exec = db): Promise<ActionRow | null> {
  const [row] = await exec
    .insert(supportActions)
    .values({
      ...action,
      actorKey: action.actorKey ?? null,
      actorLabel: action.actorLabel ?? null,
      tool: action.tool ?? null,
      input: action.input ?? null,
      output: action.output ?? null,
      externalId: action.externalId ?? null,
      fixId: action.fixId ?? null,
      feedbackId: action.feedbackId ?? null,
      deliveredAt: action.deliveredAt ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Take every undelivered inbound message of a room for one turn, oldest first. */
export async function claimUndelivered(roomId: string, at: Date): Promise<ActionRow[]> {
  return db
    .update(supportActions)
    .set({ deliveredAt: at })
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        isNull(supportActions.deliveredAt),
      ),
    )
    .returning()
    .then((rows) => rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
}

/** Give back what a turn took when the turn never reached its box. */
export async function unclaim(ids: readonly string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(supportActions)
    .set({ deliveredAt: null })
    .where(and(inArray(supportActions.id, [...ids]), eq(supportActions.deliveredAt, at)));
}

/** The oldest inbound message of a room no turn has taken. */
export async function oldestUndelivered(roomId: string): Promise<ActionRow | null> {
  const [row] = await db
    .select()
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        isNull(supportActions.deliveredAt),
      ),
    )
    .orderBy(asc(supportActions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function hasUndelivered(roomId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        isNull(supportActions.deliveredAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Rooms holding an inbound message no turn has taken. */
export async function roomsWithUndelivered(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ roomId: supportActions.roomId })
    .from(supportActions)
    .where(and(eq(supportActions.kind, 'message_in'), isNull(supportActions.deliveredAt)));
  return rows.map((r) => r.roomId);
}

/** The inbound messages one member sent in a room since a time, for the hourly limit. */
export async function memberMessagesSince(
  roomId: string,
  actorKey: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKey, actorKey),
        gte(supportActions.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

/** Whether the room was told of a member's limit since a time, so it is told once. */
export async function limitToldSince(
  roomId: string,
  actorKey: string,
  since: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'refused'),
        eq(supportActions.actorKey, actorKey),
        eq(supportActions.tool, 'limit'),
        gte(supportActions.createdAt, since),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The accounts that wrote in a thread, with the name they wrote under, first writer first. */
export async function threadMembers(
  roomId: string,
  thread: string,
): Promise<{ key: string; label: string | null }[]> {
  const rows = await db
    .select({ key: supportActions.actorKey, label: supportActions.actorLabel })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.thread, thread),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
      ),
    )
    .orderBy(asc(supportActions.createdAt));
  const seen = new Map<string, string | null>();
  for (const r of rows) if (r.key && !seen.has(r.key)) seen.set(r.key, r.label);
  return [...seen].map(([key, label]) => ({ key, label }));
}

/** The conversation one thread is recorded in, read off its first action. */
export async function threadConversation(roomId: string, thread: string): Promise<string | null> {
  const [row] = await db
    .select({ conversationId: supportActions.conversationId })
    .from(supportActions)
    .where(and(eq(supportActions.roomId, roomId), eq(supportActions.thread, thread)))
    .orderBy(asc(supportActions.createdAt))
    .limit(1);
  return row?.conversationId ?? null;
}

/** The threads of a room most recently written in, newest first. */
export async function recentThreads(roomId: string, limit: number): Promise<string[]> {
  const rows = await db
    .select({ thread: supportActions.thread, last: sql<Date>`max(${supportActions.createdAt})` })
    .from(supportActions)
    .where(eq(supportActions.roomId, roomId))
    .groupBy(supportActions.thread)
    .orderBy(desc(sql`max(${supportActions.createdAt})`))
    .limit(limit);
  return rows.map((r) => r.thread);
}

export async function actionsOfRoom(roomId: string, limit: number): Promise<ActionRow[]> {
  return db
    .select()
    .from(supportActions)
    .where(eq(supportActions.roomId, roomId))
    .orderBy(asc(supportActions.createdAt))
    .limit(limit);
}

export async function insertFix(
  values: Omit<typeof supportFixes.$inferInsert, 'state' | 'decidedAt' | 'result'>,
): Promise<FixRow | null> {
  const [row] = await db.insert(supportFixes).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

export async function pendingFixByCode(roomId: string, code: string): Promise<FixRow | null> {
  const [row] = await db
    .select()
    .from(supportFixes)
    .where(
      and(
        eq(supportFixes.roomId, roomId),
        eq(supportFixes.code, code),
        eq(supportFixes.state, 'pending'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Move a pending fix on; null when another confirm or the expiry already moved it. */
export async function decideFix(
  fixId: string,
  to: Exclude<SupportFixState, 'pending'>,
  at: Date,
): Promise<FixRow | null> {
  const [row] = await db
    .update(supportFixes)
    .set({ state: to, decidedAt: at })
    .where(and(eq(supportFixes.id, fixId), eq(supportFixes.state, 'pending')))
    .returning();
  return row ?? null;
}

export async function settleFixResult(
  fixId: string,
  state: 'ran' | 'failed',
  result: unknown,
): Promise<void> {
  await db.update(supportFixes).set({ state, result }).where(eq(supportFixes.id, fixId));
}

/** Fixes a member confirmed since a time, for the daily limit. */
export async function fixesConfirmedSince(
  roomId: string,
  askerKey: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(supportFixes)
    .where(
      and(
        eq(supportFixes.roomId, roomId),
        eq(supportFixes.askerKey, askerKey),
        inArray(supportFixes.state, ['ran', 'failed']),
        gte(supportFixes.decidedAt, since),
      ),
    );
  return row?.n ?? 0;
}

/** Pending fixes past their expiry. */
export async function expiredPendingFixes(now: Date): Promise<FixRow[]> {
  return db
    .select()
    .from(supportFixes)
    .where(and(eq(supportFixes.state, 'pending'), lt(supportFixes.expiresAt, now)));
}

export async function insertLink(
  values: typeof supportFeedbackLinks.$inferInsert,
  exec: Exec = db,
): Promise<void> {
  await exec.insert(supportFeedbackLinks).values(values).onConflictDoNothing();
}

export async function openLinksOfProject(projectId: string): Promise<LinkRow[]> {
  return db
    .select()
    .from(supportFeedbackLinks)
    .where(
      and(eq(supportFeedbackLinks.projectId, projectId), isNull(supportFeedbackLinks.closedAt)),
    );
}

/** Every project holding a link still followed. */
export async function projectsWithOpenLinks(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: supportFeedbackLinks.projectId })
    .from(supportFeedbackLinks)
    .where(isNull(supportFeedbackLinks.closedAt));
  return rows.map((r) => r.projectId);
}

/** Move a link to a phase from the one it was read at; false when another delivery already did. */
export async function advanceLink(
  feedbackId: string,
  from: FeedbackPhase,
  to: FeedbackPhase,
  closed: boolean,
): Promise<boolean> {
  const rows = await db
    .update(supportFeedbackLinks)
    .set({ lastPhase: to, ...(closed ? { closedAt: new Date() } : {}) })
    .where(
      and(
        eq(supportFeedbackLinks.feedbackId, feedbackId),
        eq(supportFeedbackLinks.lastPhase, from),
        isNull(supportFeedbackLinks.closedAt),
      ),
    )
    .returning({ id: supportFeedbackLinks.feedbackId });
  return rows.length > 0;
}

/** Whether a room was told its session is offline since a time, so it is told once. */
export async function offlineToldSince(roomId: string, since: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'refused'),
        eq(supportActions.tool, 'offline'),
        gt(supportActions.createdAt, since),
      ),
    )
    .limit(1);
  return Boolean(row);
}
