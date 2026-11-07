import { and, eq } from 'drizzle-orm';
import type { SpeakerRefusal, SpeakerResolution } from '../../conversations/index.js';
import { db } from '../../db/client.js';
import { type ConversationAdapter, conversationAdapters } from '../../db/schema-conversations.js';
import { assistantSpeakerLinks } from '../../db/schema-speaker-links.js';
import { logger } from '../../lib/logger.js';
import { speakerLinkUrl } from './link-url.js';
import { namedUserOf } from './named-links.js';

export type { SpeakerRefusal, SpeakerResolution };

interface SpeakerRef {
  source: string;
  /** The channel INSTANCE the id belongs to — for Rocket.Chat, the server's host. */
  namespace: string;
  externalId: string;
  /** Display name, for the refusal text alone. */
  label?: string | null | undefined;
}

function speakerPhrase(ref: SpeakerRef): string {
  const label = ref.label?.trim();
  return label
    ? `${ref.source} speaker "${label}" (id ${ref.externalId} on ${ref.namespace})`
    : `${ref.source} speaker id ${ref.externalId} on ${ref.namespace}`;
}

/**
 * The way out, carried in the refusal itself rather than left for the reader to
 * find: what was wrong, who was not found, and the step that fixes it.
 */
function unlinkedMessage(ref: SpeakerRef, projectId?: string): string {
  const url = projectId
    ? speakerLinkUrl({ projectId, source: ref.source, externalId: ref.externalId })
    : null;
  return [
    `${speakerPhrase(ref)} is not linked to a Forge account, so I cannot record an answer as you.`,
    'Sign in to Forge with the same email this chat account uses and confirm the link — mismatched addresses is the usual cause.',
    url
      ? `Confirm it here: ${url}`
      : 'No screen for it yet: POST /api/projects/<id>/speaker-links.',
    "Where the chat account reports no email, a project admin names your Forge account for it (POST /api/projects/<id>/speaker-links/named).",
  ].join(' ');
}

export function isConversationAdapter(value: string): value is ConversationAdapter {
  return (conversationAdapters as readonly string[]).includes(value);
}

export function sourceUnknownRefusal(source: string): SpeakerRefusal {
  return {
    code: 'SPEAKER_SOURCE_UNKNOWN',
    message: `"${source}" is not a chat channel this Forge knows. Valid sources are ${conversationAdapters.join(', ')}.`,
  };
}

/**
 * The ONE resolution. A speaker is the Forge user a confirmed row names, or, in
 * `projectId`, the one that project's admin named for it (ISS-976), or a named
 * refusal — never a guess, never a fallback, never a service identity.
 */
export async function resolveSpeaker(
  ref: SpeakerRef,
  projectId?: string,
): Promise<SpeakerResolution> {
  if (!isConversationAdapter(ref.source)) {
    return { linked: false, refusal: sourceUnknownRefusal(ref.source) };
  }
  const [row] = await db
    .select({ userId: assistantSpeakerLinks.userId })
    .from(assistantSpeakerLinks)
    .where(
      and(
        eq(assistantSpeakerLinks.source, ref.source),
        eq(assistantSpeakerLinks.externalNamespace, ref.namespace),
        eq(assistantSpeakerLinks.externalId, ref.externalId),
      ),
    )
    .limit(1);
  const named = !row && projectId ? await namedUserOf(ref, projectId) : null;
  if (named) return { linked: true, userId: named };
  if (!row) {
    return {
      linked: false,
      refusal: { code: 'SPEAKER_UNLINKED', message: unlinkedMessage(ref, projectId) },
    };
  }
  return { linked: true, userId: row.userId };
}

/**
 * A chat account a person just linked to their Forge user, on the link page; or one a project admin
 * named, which holds only in `projectId` (ISS-976).
 */
export interface SpeakerLinked {
  source: string;
  namespace: string;
  externalId: string;
  label: string | null;
  userId: string;
  /** The project whose admin named the account; absent for a link its owner confirmed. */
  projectId?: string;
}

let linkedListener: ((linked: SpeakerLinked) => Promise<void>) | null = null;

/**
 * Who is told a link was confirmed: the support rooms, whose session hands the person the link
 * page and is told when it is done, to say so in its own words (ISS-845).
 */
export function provideSpeakerLinkedListener(
  listener: (linked: SpeakerLinked) => Promise<void>,
): void {
  linkedListener = listener;
}

/** Tell the listener a link was confirmed; a failure to tell is logged, never the link's. */
export async function tellSpeakerLinked(linked: SpeakerLinked): Promise<void> {
  if (!linkedListener) return;
  await linkedListener(linked).catch((err: unknown) =>
    logger.error({ err, source: linked.source }, 'identity: a confirmed link was not told'),
  );
}
