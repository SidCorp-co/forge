// What a raise reads before it speaks in the technical channel (ISS-1299, owner 2026-11-18: the way
// the bot answered his messages is wrong). In the forge-dev thread the owner gave the room full
// rights to link ePOD at 02:46, the room's agent promised it at 02:46:57, and a minute later a raise
// posted a master's English answer under "Forge asks:", re-asking him in the third person what he had
// just settled. Two voices, neither reading the other, and a language taken from the words posted.
//
// So a raise reads the thread it posts into first: who wrote there last and what, and the bot's
// answer since, which stands as the thread's promise. Where a person spoke within the turn and no raise
// has answered that message yet, the raise is held, naming his message and the answer standing, until
// it names that message as the one it answers. Its language is the reader's: the owner's own recorded
// messages, else the thread's recent ones, never the words being posted.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { confidentLanguageOf } from '../conversations/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { no, type Outcome } from './outcome.js';
import { roomLanguage } from './report-thread.js';
import type { RoomRow } from './store.js';

/** How long a person's message in the technical thread holds a raise that does not answer it. */
export const RAISE_TURN_MS = 30 * 60_000;
/** How many recorded messages are read for a language. */
const LANGUAGE_READ = 20;
/** How much of a message a held raise quotes back. */
const QUOTE_MAX = 240;

export type TechnicalLanguage = 'vi' | 'en';

const LANGUAGE_NAME: Readonly<Record<TechnicalLanguage, string>> = {
  vi: 'Vietnamese',
  en: 'English',
};

/** A person's latest message in the thread, within the turn and answered by no raise yet. */
export interface Spoke {
  message: string;
  writer: string | null;
  text: string;
  at: Date;
}

/** The thread a raise posts into, as it stands before the raise speaks. */
export interface TechnicalTurn {
  language: TechnicalLanguage;
  /** Who the line speaks to: the person who spoke in the turn, else the owner, by chat name. */
  addressee: string | null;
  spoke: Spoke | null;
  /** The bot's answer in the thread after he spoke: the promise a raise must agree with. */
  standing: string | null;
}

const quoted = (text: string): string => {
  const words = text.replace(/\s+/g, ' ').trim();
  return words.length > QUOTE_MAX ? `${words.slice(0, QUOTE_MAX - 1)}…` : words;
};

const textOf = (input: unknown): string => {
  const text = (input as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text : '';
};

/** The first language its texts can be told in with confidence, newest first. */
function languageOfTexts(texts: readonly string[]): TechnicalLanguage | null {
  for (const text of texts) {
    const told = confidentLanguageOf(text);
    if (told) return told;
  }
  return null;
}

/** The language the owner writes in, read from his own messages Forge recorded, newest first. */
async function ownerLanguage(ownerKey: string | null): Promise<TechnicalLanguage | null> {
  if (!ownerKey) return null;
  const said = await db
    .select({ input: supportActions.input })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
        eq(supportActions.actorKey, ownerKey),
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(LANGUAGE_READ);
  return languageOfTexts(said.map((r) => textOf(r.input)));
}

/** The thread's recent rows, newest first: its people's messages and the bot's answers. */
async function threadRows(roomId: string, thread: string) {
  return db
    .select({
      kind: supportActions.kind,
      key: supportActions.actorKey,
      label: supportActions.actorLabel,
      input: supportActions.input,
      externalId: supportActions.externalId,
      at: supportActions.createdAt,
    })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.thread, thread),
        inArray(supportActions.kind, ['message_in', 'reply']),
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(LANGUAGE_READ);
}

/** Whether a raise already named `message` as the one it answers. */
async function answeredByRaise(message: string): Promise<boolean> {
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        inArray(supportActions.kind, ['routed', 'operation']),
        inArray(supportActions.tool, ['technical', 'raise_owed']),
        sql`${supportActions.input} ->> 'answers' = ${message}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The technical thread `at` holds (null for a direct message, whose lines Forge does not record),
 * read for a raise from `room`: its reader's language and name, and a person's message the raise
 * has to answer, with the bot's answer standing since.
 */
export async function readTechnicalTurn(
  room: RoomRow,
  at: { roomId: string; thread: string } | null,
  owner: { key: string | null; name: string | null },
  now: Date = new Date(),
): Promise<TechnicalTurn> {
  const rows = at ? await threadRows(at.roomId, at.thread) : [];
  const people = rows.filter((r) => r.kind === 'message_in' && r.key !== null);
  const language =
    (await ownerLanguage(owner.key)) ??
    languageOfTexts(people.map((r) => textOf(r.input))) ??
    (await roomLanguage(room, []));
  const last = people[0];
  const inTurn = last?.externalId && now.getTime() - last.at.getTime() <= RAISE_TURN_MS;
  const spoke =
    last?.externalId && inTurn && !(await answeredByRaise(last.externalId))
      ? { message: last.externalId, writer: last.label, text: textOf(last.input), at: last.at }
      : null;
  const answer = spoke
    ? rows.find((r) => r.kind === 'reply' && r.at.getTime() >= spoke.at.getTime())
    : undefined;
  return {
    language,
    addressee: spoke?.writer ?? owner.name,
    spoke,
    standing: answer ? textOf(answer.input) : null,
  };
}

/** How the reader is spoken to, said the same way by every refusal and task. */
export const speakTo = (turn: Pick<TechnicalTurn, 'language' | 'addressee'>): string =>
  `in ${LANGUAGE_NAME[turn.language]}, to ${turn.addressee ? `@${turn.addressee}` : 'the owner'} in the second person, as a reply in the conversation: no "<project> asks" lead and no third person about him`;

/**
 * A raise the thread holds: a person spoke in it within the turn and the raise names no answer to
 * him. Refused by name with his words and the answer standing, so the agent acts on his ruling or
 * answers the promise instead of asking again; null where the raise may speak.
 */
export function heldRaise(
  turn: TechnicalTurn,
  answers: string | undefined,
  sameRoom: boolean,
): Outcome<never> | null {
  const spoke = turn.spoke;
  if (!spoke || answers === spoke.message) return null;
  const who = spoke.writer ? `@${spoke.writer}` : 'a person';
  const standing = turn.standing
    ? `The thread's answer to him since, which stands as its promise:\n${markUntrusted(quoted(turn.standing), { source: 'the thread answer standing' })}\nYour words answer that promise, saying what came of it, and never contradict it.`
    : '';
  const act = sameRoom
    ? `Where his words already rule on what you raise (an act he asked for or allowed), make it as him now with support.owner_forge_act (or answer_question, release_decision) citing message ${spoke.message}, and post no ask: tell him once that it is done, or name the one act no door makes.`
    : 'Where his words already rule on what you raise, your words say what is done on his ruling, never the ask again.';
  return no(
    'SUPPORT_RAISE_THREAD_UNREAD',
    '/answers',
    // his words, and the answer standing, are data framed in the refusal, never core's (ISS-1425)
    `${who} wrote in the technical thread ${Math.max(1, Math.round((Date.now() - spoke.at.getTime()) / 60_000))} min ago, message ${spoke.message}:\n${markUntrusted(quoted(spoke.text), { source: 'a person in the technical thread' })}\n${[standing, act].filter(Boolean).join(' ')} To post, raise again with answers: "${spoke.message}", your words ${speakTo(turn)}. Nothing was raised.`,
  );
}

/**
 * Words the agent wrote in another language than the thread's reader reads, refused by name so it
 * rewrites them for him; null where they fit or their language cannot be told.
 */
export function wordsMisfit(turn: TechnicalTurn, words: string): Outcome<never> | null {
  const told = confidentLanguageOf(words);
  if (!told || told === turn.language) return null;
  return no(
    'SUPPORT_RAISE_NOT_IN_THREAD_LANGUAGE',
    '/text',
    `the technical thread's reader writes ${LANGUAGE_NAME[turn.language]}, and your words are ${LANGUAGE_NAME[told]}: the line is posted in his language, never the language words arrive in. Write them ${speakTo(turn)}, and raise again. Nothing was raised.`,
  );
}
