// Reads and writes of a bound group's channel record (REQ-75 r6), which only the `support` domain
// writes. A channel is one per project and group, whoever answers the group: every room row of that
// project bound to it reads it (BC-41), and so does an outside agent a binding names as its answerer.

import type { ChannelMemberState, ChannelRole } from '@forge/contracts/support-channel';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
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
import { heldElsewhere, heldRoomsOfProject } from './rooms.js';

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
  // the groups of the rooms the project holds, oldest first: a released room is none (ISS-933)
  const held = await heldRoomsOfProject(projectId);
  const named = await namedRids(projectId);
  const kept = [];
  for (const rid of [...named.forge, ...named.outside]) {
    if (!(await releasedGroup(projectId, rid))) kept.push(rid);
  }
  return [...new Set([...held.map((r) => r.rid), ...kept])];
}

/**
 * A group a project's bindings name only while switched off, or not at all, and another binding now
 * holds (ISS-933): released, so no channel of the project. A group switched off that nobody took
 * keeps its record, as a room taken out of its binding does.
 */
async function releasedGroup(projectId: string, rid: string): Promise<boolean> {
  const active = (await listBindingsForProject(projectId)).some(
    (p) =>
      p.binding.provider === 'rocketchat' &&
      p.binding.active &&
      p.connection.active &&
      [
        ...((p.binding.config as RocketChatBindingConfig | null)?.rids ?? []),
        ...((p.binding.config as RocketChatBindingConfig | null)?.outsideRids ?? []),
      ].includes(rid),
  );
  return !active && (await heldElsewhere(rid, { projectId }));
}

/**
 * Whether the group has a channel record in this project, whoever answers it: a room of the project
 * was declared for it, or a binding of the project names it; never a group released to another
 * binding (ISS-933).
 */
export async function channelIsBound(projectId: string, rid: string): Promise<boolean> {
  if (await releasedGroup(projectId, rid)) return false;
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

/**
 * The writers the channel's groups heard among `names`, each by the user id the chat server signed
 * and the username its latest message carried (ISS-1089): a name matches either. A session that
 * named a member by `from.id` wrote the record under that id; this pairs it with the username the
 * room shows and a reply mentions.
 */
export async function writersNamed(
  channelId: string,
  names: readonly string[],
): Promise<{ key: string; username: string }[]> {
  if (names.length === 0) return [];
  const [channel] = await db
    .select({ projectId: supportChannels.projectId, rid: supportChannels.rid })
    .from(supportChannels)
    .where(eq(supportChannels.id, channelId))
    .limit(1);
  if (!channel) return [];
  const roomIds = (await roomsOfChannel(channel.projectId, channel.rid)).map((r) => r.id);
  if (roomIds.length === 0) return [];
  const lower = names.map((n) => n.toLowerCase());
  const heard = and(
    inArray(supportActions.roomId, roomIds),
    eq(supportActions.kind, 'message_in'),
    eq(supportActions.actorKind, 'member'),
    isNotNull(supportActions.actorKey),
    isNotNull(supportActions.actorLabel),
  );
  const keys = await db
    .selectDistinct({ key: supportActions.actorKey })
    .from(supportActions)
    .where(
      and(
        heard,
        or(
          inArray(supportActions.actorKey, [...names]),
          inArray(sql`lower(${supportActions.actorLabel})`, lower),
        ),
      ),
    );
  if (keys.length === 0) return [];
  // a username can change: each writer is known by the one its latest message carried
  const latest = await db
    .selectDistinctOn([supportActions.actorKey], {
      key: supportActions.actorKey,
      username: supportActions.actorLabel,
    })
    .from(supportActions)
    .where(
      and(
        heard,
        inArray(
          supportActions.actorKey,
          keys.map((k) => k.key as string),
        ),
      ),
    )
    .orderBy(supportActions.actorKey, desc(supportActions.createdAt));
  return latest
    .map((w) => ({ key: w.key as string, username: w.username as string }))
    .filter((w) => names.includes(w.key) || lower.includes(w.username.toLowerCase()));
}

/**
 * The username each of `values` is known by in the channel's groups, for a value that is a
 * writer's user id (ISS-1089); a value that is no writer's id is absent.
 */
export async function usernamesOfIds(
  channelId: string,
  values: readonly string[],
): Promise<Map<string, string>> {
  const writers = await writersNamed(channelId, values);
  return new Map(writers.filter((w) => values.includes(w.key)).map((w) => [w.key, w.username]));
}

/**
 * A member by username, as the chat server writes it in any case, or by the user id it signs: a
 * member the record lists by id is found by their username too, and one listed by username by
 * their id (ISS-1089).
 */
export async function memberOf(channelId: string, username: string): Promise<MemberRow | null> {
  const exact = await memberNamedIn(channelId, [username]);
  if (exact) return exact;
  const aliases = (await writersNamed(channelId, [username])).flatMap((w) =>
    w.key === username ? [w.username] : [w.key],
  );
  return memberNamedIn(channelId, aliases);
}

async function memberNamedIn(channelId: string, names: readonly string[]) {
  if (names.length === 0) return null;
  const [row] = await db
    .select()
    .from(supportChannelMembers)
    .where(
      and(
        eq(supportChannelMembers.channelId, channelId),
        inArray(
          sql`lower(${supportChannelMembers.username})`,
          names.map((n) => n.toLowerCase()),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Write a member, under the username the chat server shows (ISS-1089): one named by the user id a
 * message of the channel signed is written under that writer's username, and a row the record held
 * under that id is carried over to it. An inference (`state` inferred) lands only on a member no
 * person confirmed: the guard is in the statement, so a correction racing it wins. Answers the row,
 * or null when a confirmed member stood.
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
  const carried =
    (await usernamesOfIds(input.channelId, [input.username])).get(input.username) ?? input.username;
  let held = await memberOf(input.channelId, carried);
  // a row the record held under the writer's id takes their username; found by alias, no row holds
  // that username yet, so the key is free
  if (
    held &&
    held.username.toLowerCase() !== carried.toLowerCase() &&
    (await usernamesOfIds(input.channelId, [held.username])).has(held.username)
  ) {
    await db
      .update(supportChannelMembers)
      .set({ username: carried })
      .where(
        and(
          eq(supportChannelMembers.channelId, input.channelId),
          eq(supportChannelMembers.username, held.username),
        ),
      );
    held = { ...held, username: carried };
  }
  const username = held?.username ?? carried;
  const values = {
    channelId: input.channelId,
    username,
    roles: [...input.roles],
    askFor: input.askFor === undefined ? (held?.askFor ?? null) : input.askFor,
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

/**
 * Add a rule; a rule already linked to the same message is that rule, read again from it: its text
 * takes this reading.
 */
export async function addRule(values: typeof supportChannelRules.$inferInsert): Promise<RuleRow> {
  if (values.messageId == null) {
    const [row] = await db.insert(supportChannelRules).values(values).returning();
    if (!row) throw new Error('support: a rule was not inserted');
    return row;
  }
  const [row] = await db
    .insert(supportChannelRules)
    .values(values)
    .onConflictDoUpdate({
      target: [supportChannelRules.channelId, supportChannelRules.messageId],
      targetWhere: sql`removed_at IS NULL AND message_id IS NOT NULL`,
      set: { text: values.text },
    })
    .returning();
  if (!row) throw new Error('support: a rule neither inserted nor updated');
  return row;
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
): Promise<{ authorKey: string; author: string | null; thread: string; at: Date } | null> {
  const [row] = await db
    .select({
      key: supportActions.actorKey,
      label: supportActions.actorLabel,
      thread: supportActions.thread,
      at: supportActions.createdAt,
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
  return row?.key
    ? { authorKey: row.key, author: row.label, thread: row.thread, at: row.at }
    : null;
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
