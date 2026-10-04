import { randomUUID } from 'node:crypto';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import { resolveProjectHandle } from '../conversations/handles.js';
import { assertPersonReachesScope, personLabel, settleShape } from '../conversations/membership.js';
import { addHandle, addPerson, removeParticipant } from '../conversations/participants.js';
import { derivedScope } from '../conversations/scope.js';
import { getConversation, openConversationIn } from '../conversations/store.js';
import { db } from '../db/client.js';
import { conversationParticipants, conversationPins } from '../db/schema-conversations.js';
import { assistantSpeakerLinks } from '../db/schema-speaker-links.js';
import { rowIn } from '../requirements/read.js';
import { withMembershipLock } from './conversation-access.js';
import type { SpeakerProfile } from './identity/directory.js';
import { requirementRoomOf } from './read.js';

/** The caller's room about one requirement: the live one they already have, else a new one. */
export async function openRequirementRoom(projectId: string, req: string, userId: string) {
  const requirement = await rowIn(db, projectId, req);
  const existing = await requirementRoomOf(requirement.id, userId);
  if (existing) return { conversation: await getConversation(existing), reused: true as const };
  const conversation = await db.transaction(async (handle) => {
    const tx = handle as unknown as typeof db;
    const room = await openConversationIn(tx, {
      adapter: 'web',
      externalId: randomUUID(),
      shape: 'direct',
      projectId,
      title: `${requirementKey(requirement.reqSeq)} · BA assistant`,
      requirementId: requirement.id,
    });
    await addPerson({ conversationId: room.id, userId, actorUserId: userId, tx });
    await settleShape(tx, room.id);
    return (await getConversation(room.id, tx)) ?? room;
  });
  return { conversation, reused: false as const };
}

export interface OpenWebConversationInput {
  projectId: string;
  title: string | null;
  ecosystemId: string | null;
  userId: string;
  handles: readonly { projectId: string; userId?: string | undefined }[];
  people: readonly string[];
}

/** A new web room opened by `userId`, with the named agents and colleagues in it, its shape settled. */
export async function openWebConversation(input: OpenWebConversationInput) {
  const { userId } = input;
  return db.transaction(async (handle) => {
    const tx = handle as unknown as typeof db;
    const room = await openConversationIn(tx, {
      adapter: 'web',
      externalId: randomUUID(),
      shape: 'direct',
      projectId: input.projectId,
      title: input.title,
      ecosystemId: input.ecosystemId,
    });
    await addPerson({ conversationId: room.id, userId, actorUserId: userId, tx });
    for (const named of input.handles) {
      await addHandle({
        conversationId: room.id,
        handleUserId: named.userId ?? (await resolveProjectHandle(tx, named.projectId)).userId,
        projectId: named.projectId,
        actorUserId: userId,
        tx,
      });
    }
    const scope = await derivedScope(room.id, tx);
    for (const person of input.people) {
      await assertPersonReachesScope(person, scope, tx);
      await addPerson({ conversationId: room.id, userId: person, actorUserId: userId, tx });
    }
    await settleShape(tx, room.id);
    const settled = await getConversation(room.id, tx);
    return settled ?? room;
  });
}

/** Add a person to a room under its membership lock; the room is told who joined. */
export async function addRoomPerson(id: string, actor: string, joining: string): Promise<void> {
  await withMembershipLock(id, actor, async (tx, _room, scope) => {
    await assertPersonReachesScope(joining, scope, tx);
    await addPerson({ conversationId: id, userId: joining, actorUserId: actor, tx });
    await settleShape(tx, id, {
      kind: 'person',
      label: await personLabel(tx, joining),
      verb: 'joined',
    });
  });
}

/** Add a project's agent to a room under its membership lock, which moves the room's shape. */
export async function addRoomHandle(
  id: string,
  actor: string,
  projectId: string,
  userId: string | undefined,
): Promise<void> {
  await withMembershipLock(id, actor, async (tx) => {
    const handleUserId = userId ?? (await resolveProjectHandle(tx, projectId)).userId;
    await addHandle({ conversationId: id, handleUserId, projectId, actorUserId: actor, tx });
    await settleShape(tx, id);
  });
}

/** Take one member of either kind out of a room under its membership lock. */
export async function removeRoomParticipant(
  id: string,
  actor: string,
  participantId: string,
): Promise<void> {
  await withMembershipLock(id, actor, async (tx) => {
    const leaving = await participantLabel(tx, id, participantId);
    await removeParticipant({ conversationId: id, participantId, tx: tx as never });
    if (leaving) await settleShape(tx, id, { ...leaving, verb: 'left' });
  });
}

/** Who a participant row is, for the line the room is told when they leave. */
async function participantLabel(
  tx: Parameters<typeof settleShape>[0],
  conversationId: string,
  participantId: string,
): Promise<{ kind: 'person' | 'handle'; label: string } | null> {
  const [row] = await tx
    .select({
      kind: conversationParticipants.kind,
      userId: conversationParticipants.userId,
      label: conversationParticipants.label,
      externalKey: conversationParticipants.externalKey,
    })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.id, participantId),
        eq(conversationParticipants.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.kind === 'handle')
    return { kind: 'handle', label: row.label ?? row.userId ?? participantId };
  const label = row.userId
    ? await personLabel(tx, row.userId)
    : (row.label ?? row.externalKey ?? participantId);
  return { kind: 'person', label };
}

/** Pin a room for a person; pinning twice is one pin. */
export async function pinConversation(userId: string, conversationId: string): Promise<void> {
  await db.insert(conversationPins).values({ userId, conversationId }).onConflictDoNothing();
}

/** Take a person's pin off a room. */
export async function unpinConversation(userId: string, conversationId: string): Promise<void> {
  await db
    .delete(conversationPins)
    .where(
      and(eq(conversationPins.userId, userId), eq(conversationPins.conversationId, conversationId)),
    );
}

export type SpeakerLinkRow = typeof assistantSpeakerLinks.$inferSelect;

/**
 * A confirmed speaker link for `userId`, or who already holds that speaker: `heldBy` is the
 * holder's user id, null when the row vanished between the conflict and the read.
 */
export async function confirmSpeakerLink(
  profile: SpeakerProfile,
  userId: string,
): Promise<{ ok: true; link: SpeakerLinkRow } | { ok: false; heldBy: string | null }> {
  const [row] = await db
    .insert(assistantSpeakerLinks)
    .values({
      source: profile.source,
      externalNamespace: profile.namespace,
      externalId: profile.externalId,
      externalLabel: profile.username,
      userId,
      confirmedVia: 'channel_email_match',
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { ok: true, link: row };
  const [held] = await db
    .select({ userId: assistantSpeakerLinks.userId })
    .from(assistantSpeakerLinks)
    .where(
      and(
        eq(assistantSpeakerLinks.source, profile.source),
        eq(assistantSpeakerLinks.externalNamespace, profile.namespace),
        eq(assistantSpeakerLinks.externalId, profile.externalId),
      ),
    )
    .limit(1);
  return { ok: false, heldBy: held?.userId ?? null };
}

/** Delete a person's link for one speaker; answers how many rows went. */
export async function unlinkSpeaker(
  userId: string,
  source: SpeakerLinkRow['source'],
  namespace: string,
  externalId: string,
): Promise<number> {
  const deleted = await db
    .delete(assistantSpeakerLinks)
    .where(
      and(
        eq(assistantSpeakerLinks.userId, userId),
        eq(assistantSpeakerLinks.source, source),
        eq(assistantSpeakerLinks.externalNamespace, namespace),
        eq(assistantSpeakerLinks.externalId, externalId),
      ),
    )
    .returning({ id: assistantSpeakerLinks.id });
  return deleted.length;
}
