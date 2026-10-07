// A handle's presence — how eager it is to speak in a room it was not summoned
// into — as configuration with today's constants for defaults (ISS-1034).
//
// This is the ONE reader of `PresenceConfig`: what an unset key means, and how
// a room with several handles folds their values into the one set of thresholds
// `decideProactivity` reads. The bounds a written value must sit in are its
// owner's, `orgs/agent-presence.ts`.

import { z } from 'zod';
import {
  type AnswerInGroupMode,
  answerInGroupModes,
  type PresenceConfig,
} from '../db/schema-agent-selves.js';
import type { RoomPresence, RoomQuiet } from '../db/schema-conversations.js';
import { boundedPresence, presenceInvalid } from '../orgs/index.js';

/**
 * Today's constants, and what an unset key folds as. `proactivity.ts` reads
 * these back so the two cannot drift; `presence.test.ts` asserts they equal
 * the values the guards were tuned at.
 */
const PRESENCE_DEFAULTS = {
  dormantMs: 24 * 60 * 60 * 1000,
  backoffAfter: 3,
  loopBounceMs: 5 * 60 * 1000,
  loopLimit: 3,
  answerInGroup: 'window' as AnswerInGroupMode,
  heartbeatEnabled: false,
  heartbeatIntervalMs: 60 * 60 * 1000,
} as const;

/** What `decideProactivity` reads: every key resolved, none optional. */
interface ResolvedPresence {
  dormantMs: number;
  backoffAfter: number;
  loopBounceMs: number;
  loopLimit: number;
  answerInGroup: AnswerInGroupMode;
}

/**
 * One set of thresholds for a room with several handles: each key folds by
 * its own operator, and a key nobody set folds as its default.
 */
export function foldPresence(selves: readonly PresenceConfig[]): ResolvedPresence {
  const pick = <K extends keyof ResolvedPresence>(
    key: K,
    op: (values: number[]) => number,
  ): number => {
    const fallback = PRESENCE_DEFAULTS[key] as number;
    const values = selves.map((s) => (s[key] as number | undefined) ?? fallback);
    return values.length ? op(values) : fallback;
  };
  const modes = selves.map((s) => s.answerInGroup);
  return {
    dormantMs: pick('dormantMs', (v) => Math.min(...v)),
    backoffAfter: pick('backoffAfter', (v) => Math.min(...v)),
    loopBounceMs: pick('loopBounceMs', (v) => Math.max(...v)),
    loopLimit: pick('loopLimit', (v) => Math.min(...v)),
    answerInGroup: foldAnswerInGroup(modes),
  };
}

/**
 * The one mode a room of several handles answers in.
 */
function foldAnswerInGroup(modes: readonly (AnswerInGroupMode | undefined)[]): AnswerInGroupMode {
  if (modes.includes('mention')) return 'mention';
  if (modes.includes('tool')) return 'tool';
  return PRESENCE_DEFAULTS.answerInGroup;
}

/** The keys a ROOM may set for itself. */
const ROOM_PRESENCE_KEYS = [
  'dormantMs',
  'backoffAfter',
  'loopBounceMs',
  'loopLimit',
  'answerInGroup',
  'quiet',
] as const;

const roomPresenceSchema = z
  .object({
    dormantMs: boundedPresence('dormantMs').optional(),
    backoffAfter: boundedPresence('backoffAfter').optional(),
    loopBounceMs: boundedPresence('loopBounceMs').optional(),
    loopLimit: boundedPresence('loopLimit').optional(),
    answerInGroup: z.enum(answerInGroupModes).optional(),
    quiet: z
      .object({ since: z.iso.datetime({ offset: true }), by: z.string().min(1).nullable() })
      .strict()
      .optional(),
  })
  .strict();

export function validateRoomPresence(input: unknown): RoomPresence {
  const parsed = roomPresenceSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => {
    const path = i.path.length ? `presence.${i.path.join('.')}` : 'presence';
    if (i.code === 'unrecognized_keys') {
      const own = i.keys.filter((k) => k === 'heartbeat');
      const lead = own.length
        ? `${path}: \`heartbeat\` is a handle's own and is not set on a room; `
        : `${path}: unknown key(s) ${i.keys.map((k) => `\`${k}\``).join(', ')}; `;
      return `${lead}a room takes only: ${ROOM_PRESENCE_KEYS.join(', ')}`;
    }
    return `${path}: ${i.message}`;
  });
  throw presenceInvalid(issues);
}

/**
 * The room's thresholds: what the room set wins, key by key, over the fold.
 */
export function applyRoomPresence(
  fold: ResolvedPresence,
  room: RoomPresence | null | undefined,
): ResolvedPresence {
  if (!room) return fold;
  return {
    dormantMs: room.dormantMs ?? fold.dormantMs,
    backoffAfter: room.backoffAfter ?? fold.backoffAfter,
    loopBounceMs: room.loopBounceMs ?? fold.loopBounceMs,
    loopLimit: room.loopLimit ?? fold.loopLimit,
    answerInGroup: room.answerInGroup ?? fold.answerInGroup,
  };
}

/** A handle's heartbeat, resolved — read per handle, never folded across a room. */
export function heartbeatOf(self: PresenceConfig): { enabled: boolean; intervalMs: number } {
  return {
    enabled: self.heartbeat?.enabled ?? PRESENCE_DEFAULTS.heartbeatEnabled,
    intervalMs: self.heartbeat?.intervalMs ?? PRESENCE_DEFAULTS.heartbeatIntervalMs,
  };
}

/**
 * Whether a message names a handle: `@handle` or the bare handle as a word.
 */
export function namesHandle(content: string, handle: string | null): boolean {
  if (!handle) return false;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])@?${escaped}(?![\\w-])`, 'i').test(content);
}

/** Whether any message in the window names any of the room's handles. */
function windowNamesAHandle(
  messages: readonly { content: string }[],
  handles: readonly (string | null)[],
): boolean {
  return messages.some((m) => handles.some((h) => namesHandle(m.content, h)));
}

/**
 * Whether the window addresses a handle: names one, or replies to something
 * a handle sent.
 */
export function windowAddressesAHandle(
  messages: readonly { content: string; replyToExternalId: string | null }[],
  handles: readonly (string | null)[],
  sentByHandle: ReadonlySet<string>,
): boolean {
  if (windowNamesAHandle(messages, handles)) return true;
  return messages.some(
    (m) => m.replyToExternalId !== null && sentByHandle.has(m.replyToExternalId),
  );
}

/** The reply targets a window carries, deduplicated, for the store to resolve. */
export function replyTargetsOf(
  messages: readonly { replyToExternalId: string | null }[],
): string[] {
  return [...new Set(messages.flatMap((m) => (m.replyToExternalId ? [m.replyToExternalId] : [])))];
}

/** A tag that names somebody: `@name`, never the `@` inside an email address. */
const TAG_RE = /(?:^|[^\w.@-])@(\w[\w.-]*)/g;

/** Tags that address the whole room, the handle included. */
const ROOM_WIDE_TAGS: ReadonlySet<string> = new Set(['all', 'here', 'channel', 'everyone']);

/**
 * Whether a message tags people and none of them is a handle: it is addressed to them, not to the
 * room's agent. A message that names a handle as a bare word as well is the handle's.
 */
export function tagsOnlyAPerson(content: string, handles: readonly (string | null)[]): boolean {
  const tags = [...content.matchAll(TAG_RE)].map((m) =>
    (m[1] ?? '').replace(/[.-]+$/, '').toLowerCase(),
  );
  if (tags.length === 0) return false;
  if (tags.some((t) => ROOM_WIDE_TAGS.has(t))) return false;
  return !handles.some((h) => namesHandle(content, h));
}

const STOP_RE =
  // i18n-allow: the literal must contain the Vietnamese ways a room tells the agent to stop
  /^(?:(?:làm ơn|xin|thôi|please)\s+)?(?:cút(?:\s+đi)?|im(?:\s+(?:lặng|mồm|miệng))?(?:\s+đi)?|(?:đừng|ngừng|dừng|thôi)\s+(?:trả\s+lời|phản\s+hồi|nói|chen\s+vào|rep)|dừng\s+lại|stop(?:\s+(?:replying|talking|answering|responding))?|shut\s+up|be\s+quiet|go\s+away|(?:do\s+not|don'?t)\s+(?:reply|answer|respond))(?:\s+(?:nữa|đi|nha|nhé|nhe|giùm|dùm|ngay|please|now|here|anymore))*$/iu; // i18n-allow: the Vietnamese stop phrasing

// i18n-allow: the Vietnamese vocatives a stop request may open or close on
const VOCATIVE_RE = /^(?:(?:ơi|à|này|nè)\s+)+|(?:\s+(?:ơi|à|này|nè))+$/giu; // i18n-allow: the Vietnamese vocatives

/**
 * Whether a message, taken whole, tells the agent to stop: `stop replying`, `go away`, and the
 * Vietnamese phrasings `STOP_RE` carries. The handle's own name and the punctuation around the
 * words are not part of the request; anything else said with it makes it a different message.
 */
export function asksToStop(content: string, handles: readonly (string | null)[]): boolean {
  let rest = content;
  for (const h of handles) {
    if (!h) continue;
    const escaped = h.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    rest = rest.replace(new RegExp(`(^|[^\\w-])@?${escaped}(?![\\w-])`, 'giu'), '$1 ');
  }
  rest = rest
    .replace(/[\p{P}\p{S}\p{Extended_Pictographic}]+/gu, ' ')
    .replace(/(?:^|\s):[a-z]\b/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(VOCATIVE_RE, '')
    .trim();
  return rest.length > 0 && STOP_RE.test(rest);
}

interface HeardMessage {
  role: string;
  content: string;
  replyToExternalId: string | null;
  authorLabel: string | null;
}

/** What a group room's window is, read before any turn is spent on it. */
export type GroupHearing<M extends HeardMessage> =
  | { kind: 'asked-to-stop'; by: string | null }
  | { kind: 'quiet-until-mentioned'; quiet: RoomQuiet }
  | { kind: 'addressed-to-person' }
  | { kind: 'heard'; messages: M[]; liftsQuiet: boolean };

/**
 * A group room's window, read for whom it speaks to: messages that tag only a person are theirs and
 * are left out; a stop request no later message overrides quiets the room; a quiet room stays quiet
 * until a message names a handle or replies to one.
 */
export function groupHearing<M extends HeardMessage>(
  messages: readonly M[],
  handles: readonly (string | null)[],
  sentByHandle: ReadonlySet<string>,
  quiet: RoomQuiet | null | undefined,
): GroupHearing<M> {
  const repliesToHandle = (m: M) =>
    m.replyToExternalId !== null && sentByHandle.has(m.replyToExternalId);
  const addresses = (m: M) => windowAddressesAHandle([m], handles, sentByHandle);
  const heard = messages.filter(
    (m) => m.role !== 'user' || repliesToHandle(m) || !tagsOnlyAPerson(m.content, handles),
  );
  const people = heard.filter((m) => m.role === 'user');
  if (people.length === 0 && messages.some((m) => m.role === 'user')) {
    return { kind: 'addressed-to-person' };
  }
  let stopAt = -1;
  people.forEach((m, i) => {
    if (asksToStop(m.content, handles)) stopAt = i;
  });
  const before = people.slice(0, stopAt + 1);
  const after = people.slice(stopAt + 1);
  const summoned = after.some(addresses);
  if (stopAt >= 0 && !summoned) {
    return { kind: 'asked-to-stop', by: people[stopAt]?.authorLabel ?? null };
  }
  if (quiet && !summoned) return { kind: 'quiet-until-mentioned', quiet };
  return {
    kind: 'heard',
    messages: heard.filter((m) => !before.includes(m)),
    liftsQuiet: Boolean(quiet) || stopAt >= 0,
  };
}
