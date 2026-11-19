// The room's secret screen (REQ-75 BC-40): what a member's message is kept as, and whether it held a
// secret. Three readings, each before anything is recorded:
// - a secret the shared scrubber knows by its label or prefix (`@forge/observability`), English or
//   Vietnamese (the word for password, then a colon);
// - account credentials as people write them in chat (ISS-1353): a password under a short label
//   (`mk:`, `pass:`, `pw:`, or the Vietnamese word for password then "is"), which a log or a verdict
//   never reads as one since there `pass: 1203` is a count, and an email or user name paired with a
//   password, unlabelled, where the message or its thread asks for a login;
// - a key sent alone where its thread says so (ISS-1326, `secret-flag.ts:bareKeyInContext`).
// What is filtered is the value alone: the email or the user name stays, so the thread still reads.

import { containsSecret, FILTERED, scrubLogText } from '@forge/observability';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import type { RocketChatIncomingMessage } from '../integrations/rocketchat/index.js';
import { threadOf } from './rules.js';
import { bareKeyInContext } from './secret-flag.js';
import type { RoomRow } from './store.js';

/** How far back a thread's words still say it asks for a login. */
const LOGIN_CONTEXT_MS = 6 * 60 * 60_000;

/** The labels a password is written under in chat, longest first so `password` is not read as `pass`. */
const LABEL = '(?:m[ậa]t\\s*kh[ẩa]u|m[ậa]t\\s*m[ãa]|password|passwd|passcode|pass|pwd|pw|mk)'; // i18n-allow: the Vietnamese labels a password is written under

/** A label, its separator (`:`, `=`, or the word "is" in English or Vietnamese), and the value after it. */
const LABELLED = new RegExp(`(\\b${LABEL}\\b\\s*(?:[:=]|\\s(?:là|la|is)\\s)\\s*)([^\\s,;]+)`, 'gi'); // i18n-allow: `là` is "is"

/** An email address. */
const EMAIL = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+';

/** A user name said with its label. */
const USER = '\\b(?:user(?:name)?|login|account|t[àa]i\\s*kho[ảa]n|tk)\\s*[:=]\\s*[^\\s,;/|]+'; // i18n-allow: "tài khoản" is "account"

/** An email or a labelled user name, a separator, and the run after it: a password where it is shaped as one. */
const PAIR = new RegExp(`(${EMAIL}|${USER})(\\s*(?:[/|,;:]|\\s-\\s)?\\s*)([^\\s,;/|]+)`, 'gi');

/** Words saying a login is what the thread is about, in the languages the rooms write in. */
const LOGIN_ASK = new RegExp(
  [
    '\\b(?:log\\s?in|sign\\s?in|credentials?|password|account)\\b',
    'đăng nhập|tài khoản|mật khẩu|dang nhap|tai khoan|mat khau', // i18n-allow: the Vietnamese words for login, account and password
  ].join('|'),
  'i',
);

/**
 * Whether a value is shaped as a password rather than a word: a digit, a mark that is no letter, or
 * a capital after a small letter, and at least `min` long. A count of one to three digits is a
 * count. An address is an address.
 */
function passwordShaped(value: string, min: number): boolean {
  const body = value.replace(/[.!?)\]]+$/, '');
  if (body.length < min || /^\d{1,3}$/.test(body)) return false;
  // the next label (`password:`), what was filtered already, an address and a link are no value
  if (/[:=]$/.test(body) || body.includes(FILTERED)) return false;
  if (/^https?:/i.test(body) || new RegExp(`^${EMAIL}$`).test(body)) return false;
  return /\d/.test(body) || /[^\p{L}]/u.test(body) || /[a-z][A-Z]/.test(body);
}

/**
 * `text` with every chat-written credential's value filtered: a password under a short label, and,
 * where `asksLogin`, the password an email or user name is paired with. Pure: the thread's words are
 * read by the caller.
 */
export function scrubChatCredentials(text: string, asksLogin: boolean): string {
  let out = text.replace(LABELLED, (whole, head: string, value: string) =>
    passwordShaped(value, 4) ? `${head}${FILTERED}` : whole,
  );
  if (asksLogin) {
    out = out.replace(PAIR, (whole, who: string, sep: string, value: string) =>
      passwordShaped(value, 6) ? `${who}${sep}${FILTERED}` : whole,
    );
  }
  return out;
}

/** Whether a message names an email or a labelled user name, the half of a pair a screen reads on. */
const holdsAccount = (text: string): boolean => new RegExp(`${EMAIL}|${USER}`, 'i').test(text);

/**
 * Whether the thread `m` is in asks for a login: its own words, or a member's or the session's words
 * in the thread within `LOGIN_CONTEXT_MS`.
 */
async function threadAsksLogin(
  room: Pick<RoomRow, 'id'>,
  m: Pick<RocketChatIncomingMessage, 'id' | 'tmid' | 'text'>,
): Promise<boolean> {
  if (LOGIN_ASK.test(m.text)) return true;
  if (!m.tmid) return false;
  const said = await db
    .select({ input: supportActions.input })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.thread, threadOf(m)),
        inArray(supportActions.kind, ['message_in', 'reply']),
        gte(supportActions.createdAt, new Date(Date.now() - LOGIN_CONTEXT_MS)),
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(10);
  return said.some((r) => {
    const t = (r.input as { text?: unknown } | null)?.text;
    return typeof t === 'string' && LOGIN_ASK.test(t);
  });
}

export interface Screened {
  /** What the room keeps of the message. */
  text: string;
  /** Whether it held a secret, which the session is told of once (`secret-flag.ts:flagSecret`). */
  secret: boolean;
}

/** A message read without its thread: the scrubber's labels, and a chat credential its own words show. */
export function screenAlone(text: string): Screened {
  const labelled = containsSecret(text) ? scrubLogText(text) : text;
  const out = scrubChatCredentials(labelled, LOGIN_ASK.test(text));
  return { text: out, secret: out !== text };
}

/** A member's message in a room, read with its thread (see the module's doc). */
export async function screenMessage(
  room: Pick<RoomRow, 'id'>,
  m: Pick<RocketChatIncomingMessage, 'id' | 'tmid' | 'text' | 'userId'>,
): Promise<Screened> {
  const labelled = containsSecret(m.text) ? scrubLogText(m.text) : m.text;
  const asksLogin = holdsAccount(labelled) && (await threadAsksLogin(room, m));
  const text = scrubChatCredentials(labelled, asksLogin);
  if (text !== m.text) return { text, secret: true };
  if (await bareKeyInContext(room, m)) return { text: FILTERED, secret: true };
  return { text: m.text, secret: false };
}
