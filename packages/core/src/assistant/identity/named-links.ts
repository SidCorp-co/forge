// ISS-976: a project admin names the Forge account a chat account is, where the chat server cannot
// match the speaker by address (FB-563: it reports none for the agenfold owner). The naming is the
// admin's word, recorded with who said it, when and why; it lends the named account's authority
// only in the admin's own project, and it is undone by keeping the row with who undid it and why.
// Nothing here guesses: the account is named by its id, and the chat id is one the server knows.

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { SpeakerRefusal } from '../../conversations/index.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { assistantSpeakerLinks, speakerLinkNamings } from '../../db/schema-speaker-links.js';
import { can, projectResource } from '../../permissions/index.js';
import type { SpeakerProfile } from './directory.js';

export type SpeakerNaming = typeof speakerLinkNamings.$inferSelect;

interface SpeakerKey {
  source: string;
  namespace: string;
  externalId: string;
}

const standing = (projectId: string, ref: SpeakerKey) =>
  and(
    eq(speakerLinkNamings.projectId, projectId),
    eq(speakerLinkNamings.source, ref.source as SpeakerProfile['source']),
    eq(speakerLinkNamings.externalNamespace, ref.namespace),
    eq(speakerLinkNamings.externalId, ref.externalId),
    isNull(speakerLinkNamings.undoneAt),
  );

/** The Forge user a project admin named for this speaker in `projectId`, or null. */
export async function namedUserOf(ref: SpeakerKey, projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: speakerLinkNamings.userId })
    .from(speakerLinkNamings)
    .where(standing(projectId, ref))
    .limit(1);
  return row?.userId ?? null;
}

/** Why `userId` cannot be named on `projectId`, or null where it can. */
async function notNameable(projectId: string, userId: string): Promise<SpeakerRefusal | null> {
  const [user] = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const writes =
    user?.kind === 'human' &&
    (await can(
      { userId, agency: 'human', tokenId: null, onBehalfOf: null },
      'project.write',
      projectResource(projectId),
    ));
  if (writes) return null;
  return {
    code: 'SPEAKER_NAMED_NOT_A_MEMBER',
    message: user
      ? `Forge account ${userId} is ${user.kind === 'human' ? 'a person without write access to this project' : 'an agent, not a person'}, so no chat account can be named as it here. Name a person who holds write on the project, or add them to it first.`
      : `no Forge account has id ${userId}. Name the account by the id its profile shows; a name or an address is never matched.`,
  };
}

/**
 * A project admin's naming of the Forge account `userId` for the chat account `profile`, or the
 * refusal naming why not: the account holds no write here, the chat account is already linked by
 * its owner, or a naming already stands in this project.
 */
export async function nameSpeaker(args: {
  projectId: string;
  profile: SpeakerProfile;
  userId: string;
  namedBy: string;
  reason: string;
}): Promise<{ ok: true; naming: SpeakerNaming } | { ok: false; refusal: SpeakerRefusal }> {
  const { projectId, profile, userId } = args;
  const why = await notNameable(projectId, userId);
  if (why) return { ok: false, refusal: why };
  const [linked] = await db
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
  if (linked) {
    return {
      ok: false,
      refusal: {
        code: 'SPEAKER_ALREADY_LINKED',
        message:
          linked.userId === userId
            ? 'that chat account is already linked to this Forge account by its own owner; nothing needs naming.'
            : 'that chat account is already linked to another Forge account by its own owner, and a naming never overrides that link.',
      },
    };
  }
  const [row] = await db
    .insert(speakerLinkNamings)
    .values({
      projectId,
      source: profile.source,
      externalNamespace: profile.namespace,
      externalId: profile.externalId,
      externalLabel: profile.username,
      userId,
      namedBy: args.namedBy,
      reason: args.reason,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { ok: true, naming: row };
  const [held] = await db
    .select()
    .from(speakerLinkNamings)
    .where(standing(projectId, profile))
    .limit(1);
  return {
    ok: false,
    refusal: {
      code: 'SPEAKER_ALREADY_LINKED',
      message: `that chat account is already named as Forge account ${held?.userId ?? 'unknown'} on this project (naming ${held?.id ?? 'unknown'}); undo that naming first to name another.`,
    },
  };
}

/** Undo a naming of this project, keeping the row with who undid it and why. */
export async function undoNaming(args: {
  projectId: string;
  namingId: string;
  by: string;
  reason: string;
}): Promise<{ ok: true; naming: SpeakerNaming } | { ok: false; refusal: SpeakerRefusal }> {
  const [row] = await db
    .update(speakerLinkNamings)
    .set({ undoneAt: new Date(), undoneBy: args.by, undoReason: args.reason })
    .where(
      and(
        eq(speakerLinkNamings.id, args.namingId),
        eq(speakerLinkNamings.projectId, args.projectId),
        isNull(speakerLinkNamings.undoneAt),
      ),
    )
    .returning();
  if (row) return { ok: true, naming: row };
  const [held] = await db
    .select({ undoneAt: speakerLinkNamings.undoneAt })
    .from(speakerLinkNamings)
    .where(
      and(
        eq(speakerLinkNamings.id, args.namingId),
        eq(speakerLinkNamings.projectId, args.projectId),
      ),
    )
    .limit(1);
  return {
    ok: false,
    refusal: held
      ? {
          code: 'SPEAKER_NAMING_UNDONE',
          message: `naming ${args.namingId} was undone at ${held.undoneAt?.toISOString()}; nothing changed.`,
        }
      : {
          code: 'SPEAKER_NAMING_UNKNOWN',
          message: `this project holds no naming ${args.namingId}; GET its speaker-links/named lists them.`,
        },
  };
}

/** Every naming of a project, standing and undone, newest first. */
export async function namingsOf(projectId: string): Promise<SpeakerNaming[]> {
  return db
    .select()
    .from(speakerLinkNamings)
    .where(eq(speakerLinkNamings.projectId, projectId))
    .orderBy(desc(speakerLinkNamings.namedAt));
}
