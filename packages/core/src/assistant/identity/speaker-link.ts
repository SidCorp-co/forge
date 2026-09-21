import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { type ConversationAdapter, conversationAdapters } from '../../db/schema-conversations.js';
import { assistantSpeakerLinks } from '../../db/schema-speaker-links.js';
import { speakerLinkUrl } from './link-url.js';

export type SpeakerRefusalCode =
  | 'SPEAKER_UNLINKED'
  | 'SPEAKER_SOURCE_UNKNOWN'
  | 'SPEAKER_DIRECTORY_UNSUPPORTED'
  | 'SPEAKER_DIRECTORY_UNREACHABLE'
  | 'SPEAKER_NOT_ON_CHANNEL'
  | 'SPEAKER_EMAIL_ABSENT'
  | 'SPEAKER_NOT_THE_TARGET'
  | 'SPEAKER_ADDRESS_DIFFERS'
  | 'SPEAKER_ALREADY_LINKED';

export interface SpeakerRefusal {
  code: SpeakerRefusalCode;
  message: string;
}

export interface SpeakerRef {
  source: string;
  /** The channel INSTANCE the id belongs to — for Rocket.Chat, the server's host. */
  namespace: string;
  externalId: string;
  /** Display name, for the refusal text alone. */
  label?: string | null | undefined;
}

export type SpeakerResolution =
  | { linked: true; userId: string }
  | { linked: false; refusal: SpeakerRefusal };

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
export function unlinkedMessage(ref: SpeakerRef, projectId?: string): string {
  const url = projectId
    ? speakerLinkUrl({ projectId, source: ref.source, externalId: ref.externalId })
    : null;
  return [
    `${speakerPhrase(ref)} is not linked to a Forge account, so I cannot record an answer as you.`,
    'Sign in to Forge with the same email this chat account uses and confirm the link — mismatched addresses is the usual cause.',
    url
      ? `Confirm it here: ${url}`
      : 'No screen for it yet: POST /api/projects/<id>/speaker-links.',
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
 * The ONE resolution. A speaker is the Forge user a confirmed row names, or a
 * named refusal — never a guess, never a fallback, never a service identity.
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
  if (!row) {
    return {
      linked: false,
      refusal: { code: 'SPEAKER_UNLINKED', message: unlinkedMessage(ref, projectId) },
    };
  }
  return { linked: true, userId: row.userId };
}
