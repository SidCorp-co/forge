/**
 * ISS-977 — who is the person who just spoke on a chat channel.
 *
 * The bridge between a Claude Code run and a human reaches that human on the
 * web UI or in a chat room, and every write on the far side is gated against a
 * real Forge `userId`: `questions/read.ts:answerAs` refuses an option whose
 * authority the caller's project role does not carry, and comment authorship
 * decides whose receipt clears the unseen-drafts bucket. On the web that
 * identity is the session. On a channel there is none — a speaker arrives as a
 * display name — so this module is the only place a channel speaker becomes a
 * Forge user, and it either names one or refuses.
 */

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
// cm:guard this string is read by A PERSON IN A CHAT ROOM and by nobody else — `question-inbound.ts`
// and `comment-inbound.ts` are its only callers, and both hand it straight to `say(transport, …)`.
// Three sentences, and the length is the point: it opened with two REST paths and a JSON body, and
// the rewrite that fixed that first replaced them with six sentences of prose, which is the same
// defect wearing better clothes. Cause, the one condition that decides it, the one place to go.
// The condition is the ADDRESSES MATCHING: measured 2026-09-18, the person who hit this was refused
// because the channel reports one address for them and they sign in to Forge as another, and the
// refusal they got never used the word "email".
// cm:guard the last sentence degrades rather than lies. With a project it is a link to the confirm
// page; without one, or on a deployment that does not know its own web address, it names the
// endpoint instead. A refusal that prints a broken URL is worse than one that prints none.
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
// cm:guard the only writer of an identity on the chat side. A second path to a `userId` — a bot account standing in for a person, a "best effort" match at call time, a default project owner — makes `questions/write.ts:answeredBy` lie, which is what `comments.is_ai` did before it was dropped on 2026-09-04 disagreeing with the token on 3,172 of 23,414 rows.
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
