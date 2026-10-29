// The pure rules of a support group (REQ-75): what a confirm message is, the code a fix waits
// under, the limits a room runs under, the visitor id a Rocket.Chat account files under, and what
// the session is told when a recorded item's result is final.

import { createHash, randomInt } from 'node:crypto';
import type { FeedbackPhase } from '@forge/contracts/feedback';
import {
  SUPPORT_CONFIRM_MESSAGE_PATTERN,
  SUPPORT_LIMIT_DEFAULTS,
  type SupportRecordKind,
  type SupportRoomConfig,
} from '@forge/contracts/support';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A fresh code a fix waits under: six letters and digits nobody misreads. */
export function mintConfirmCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** A message that confirms or cancels a fix — the word, the code, nothing else — or null. */
export function parseConfirm(text: string): { verb: 'confirm' | 'cancel'; code: string } | null {
  const m = SUPPORT_CONFIRM_MESSAGE_PATTERN.exec(text);
  if (!m) return null;
  return {
    verb: (m[1] as string).toLowerCase() as 'confirm' | 'cancel',
    code: (m[2] as string).toUpperCase(),
  };
}

/**
 * Who may confirm a fix: exactly the account that asked, read from the server's own attribution of
 * the message, never from what the message says.
 */
export function confirmRefusal(
  fix: { askerKey: string; askerLabel: string | null },
  authorKey: string,
  nothingDone = 'Nothing was run.',
): string | null {
  if (fix.askerKey === authorKey) return null;
  return `Only @${fix.askerLabel ?? 'the person who asked'} can confirm this change. ${nothingDone}`;
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

/** The line a check the session ran posts in the thread, so the group sees what was looked at. */
export function checkLine(summary: string, status: number, durationMs: number): string {
  const outcome = status === 0 ? 'could not be reached' : `answered ${status}`;
  return `Checked: ${summary} — ${outcome} (${durationMs} ms).`;
}

/** The line a fix posts after it ran, or failed. */
export function fixResultLine(summary: string, status: number, ok: boolean): string {
  if (ok) return `Done: ${summary} (answered ${status}).`;
  return status === 0
    ? `The change did not go through: ${summary} could not be reached. Nothing else was tried.`
    : `The change did not go through: ${summary} answered ${status}. Nothing else was tried.`;
}

/** The prompt a proposed fix posts, addressed to the one person who may confirm it. */
export function confirmPrompt(input: {
  askerLabel: string | null;
  summary: string;
  args: Record<string, unknown>;
  code: string;
  /** Who confirms where it is not the asker: a channel agent's change waits on a role (REQ-77 BC-10). */
  confirmers?: string;
}): string {
  const shown = Object.entries(input.args)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');
  const who = input.askerLabel ? `@${input.askerLabel} ` : '';
  const only = input.confirmers ? `${input.confirmers} can confirm it` : 'Only you can confirm it';
  return `${who}I can make this change: ${input.summary}${shown ? ` (${shown})` : ''}. Reply \`confirm ${input.code}\` to run it, or \`cancel ${input.code}\`. ${only}; it expires in 15 minutes.`;
}

/** What the thread is told before anything is filed: the route, the title, and the thread's link. */
export function recordPrompt(input: {
  askerLabel: string | null;
  kind: SupportRecordKind;
  title: string;
  link: string;
  code: string;
}): string {
  const who = input.askerLabel ? `@${input.askerLabel} ` : '';
  return `${who}I would record this for the team as Feedback (${input.kind}): "${input.title}", with a link to this thread (${input.link}). Reply \`confirm ${input.code}\` to record it, or \`cancel ${input.code}\`. Only you can confirm it; it expires in 15 minutes.`;
}

/** The nearest-rank `p`th percentile of `values`, or null for none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}
