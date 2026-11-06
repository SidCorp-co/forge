// The pure rules of a support group (REQ-75): the handle a proposal waits under, the limits a room
// runs under, the visitor id a Rocket.Chat account files under, and what
// the session is told when a recorded item's result is final.

import { createHash, randomInt } from 'node:crypto';
import type { FeedbackPhase, FeedbackRoute } from '@forge/contracts/feedback';
import {
  SUPPORT_LIMIT_DEFAULTS,
  type SupportRecordKind,
  type SupportRoomConfig,
} from '@forge/contracts/support';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A fresh handle a proposal waits under: six letters and digits nobody misreads. */
export function mintConfirmCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export type SupportLimitsResolved = { [K in keyof typeof SUPPORT_LIMIT_DEFAULTS]: number };

export function limitsOf(config: SupportRoomConfig | null | undefined): SupportLimitsResolved {
  const set = config?.limits ?? {};
  return {
    messagesPerUserPerHour:
      set.messagesPerUserPerHour ?? SUPPORT_LIMIT_DEFAULTS.messagesPerUserPerHour,
    messageMaxChars: set.messageMaxChars ?? SUPPORT_LIMIT_DEFAULTS.messageMaxChars,
    responseMaxBytes: set.responseMaxBytes ?? SUPPORT_LIMIT_DEFAULTS.responseMaxBytes,
  };
}

/** A message longer than the room's limit is cut, and says so. */
export function clipMessage(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} … [cut at ${max} characters]` : text;
}

/** The thread a message belongs to: the one it was posted in, or the thread its own reply opens. */
export const threadOf = (m: { id: string; tmid?: string | undefined }): string => m.tmid ?? m.id;

/** The conversation venue of one thread of a support group. */
export const supportVenueId = (namespace: string, rid: string, thread: string): string =>
  `${namespace} ${rid} ${thread}`;

/** The visitor id a Rocket.Chat account files Feedback under: stable per server and account. */
export function visitorIdOf(namespace: string, accountId: string): string {
  const h = createHash('sha256').update(`rocketchat:${namespace}:${accountId}`).digest('hex');
  // a version-8 (custom) uuid: the hash's bits with the version and variant set
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `8${h.slice(13, 16)}`,
    `${((Number.parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

/** The Feedback kind a group member's need is recorded as. */
export const FEEDBACK_KIND_OF: Record<SupportRecordKind, 'bug' | 'idea' | 'change_request'> = {
  defect: 'bug',
  feature: 'idea',
  request: 'change_request',
};

/** A recorded item's result as the session is told it: its route, and what it told its reporter. */
export interface ItemResult {
  phase: FeedbackPhase;
  key: string;
  /** The route that settled it; a duplicate's is its original's. */
  route: FeedbackRoute | null;
  /** The answer its reporter reads, on the answer route. */
  answer: string | null;
  /** The reason of the decline it stands under. */
  declined: string | null;
  /** What carried it live, as its issues or its requirement are titled. */
  shipped: readonly string[];
  /** The project's data policy keeps the item's words from the session. */
  withheld: boolean;
}

/**
 * What the session is told when a recorded item reaches a final phase, to post its result in the
 * item's thread (REQ-75 r6 BC-15), by the route that settled it (ISS-1032): an item answered changed
 * nothing and shipped nothing, so it is never told as live. What the team did or said (the answer,
 * what shipped, the decline's reason) is handed to the session as material to restate, so the room
 * hears what the master did or decided. Null for a phase that is progress, never posted.
 */
export function resultNote(r: ItemResult): string | null {
  const post =
    "Post its result in this thread, once, in the asker's words: what changed for them, or that it will not be done. No keys, no process.";
  const recorded = `${r.key}, recorded from this thread,`;
  // the team's words are for the session to restate, never to paste
  const quoted = (lead: string, text: string | null) =>
    text?.trim() ? ` ${lead} (restate it, never paste it): "${text.trim()}"` : '';
  const hidden = r.withheld
    ? " Its words are withheld from this session by the project's data policy."
    : '';
  const shipped = quoted('What the team shipped for it', r.shipped.join('; '));
  switch (r.phase) {
    case 'resolved':
      if (r.route === 'answer') {
        const answer = quoted("The team's answer", r.answer) || hidden;
        return `${recorded} was answered by the team: nothing was changed or shipped for it unless the answer says so.${answer} ${post}`;
      }
      return `${recorded} is live now.${shipped} ${post}`;
    case 'verified':
      return `${recorded} is live and confirmed fixed.${shipped} ${post}`;
    case 'declined': {
      const reason = quoted('The reason they gave', r.declined) || hidden;
      return `${recorded} will not be done: the team declined it.${reason} ${post}`;
    }
    default:
      return null;
  }
}

/** The nearest-rank `p`th percentile of `values`, or null for none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

/** The thread a scheduled check's firing is recorded under: one per check and UTC day (REQ-77 BC-13). */
const CHECK_THREAD_PREFIX = 'check:';
export const checkThreadOf = (name: string, day: string) => `${CHECK_THREAD_PREFIX}${name}:${day}`;
export const isCheckThread = (thread: string) => thread.startsWith(CHECK_THREAD_PREFIX);

/** The thread a room's release notes are handed under (ISS-854): no member's. */
export const RELEASE_THREAD_PREFIX = 'release:';

/** The thread a parked Forge question is handed to a channel agent under (ISS-873): no member's. */
const QUESTION_THREAD_PREFIX = 'question-';
export const questionThreadOf = (questionId: string, round: number) =>
  `${QUESTION_THREAD_PREFIX}${questionId}-${round}`;
export const isQuestionThread = (thread: string) => thread.startsWith(QUESTION_THREAD_PREFIX);

/** A thread core opened for its own note, no member's: a failure there is recorded, never posted. */
export const isCoreThread = (thread: string) =>
  isCheckThread(thread) || thread.startsWith(RELEASE_THREAD_PREFIX) || isQuestionThread(thread);
