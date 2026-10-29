// Reads and writes of a bound group's channel record (REQ-75 r6), which only the `support` domain
// writes. A channel is one per project and group, whoever answers the group: every room row of that
// project bound to it reads it (BC-41), and so does an outside agent a binding names as its answerer.

import type { ChannelMemberState, ChannelRole } from '@forge/contracts/support-channel';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  supportActions,
  supportChannelCommonIssues,
  supportChannelMembers,
  supportChannelRules,
  supportChannels,
  supportRooms,
} from '../db/schema-support.js';
import { listBindingsForProject } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';

export type ChannelRow = typeof supportChannels.$inferSelect;
export type MemberRow = typeof supportChannelMembers.$inferSelect;
export type RuleRow = typeof supportChannelRules.$inferSelect;
export type CommonIssueRow = typeof supportChannelCommonIssues.$inferSelect;

/** The channel of a project's group: found, or made now. */
export async function ensureChannel(projectId: string, rid: string): Promise<ChannelRow> {
  await db.insert(supportChannels).values({ projectId, rid }).onConflictDoNothing();
  const row = await channelOf(projectId, rid);
  if (!row)
    throw new Error(`support: the channel ${rid} of project ${projectId} did not read back`);
  return row;
}

export async function channelOf(projectId: string, rid: string): Promise<ChannelRow | null> {
  const [row] = await db
    .select()
    .from(supportChannels)
    .where(and(eq(supportChannels.projectId, projectId), eq(supportChannels.rid, rid)))
    .limit(1);
  return row ?? null;
}

/**
 * The groups the project's Rocket.Chat bindings name, switched on or off, oldest binding first: the
 * ones Forge answers (`rids`) and the ones an agent outside Forge answers (`outsideRids`). A binding
 * switched off keeps its groups' records, as a room taken out of its binding does.
 */
async function namedRids(projectId: string): Promise<{ forge: string[]; outside: string[] }> {
  const configs = (await listBindingsForProject(projectId))
    .map((p) => p.binding)
    .filter((b) => b.provider === 'rocketchat')
    .reverse()
    .map((b) => (b.config ?? {}) as RocketChatBindingConfig);
  return {
    forge: configs.flatMap((c) => c.rids ?? []),
    outside: configs.flatMap((c) => c.outsideRids ?? []),
  };
}

/** Whether a binding of the project names the group as answered by an agent outside Forge. */
export async function answeredOutside(projectId: string, rid: string): Promise<boolean> {
  return (await namedRids(projectId)).outside.includes(rid);
}

/**
 * The groups a project's bindings attach, each once: every group a room of the project was declared
 * for, oldest first, then every other group a binding of the project names.
 */
export async function boundRidsOf(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ rid: supportRooms.rid, first: sql<Date>`min(${supportRooms.createdAt})` })
    .from(supportRooms)
    .where(eq(supportRooms.projectId, projectId))
    .groupBy(supportRooms.rid)
    .orderBy(asc(sql`min(${supportRooms.createdAt})`));
  const named = await namedRids(projectId);
  return [...new Set([...rows.map((r) => r.rid), ...named.forge, ...named.outside])];
}

/**
 * Whether the group has a channel record in this project, whoever answers it: a room of the project
 * was declared for it, or a binding of the project names it.
 */
export async function channelIsBound(projectId: string, rid: string): Promise<boolean> {
  if ((await roomsOfChannel(projectId, rid)).length > 0) return true;
  const named = await namedRids(projectId);
  return named.forge.includes(rid) || named.outside.includes(rid);
}

/** The room rows of a project bound to one group: one per bot. */
export async function roomsOfChannel(projectId: string, rid: string) {
  return db
    .select()
    .from(supportRooms)
    .where(and(eq(supportRooms.projectId, projectId), eq(supportRooms.rid, rid)))
    .orderBy(asc(supportRooms.createdAt));
}

/** An outside agent's declaration of itself on the channel (BC-42): replaces the one before. */
export async function declareChannelAgent(
  channelId: string,
  agent: { role: string; box: string; address: string; by: string },
): Promise<ChannelRow> {
  const [row] = await db
    .update(supportChannels)
    .set({
      agentRole: agent.role,
      agentBox: agent.box,
      agentAddress: agent.address,
      agentDeclaredAt: new Date(),
      agentDeclaredBy: agent.by,
    })
    .where(eq(supportChannels.id, channelId))
    .returning();
  if (!row) throw new Error(`support: the channel ${channelId} took no agent declaration`);
  return row;
}

export async function membersOf(channelId: string): Promise<MemberRow[]> {
  return db
    .select()
    .from(supportChannelMembers)
    .where(eq(supportChannelMembers.channelId, channelId))
    .orderBy(asc(supportChannelMembers.username));
}

/** A member by username, as the chat server writes it in any case. */
export async function memberOf(channelId: string, username: string): Promise<MemberRow | null> {
  const [row] = await db
    .select()
    .from(supportChannelMembers)
    .where(
      and(
        eq(supportChannelMembers.channelId, channelId),
        sql`lower(${supportChannelMembers.username}) = ${username.toLowerCase()}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Write a member. An inference (`state` inferred) lands only on a member no person confirmed: the
 * guard is in the statement, so a correction racing it wins. Answers the row, or null when a
 * confirmed member stood.
 */
export async function writeMember(input: {
  channelId: string;
  username: string;
  roles: readonly ChannelRole[];
  askFor: string | null | undefined;
  state: ChannelMemberState;
  confirmedBy: string | null;
  sourceMessage: string | null;
}): Promise<MemberRow | null> {
  const existing = await memberOf(input.channelId, input.username);
  const username = existing?.username ?? input.username;
  const values = {
    channelId: input.channelId,
    username,
    roles: [...input.roles],
    askFor: input.askFor === undefined ? (existing?.askFor ?? null) : input.askFor,
    state: input.state,
    confirmedBy: input.confirmedBy,
    sourceMessage: input.sourceMessage,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(supportChannelMembers)
    .values(values)
    .onConflictDoUpdate({
      target: [supportChannelMembers.channelId, supportChannelMembers.username],
      set: values,
      ...(input.state === 'inferred'
        ? { setWhere: sql`${supportChannelMembers.state} <> 'confirmed'` }
        : {}),
    })
    .returning();
  return row ?? null;
}

export async function rulesOf(channelId: string): Promise<RuleRow[]> {
  return db
    .select()
    .from(supportChannelRules)
    .where(and(eq(supportChannelRules.channelId, channelId), isNull(supportChannelRules.removedAt)))
    .orderBy(asc(supportChannelRules.createdAt));
}

/** Add a rule; the one already linked to the same message is answered instead of a second. */
export async function addRule(values: typeof supportChannelRules.$inferInsert): Promise<RuleRow> {
  const [row] = await db
    .insert(supportChannelRules)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [same] = await db
    .select()
    .from(supportChannelRules)
    .where(
      and(
        eq(supportChannelRules.channelId, values.channelId),
        eq(supportChannelRules.messageId, String(values.messageId)),
        isNull(supportChannelRules.removedAt),
      ),
    )
    .limit(1);
  if (!same) throw new Error('support: a rule neither inserted nor read back');
  return same;
}

export async function removeRule(channelId: string, ruleId: string): Promise<boolean> {
  const rows = await db
    .update(supportChannelRules)
    .set({ removedAt: new Date() })
    .where(
      and(
        eq(supportChannelRules.channelId, channelId),
        eq(supportChannelRules.id, ruleId),
        isNull(supportChannelRules.removedAt),
      ),
    )
    .returning({ id: supportChannelRules.id });
  return rows.length > 0;
}

export async function commonIssuesOf(channelId: string): Promise<CommonIssueRow[]> {
  return db
    .select()
    .from(supportChannelCommonIssues)
    .where(
      and(
        eq(supportChannelCommonIssues.channelId, channelId),
        isNull(supportChannelCommonIssues.removedAt),
      ),
    )
    .orderBy(desc(supportChannelCommonIssues.updatedAt));
}

export async function commonIssueByKey(
  channelId: string,
  questionKey: string,
): Promise<CommonIssueRow | null> {
  const [row] = await db
    .select()
    .from(supportChannelCommonIssues)
    .where(
      and(
        eq(supportChannelCommonIssues.channelId, channelId),
        eq(supportChannelCommonIssues.questionKey, questionKey),
        isNull(supportChannelCommonIssues.removedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Write a common issue whole: one per question, its one answer, every thread it was asked in. */
export async function writeCommonIssue(input: {
  channelId: string;
  question: string;
  questionKey: string;
  answer: string;
  threads: readonly string[];
  feedbackId: string | null;
}): Promise<CommonIssueRow> {
  const now = new Date();
  const [row] = await db
    .insert(supportChannelCommonIssues)
    .values({ ...input, threads: [...input.threads], updatedAt: now })
    .onConflictDoUpdate({
      target: [supportChannelCommonIssues.channelId, supportChannelCommonIssues.questionKey],
      targetWhere: sql`removed_at IS NULL`,
      set: {
        question: input.question,
        answer: input.answer,
        threads: [...input.threads],
        feedbackId: input.feedbackId,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error('support: a common issue neither inserted nor updated');
  return row;
}

/** The threads among `threads` that a member wrote in, in any room of the channel. */
export async function recordedThreads(
  roomIds: readonly string[],
  threads: readonly string[],
): Promise<Set<string>> {
  if (roomIds.length === 0 || threads.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ thread: supportActions.thread })
    .from(supportActions)
    .where(
      and(
        inArray(supportActions.roomId, [...roomIds]),
        inArray(supportActions.thread, [...threads]),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
      ),
    );
  return new Set(rows.map((r) => r.thread));
}

/** A member's message a room received, by its Rocket.Chat id: who wrote it, and in which thread. */
export async function memberMessage(
  roomId: string,
  messageId: string,
): Promise<{ authorKey: string; author: string | null; thread: string } | null> {
  const [row] = await db
    .select({
      key: supportActions.actorKey,
      label: supportActions.actorLabel,
      thread: supportActions.thread,
    })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
        eq(supportActions.externalId, messageId),
      ),
    )
    .limit(1);
  return row?.key ? { authorKey: row.key, author: row.label, thread: row.thread } : null;
}

/** Whether any room of the channel announced since a time (BC-39). */
export async function announcedSince(roomIds: readonly string[], since: Date): Promise<boolean> {
  if (roomIds.length === 0) return false;
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        inArray(supportActions.roomId, [...roomIds]),
        eq(supportActions.kind, 'announced'),
        gte(supportActions.createdAt, since),
      ),
    )
    .limit(1);
  return Boolean(row);
}
