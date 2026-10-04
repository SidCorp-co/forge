/**
 * The rule that cuts a room's retained transcript into bounded, source-linked
 * passages (ISS-1090). It is a deterministic greedy walk from the start of the
 * transcript, so dropping every passage and rebuilding from the transcript alone
 * yields the same rows. Nothing here summarises: a passage is its rows' own
 * text, framed with the speaker.
 */

import { type AnyColumn, type SQL, sql } from 'drizzle-orm';
import type { ConversationMessageRole } from '../db/schema-conversations.js';

/** The version of the rule below. A room indexed under an older one is rebuilt. */
export const PASSAGE_BUILDER_REVISION = 1;
/** Source characters a passage may hold; the tail of a long message is a passage of its own. */
const PASSAGE_MAX_CHARS = 2000;
export const PASSAGE_MAX_MESSAGES = 10;
/** The speaker label is clipped so a passage's text has a bound and not a hope. */
const SPEAKER_LABEL_CAP = 40;
/** A watermark meaning "the pass read this room and it holds no rows". */
export const WATERMARK_EMPTY = -1;

export interface IndexableMessage {
  seq: number;
  role: ConversationMessageRole;
  authorLabel: string | null;
  content: string;
  createdAt: Date;
}

/** The whitespace this index trims, spelled once for both the JS and the SQL half. */
const TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

function sourceOf(message: Pick<IndexableMessage, 'content'>): string {
  return message.content.replace(TRIM, '');
}

/** The SQL half of {@link eligibleForIndex}: this row has something other than whitespace in it. */
export function hasText(column: AnyColumn): SQL {
  return sql`${column} ~ '[^ \\t\\n\\r\\f\\v]'`;
}

export function eligibleForIndex(message: Pick<IndexableMessage, 'content'>): boolean {
  return sourceOf(message).length > 0;
}

/** One bounded piece of one message's text; `offset` is into the trimmed content. */
interface Fragment {
  seq: number;
  offset: number;
  text: string;
  label: string;
  at: Date;
}

/** Cut one message into fragments no longer than {@link PASSAGE_MAX_CHARS}, breaking on whitespace in the back half. */
function fragmentsOf(message: IndexableMessage, from = 0): Fragment[] {
  const src = sourceOf(message);
  const label = (message.authorLabel ?? message.role).slice(0, SPEAKER_LABEL_CAP);
  const out: Fragment[] = [];
  for (let offset = from; offset < src.length; ) {
    const window = src.slice(offset, offset + PASSAGE_MAX_CHARS);
    const ws = window.search(/\s\S*$/);
    const cut =
      src.length - offset <= PASSAGE_MAX_CHARS
        ? window.length
        : ws >= PASSAGE_MAX_CHARS / 2
          ? ws
          : PASSAGE_MAX_CHARS;
    out.push({
      seq: message.seq,
      offset,
      text: window.slice(0, cut),
      label,
      at: message.createdAt,
    });
    offset += cut;
  }
  return out;
}

export interface PassageDraft {
  firstSeq: number;
  firstOffset: number;
  lastSeq: number;
  lastOffset: number;
  fragmentCount: number;
  startedAt: Date;
  endedAt: Date;
  text: string;
  isOpen: boolean;
}

function draftOf(acc: readonly Fragment[], isOpen: boolean): PassageDraft {
  const first = acc[0] as Fragment;
  const last = acc[acc.length - 1] as Fragment;
  return {
    firstSeq: first.seq,
    firstOffset: first.offset,
    lastSeq: last.seq,
    lastOffset: last.offset + last.text.length,
    fragmentCount: acc.length,
    startedAt: first.at,
    endedAt: last.at,
    text: acc.map((f) => `[${f.label}]: ${f.text}`).join('\n'),
    isOpen,
  };
}

/** Cut a run of transcript rows into passages; the last, unclosed one is open and re-derived next pass. */
export function buildPassages(
  messages: readonly IndexableMessage[],
  resumeAt?: { seq: number; offset: number },
): PassageDraft[] {
  const fragments = messages
    .filter(eligibleForIndex)
    .flatMap((m) => fragmentsOf(m, resumeAt && resumeAt.seq === m.seq ? resumeAt.offset : 0));
  const out: PassageDraft[] = [];
  let acc: Fragment[] = [];
  let chars = 0;
  for (const f of fragments) {
    if (
      acc.length > 0 &&
      (chars + f.text.length > PASSAGE_MAX_CHARS || acc.length >= PASSAGE_MAX_MESSAGES)
    ) {
      out.push(draftOf(acc, false));
      acc = [];
      chars = 0;
    }
    acc.push(f);
    chars += f.text.length;
  }
  if (acc.length > 0) out.push(draftOf(acc, true));
  return out;
}
