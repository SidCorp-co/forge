/**
 * The rule that cuts a room's retained transcript into bounded, source-linked
 * passages, and the pass that writes them (ISS-1090).
 *
 * Two properties are the whole of this file and everything in it serves one or
 * the other:
 *
 * - **Total over retained content.** Every transcript row with text in it is
 *   indexed, whatever the window it fell in decided. An index built from what
 *   an answering turn kept would forget every silence the guards were right
 *   about.
 * - **Rebuildable.** Dropping every row and rebuilding from the transcript
 *   alone yields the same rows, because the rule is a deterministic greedy walk
 *   from the start of the transcript and the unclosed tail is written open and
 *   re-derived rather than resumed from.
 *
 * Nothing here summarises. A passage is its rows' own text, framed with the
 * speaker, and a pointer back at the range it came from.
 */

import { type AnyColumn, and, asc, desc, eq, gte, lte, type SQL, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import type { ConversationMessageRole } from '../db/schema-conversations.js';
import { conversationMessages, conversations } from '../db/schema-conversations.js';
import { conversationIndexState, conversationPassages } from '../db/schema-transcript-index.js';

/**
 * The version of the rule below. A room indexed under an older one is rebuilt.
 */
export const PASSAGE_BUILDER_REVISION = 1;

/** Source characters a passage may hold. Every passage is under it; the tail of a long message is a passage of its own. */
export const PASSAGE_MAX_CHARS = 2000;
/** Fragments a passage may hold. */
export const PASSAGE_MAX_MESSAGES = 10;
/** The speaker label a passage line carries, clipped, so a passage's text has a bound and not a hope. */
export const SPEAKER_LABEL_CAP = 40;
/**
 * The hard ceiling on a stored passage's text.
 */
export const PASSAGE_TEXT_BOUND =
  PASSAGE_MAX_CHARS + PASSAGE_MAX_MESSAGES * (SPEAKER_LABEL_CAP + 5);
/** Transcript rows one pass reads, so a first index of a long room is many bounded passes rather than one unbounded one. */
export const INDEX_PASS_MESSAGE_LIMIT = 500;

/**
 * A watermark meaning "the pass read this room and it holds no rows".
 */
export const WATERMARK_EMPTY = -1;

export interface IndexableMessage {
  seq: number;
  role: ConversationMessageRole;
  authorLabel: string | null;
  content: string;
  createdAt: Date;
}

type IndexTx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

const MESSAGE_COLUMNS = {
  seq: conversationMessages.seq,
  role: conversationMessages.role,
  authorLabel: conversationMessages.authorLabel,
  content: conversationMessages.content,
  createdAt: conversationMessages.createdAt,
} as const;

/**
 * The whitespace this index trims, spelled once for both halves.
 */
const TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

/** The text a row contributes, which is its content with the surrounding whitespace off and nothing else done to it. */
export function sourceOf(message: Pick<IndexableMessage, 'content'>): string {
  return message.content.replace(TRIM, '');
}

/** The SQL half of {@link eligibleForIndex}: this row has something other than whitespace in it. */
export function hasText(column: AnyColumn): SQL {
  return sql`${column} ~ '[^ \\t\\n\\r\\f\\v]'`;
}

/**
 * Whether a transcript row has anything to index.
 */
export function eligibleForIndex(message: Pick<IndexableMessage, 'content'>): boolean {
  return sourceOf(message).length > 0;
}

/** One bounded piece of one message's text, and where in that message it starts. */
export interface Fragment {
  seq: number;
  /** Character offset into the message's trimmed content. */
  offset: number;
  text: string;
  label: string;
  at: Date;
}

/** The index of the last whitespace character in a string, or -1. */
function lastWhitespace(s: string): number {
  for (let i = s.length - 1; i >= 0; i -= 1) {
    if (/\s/.test(s[i] as string)) return i;
  }
  return -1;
}

/**
 * Cut one message into fragments no longer than {@link PASSAGE_MAX_CHARS}.
 */
export function fragmentsOf(message: IndexableMessage, from = 0): Fragment[] {
  const src = sourceOf(message);
  const label = (message.authorLabel ?? message.role).slice(0, SPEAKER_LABEL_CAP);
  const out: Fragment[] = [];
  let offset = from;
  while (offset < src.length) {
    if (src.length - offset <= PASSAGE_MAX_CHARS) {
      out.push({ seq: message.seq, offset, text: src.slice(offset), label, at: message.createdAt });
      break;
    }
    const window = src.slice(offset, offset + PASSAGE_MAX_CHARS);
    const ws = lastWhitespace(window);
    const cut = ws >= PASSAGE_MAX_CHARS / 2 ? ws : PASSAGE_MAX_CHARS;
    out.push({
      seq: message.seq,
      offset,
      text: src.slice(offset, offset + cut),
      label,
      at: message.createdAt,
    });
    offset += cut;
  }
  return out;
}

/** A passage, before it is a row. */
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

/**
 * Cut a run of transcript rows into passages.
 */
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

/** What one pass did. */
export interface IndexPass {
  conversationId: string;
  outcome: 'indexed' | 'conversation-gone';
  passagesWritten: number;
  /** The highest `seq` this pass READ — never the cut it would have liked to reach. */
  indexedThroughSeq: number;
  rebuilt: boolean;
}

interface ResumePoint {
  /** The fragment the rebuilt tail begins on. */
  seq: number;
  offset: number;
  /**
   * The seq above which this pass spends its row budget.
   */
  budgetFloor: number;
}

/**
 * Index one room, once.
 */
export async function indexConversationOnce(
  conversationId: string,
  opts: { rebuild?: boolean; db?: typeof defaultDb } = {},
): Promise<IndexPass> {
  const dbi = opts.db ?? defaultDb;
  return dbi.transaction(async (tx) => {
    const [live] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('update')
      .limit(1);
    if (!live) {
      return {
        conversationId,
        outcome: 'conversation-gone' as const,
        passagesWritten: 0,
        indexedThroughSeq: WATERMARK_EMPTY,
        rebuilt: false,
      };
    }

    const [state] = await tx
      .select()
      .from(conversationIndexState)
      .where(eq(conversationIndexState.conversationId, conversationId))
      .limit(1);
    const rebuild =
      opts.rebuild === true || !state || state.builderRevision !== PASSAGE_BUILDER_REVISION;

    const resume = await clearAndResume(
      tx,
      conversationId,
      rebuild,
      state?.indexedThroughSeq ?? -1,
    );

    const [top] = await tx
      .select({ seq: conversationMessages.seq })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(desc(conversationMessages.seq))
      .limit(1);
    const cut = top?.seq ?? WATERMARK_EMPTY;

    const tailRows = await readTailRows(tx, conversationId, resume);
    const newRows = await readNewRows(tx, conversationId, resume.budgetFloor, cut);
    const drafts = buildPassages([...tailRows, ...newRows], resume);
    if (drafts.length > 0) {
      await tx.insert(conversationPassages).values(
        drafts.map((d) => ({
          conversationId,
          firstSeq: d.firstSeq,
          firstOffset: d.firstOffset,
          lastSeq: d.lastSeq,
          lastOffset: d.lastOffset,
          messageCount: d.fragmentCount,
          startedAt: d.startedAt,
          endedAt: d.endedAt,
          text: d.text,
          isOpen: d.isOpen,
        })),
      );
    }

    const last = newRows[newRows.length - 1];
    const readThrough = last ? last.seq : resume.budgetFloor;
    await tx
      .insert(conversationIndexState)
      .values({
        conversationId,
        indexedThroughSeq: readThrough,
        indexedThroughAt: last ? last.createdAt : null,
        builderRevision: PASSAGE_BUILDER_REVISION,
        indexedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: conversationIndexState.conversationId,
        set: {
          indexedThroughSeq: readThrough,
          indexedThroughAt: last ? last.createdAt : null,
          builderRevision: PASSAGE_BUILDER_REVISION,
          indexedAt: new Date(),
        },
      });

    return {
      conversationId,
      outcome: 'indexed' as const,
      passagesWritten: drafts.length,
      indexedThroughSeq: readThrough,
      rebuilt: rebuild,
    };
  });
}

/**
 * Take the index back to the point this pass must resume from, and say where that is.
 */
async function clearAndResume(
  tx: IndexTx,
  conversationId: string,
  rebuild: boolean,
  watermark: number,
): Promise<ResumePoint> {
  if (rebuild) {
    await tx
      .delete(conversationPassages)
      .where(eq(conversationPassages.conversationId, conversationId));
    return { seq: 0, offset: 0, budgetFloor: WATERMARK_EMPTY };
  }
  const [open] = await tx
    .select({
      firstSeq: conversationPassages.firstSeq,
      firstOffset: conversationPassages.firstOffset,
    })
    .from(conversationPassages)
    .where(
      and(
        eq(conversationPassages.conversationId, conversationId),
        eq(conversationPassages.isOpen, true),
      ),
    )
    .limit(1);
  if (!open) return { seq: watermark + 1, offset: 0, budgetFloor: watermark };
  await tx
    .delete(conversationPassages)
    .where(
      and(
        eq(conversationPassages.conversationId, conversationId),
        eq(conversationPassages.isOpen, true),
      ),
    );
  return { seq: open.firstSeq, offset: open.firstOffset, budgetFloor: watermark };
}

/**
 * The rows the deleted open tail was built from.
 */
async function readTailRows(
  tx: IndexTx,
  conversationId: string,
  resume: ResumePoint,
): Promise<IndexableMessage[]> {
  if (resume.budgetFloor < resume.seq) return [];
  const rows = await tx
    .select(MESSAGE_COLUMNS)
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        gte(conversationMessages.seq, resume.seq),
        lte(conversationMessages.seq, resume.budgetFloor),
        hasText(conversationMessages.content),
      ),
    )
    .orderBy(asc(conversationMessages.seq))
    .limit(PASSAGE_MAX_MESSAGES + 1);
  const eligible = rows.filter(eligibleForIndex);
  if (eligible.length > PASSAGE_MAX_MESSAGES) {
    throw new Error(
      `conversation ${conversationId}: the open passage at seq ${resume.seq} covers more than ${PASSAGE_MAX_MESSAGES} messages up to the watermark ${resume.budgetFloor}, so it was not the last accumulator and the index cannot be resumed from it; rebuild this room's index`,
    );
  }
  return eligible;
}

/** The rows above the watermark this pass spends its budget on. */
async function readNewRows(
  tx: IndexTx,
  conversationId: string,
  floor: number,
  cut: number,
): Promise<IndexableMessage[]> {
  if (cut <= floor) return [];
  return tx
    .select(MESSAGE_COLUMNS)
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        gte(conversationMessages.seq, floor + 1),
        lte(conversationMessages.seq, cut),
      ),
    )
    .orderBy(asc(conversationMessages.seq))
    .limit(INDEX_PASS_MESSAGE_LIMIT);
}

/** Throw the room's index away and build it again from the transcript alone. */
export async function rebuildConversationIndex(
  conversationId: string,
  opts: { db?: typeof defaultDb } = {},
): Promise<IndexPass> {
  return indexConversationOnce(conversationId, { ...opts, rebuild: true });
}

/**
 * The rooms whose transcript has moved past what the index has read.
 */
export async function conversationsNeedingIndex(
  limit: number,
  dbi: typeof defaultDb = defaultDb,
): Promise<string[]> {
  const rows = await dbi.execute<{ conversation_id: string }>(sql`
    SELECT m.conversation_id
    FROM ${conversationMessages} m
    LEFT JOIN ${conversationIndexState} s ON s.conversation_id = m.conversation_id
    GROUP BY m.conversation_id, s.indexed_through_seq, s.builder_revision
    HAVING s.indexed_through_seq IS NULL
        OR max(m.seq) > s.indexed_through_seq
        OR s.builder_revision <> ${PASSAGE_BUILDER_REVISION}
    LIMIT ${limit}
  `);
  const list = Array.isArray(rows)
    ? (rows as Array<{ conversation_id: string }>)
    : ((rows as { rows?: Array<{ conversation_id: string }> }).rows ?? []);
  return list.map((r) => r.conversation_id);
}
