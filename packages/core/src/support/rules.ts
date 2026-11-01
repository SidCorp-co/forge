// The pure rules of a support group (REQ-75): the handle a proposal waits under, the limits a room
// runs under, the visitor id a Rocket.Chat account files under, and what
// the session is told when a recorded item's result is final.

import { createHash, randomInt } from 'node:crypto';
import type { FeedbackPhase } from '@forge/contracts/feedback';
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
    fixesPerUserPerDay: set.fixesPerUserPerDay ?? SUPPORT_LIMIT_DEFAULTS.fixesPerUserPerDay,
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

/**
 * What the session is told when a recorded item reaches a final phase, to post its result in the
 * item's thread (REQ-75 r6 BC-15); null for a phase that is progress, which is never posted.
 */
export function resultNote(phase: FeedbackPhase, key: string): string | null {
  const post =
    "Post its result in this thread, once, in the asker's words: what changed for them, or that it will not be done. No keys, no process.";
  switch (phase) {
    case 'resolved':
      return `${key}, recorded from this thread, is live now. ${post}`;
    case 'verified':
      return `${key}, recorded from this thread, is live and confirmed fixed. ${post}`;
    case 'declined':
      return `${key}, recorded from this thread, will not be done: the team declined it. ${post}`;
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

