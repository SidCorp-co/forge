import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, users } from '../db/schema.js';
import {
  conversationParticipants,
  conversationPins,
  conversations,
} from '../db/schema-conversations.js';
import { assistantSpeakerLinks } from '../db/schema-speaker-links.js';
import { isActiveMember } from '../ecosystem/index.js';

/** Whether the home project is an active member of the ecosystem. */
export async function homeIsEcosystemMember(
  homeProjectId: string,
  ecosystemId: string,
): Promise<boolean> {
  return isActiveMember(db, homeProjectId, ecosystemId);
}

/** Which of `ids` the user has pinned. */
export async function pinnedBy(userId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: conversationPins.conversationId })
    .from(conversationPins)
    .where(
      and(eq(conversationPins.userId, userId), inArray(conversationPins.conversationId, [...ids])),
    );
  return new Set(rows.map((r) => r.id));
}

/** The caller's live web room about one requirement, the most recently active, or null. */
export async function requirementRoomOf(
  requirementId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, conversations.id),
        eq(conversationParticipants.kind, 'person'),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.removedAt),
      ),
    )
    .where(
      and(
        eq(conversations.requirementId, requirementId),
        eq(conversations.adapter, 'web'),
        isNull(conversations.archivedAt),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  return row?.id ?? null;
}

/** The name a person speaks under in a room: their display name, else their email. */
export async function speakerLabelOf(userId: string): Promise<string | null> {
  const [me] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return me?.displayName ?? me?.email ?? null;
}

/** A person's speaker links, newest first. */
export async function listSpeakerLinks(userId: string) {
  return db
    .select()
    .from(assistantSpeakerLinks)
    .where(eq(assistantSpeakerLinks.userId, userId))
    .orderBy(desc(assistantSpeakerLinks.confirmedAt));
}
