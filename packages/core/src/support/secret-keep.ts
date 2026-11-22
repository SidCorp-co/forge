// A credential a member hands over in a bound room, kept before the message is recorded (ISS-1372,
// owner 2026-11-20). The screen (`secret-screen.ts`) caught each value; here each goes into the bound
// project's vault (`project-config/kept-secrets.ts`) under a proposed name and kind read from the
// words around it, with who sent it, where and when, and whether the sender holds project admin there
// (usable at once) or not (pending a project admin's approval for a day). The message is then kept
// with `[Secret kept: <name>]` where each value stood, so no record, transcript or prompt holds it.

import { createHash } from 'node:crypto';
import { SUPPORT_KEPT_SECRET_SCOPE } from '@forge/contracts/support';
import { FILTERED } from '@forge/observability';
import type { RocketChatIncomingMessage } from '../integrations/rocketchat/index.js';
import { logger } from '../lib/logger.js';
import { actorFor, can, projectResource } from '../permissions/index.js';
import { type KeptEntry, keepChatSecret, SECRET_VALUE_MAX } from '../project-config/index.js';
import { threadOf } from './rules.js';
import type { Screened } from './secret-screen.js';
import type { RoomRow } from './store.js';
import { senderAccount } from './temporary-account.js';

/** The kinds a credential is named by, with the words a room says each with. */
const KINDS: [kind: string, words: RegExp][] = [
  ['password', /^(?:password|passwd|passcode|pass|pwd|pw|mk|mat|khau|ma)$/],
  ['session token', /^(?:session|cookie|sid)$/],
  ['token', /^(?:token|bearer|jwt)$/],
  ['key', /^(?:key|apikey|khoa)$/],
  ['secret', /^(?:secret)$/],
];

/** A word without its marks, for matching and for a name: the Vietnamese for password reads `mat khau`. */
const plain = (w: string) =>
  w
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0111\u0110]/g, (c) => (c === '\u0111' ? 'd' : 'D'));

/** The words standing before the `index`-th value on its line, at most four, the label's marks dropped. */
function wordsBefore(text: string, index: number): string[] {
  const parts = text.split(FILTERED);
  const before = (
    parts
      .slice(0, index + 1)
      .join(FILTERED)
      .split('\n')
      .pop() ?? ''
  ).replace(/\[Filtered\]/g, ' ');
  // an email or an address beside a password is whose it is, not what it is
  const named = before.replace(/\S+@\S+|https?:\/\/\S+/g, ' ');
  const words = named.match(/[\p{L}\p{N}]+/gu) ?? [];
  // the words joining a label to its value ("is", the Vietnamese "is" and "of") name nothing
  return words.slice(-4).filter((w) => !FILLER.has(plain(w).toLowerCase()));
}

const FILLER = new Set(['is', 'la', 'the', 'my', 'of', 'cua', 'here', 'day']);

/** A proposed name and kind for one value, from the words around it. */
export function proposalOf(
  text: string,
  index: number,
): { label: string; kind: string; slug: string } {
  const words = wordsBefore(text, index);
  const lowered = words.map((w) => plain(w).toLowerCase());
  const kind =
    KINDS.find(([, re]) => lowered.some((w) => re.test(w)))?.[0] ??
    KINDS.find(([, re]) =>
      (
        plain(text)
          .toLowerCase()
          .match(/[a-z0-9]+/g) ?? []
      ).some((w) => re.test(w)),
    )?.[0] ??
    'credential';
  // the words that name the thing, the label's own short forms dropped
  const naming = words.filter((w) => !/^(?:mk|pw|pwd|pass)$/i.test(w));
  const label = naming.length > 0 ? naming.join(' ') : kind;
  const named = KINDS.some(([k, re]) => k === kind && lowered.some((w) => re.test(w)));
  const full = named ? label : `${label === kind ? '' : `${label} `}${kind}`.trim();
  const slug = plain(full)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return {
    label: full,
    kind,
    slug: /^[a-z]/.test(slug) ? slug : `kept-${slug}`.replace(/-+$/, ''),
  };
}

/** The entry's name: its proposal and a short mark of its message, so a redelivery names the same. */
const nameOf = (slug: string, messageId: string, index: number) =>
  `${slug}-${createHash('sha256').update(`${messageId}:${index}`).digest('hex').slice(0, 6)}`;

/** Why a value the screen caught was not kept, which the note words (`secret-flag.ts:secretNote`). */
export type NotKeptWhy = 'no_vault' | 'too_long' | 'unreadable' | 'failed';

/** A value not kept, named by its place in the message and the words before it, never by itself. */
export interface NotKept {
  index: number;
  label: string;
  why: NotKeptWhy;
}

export interface KeptHere {
  text: string;
  kept: KeptEntry[];
  /** Each value the screen caught that no vault holds, and why. */
  missed: NotKept[];
}

const notKept = (text: string, index: number, why: NotKeptWhy): NotKept => ({
  index,
  label: proposalOf(text, index).label,
  why,
});

/** Every value the screen caught, kept nowhere for `why`: the text stays `[Filtered]` where each stood. */
export function noneKept(screened: Pick<Screened, 'text'>, why: NotKeptWhy): KeptHere {
  const marks = screened.text.split(FILTERED).length - 1;
  return {
    text: screened.text,
    kept: [],
    missed: Array.from({ length: marks }, (_, i) => notKept(screened.text, i, why)),
  };
}

/**
 * Each value the screen caught in `m`, kept in the room's project's vault, and the message's text with
 * `[Secret kept: <name>]` where each kept value stood. A value this core cannot keep stays
 * `[Filtered]` and is named in `missed` with why: no vault key, past the length a secret holds, not
 * read back from the message, or a keep that failed.
 */
export async function keepScreened(
  room: RoomRow,
  m: Pick<RocketChatIncomingMessage, 'id' | 'tmid' | 'userId' | 'username'>,
  screened: Screened,
  namespace: string,
): Promise<KeptHere> {
  const parts = screened.text.split(FILTERED);
  if (!screened.secret || parts.length < 2) return { text: screened.text, kept: [], missed: [] };
  // the screen read no run back for its marks (`filteredValues`): nothing is kept that is not the value
  if (screened.values.length !== parts.length - 1) return noneKept(screened, 'unreadable');
  const sender = await senderAccount(
    { source: 'rocketchat', namespace, externalId: m.userId, label: m.username ?? null },
    room.kind === 'operations' ? undefined : room.projectId,
  );
  const userId = sender.kind === 'forge' ? sender.userId : null;
  const admin = userId
    ? await can(actorFor(userId, 'human'), 'project.admin', projectResource(room.projectId))
    : false;
  const label = m.username ?? null;
  const at = new Date().toISOString();
  const marks = screened.values.map(() => FILTERED);
  const kept: KeptEntry[] = [];
  const missed: NotKept[] = [];
  for (const [index, value] of screened.values.entries()) {
    const unfit: NotKeptWhy | null =
      value.length === 0 ? 'unreadable' : value.length > SECRET_VALUE_MAX ? 'too_long' : null;
    if (unfit) {
      missed.push(notKept(screened.text, index, unfit));
      continue;
    }
    const proposal = proposalOf(screened.text, index);
    let entry: KeptEntry | null;
    try {
      entry = await keepChatSecret({
        projectId: room.projectId,
        value,
        record: {
          name: nameOf(proposal.slug, m.id, index),
          label: proposal.label,
          kind: proposal.kind,
          from: { chatKey: m.userId, label, userId, admin },
          room: room.id,
          thread: threadOf(m),
          message: m.id,
          at,
          actsAs: label ? `@${label}` : `account ${m.userId}`,
        },
      });
    } catch (err) {
      // logged by the failure's kind alone, so no line can carry what it held
      logger.error(
        {
          roomId: room.id,
          msgId: m.id,
          index,
          failure: err instanceof Error ? err.name : typeof err,
        },
        'support: a credential handed over in a room was not kept; it stays filtered',
      );
      missed.push(notKept(screened.text, index, 'failed'));
      continue;
    }
    if (!entry) {
      missed.push(notKept(screened.text, index, 'no_vault'));
      continue;
    }
    kept.push(entry);
    // the value's place in the text names what it became
    marks[index] = `[Secret kept: ${entry.name}]`;
  }
  const text = parts.map((p, i) => (i === 0 ? p : `${marks[i - 1] ?? FILTERED}${p}`)).join('');
  return { text, kept, missed };
}

/** The ref a kept entry is read at, as the note says it. */
export const keptRefOf = (name: string) => `secret://${SUPPORT_KEPT_SECRET_SCOPE}/${name}`;
