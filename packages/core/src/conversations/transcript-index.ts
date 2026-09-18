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
// cm:guard bumped by ANY change to `sourceOf`, `eligibleForIndex`, `fragmentsOf` or `buildPassages`, because each of them decides where a boundary falls: a room resumed under a new rule holds passages no rebuild reproduces, which is the one property this index sells.
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
// cm:guard this is what "embeddings later over bounded passages" rests on and it is asserted over every generated passage rather than argued for here: `[label]: ` is the label plus four characters and each line but the first adds a newline, so the framing costs at most `PASSAGE_MAX_MESSAGES * (SPEAKER_LABEL_CAP + 5)` on top of the source characters. An unbounded passage would mean an embedding pass had to re-cut every boundary it was promised it could reuse (plan consult F3).
export const PASSAGE_TEXT_BOUND =
  PASSAGE_MAX_CHARS + PASSAGE_MAX_MESSAGES * (SPEAKER_LABEL_CAP + 5);
/** Transcript rows one pass reads, so a first index of a long room is many bounded passes rather than one unbounded one. */
export const INDEX_PASS_MESSAGE_LIMIT = 500;

/**
 * A watermark meaning "the pass read this room and it holds no rows".
 */
// cm:guard an explicit value rather than a null column, because the two questions a reader asks are "how far has it read" and "has it read at all", and `seq` starts at 0 — so 0 would say the first message is covered by a pass that saw nothing.
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
// cm:guard six ASCII code points, SPELLED OUT on both halves and named by no character class on either: the pass reads its rows through {@link hasText} in SQL and decides eligibility here in TypeScript, and a row the two disagreed about is an open tail that counts eleven messages against a ceiling of ten and throws on every tick for ever, plus a retrieval whose source cap fills with rows no passage was built from (plan consult round 4 F1). Neither engine's default is this set, which is why neither engine's default is used: Postgres's `btrim` trims spaces alone, `[[:space:]]` under a UTF-8 ctype also eats U+2003 EM SPACE, and JavaScript's own `String.prototype.trim` eats the Unicode space separators as well — so a row of nothing but an em space is a silence to two of those three and text to this one. These six are what both engines can be made to spell identically (plan consult round 5 F1). A message of nothing but an em space or a non-breaking space is therefore indexed everywhere, which is a passage of one odd character rather than a room that stops being searchable.
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
// cm:guard the ONLY test is whether there is text, and it deliberately reads nothing about the window the row fell in, that window's `decision`, or whether an answering turn's prompt ever carried the row. Indexing what a turn kept would forget every window the guards were right to stay quiet in — the room nobody answered and nobody should be unable to search (ISS-1090 rule 2). A row failing this is a recorded silence, whose reason is a column and whose text is empty; there is nothing in it to find.
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
// cm:guard a message longer than the bound is SPLIT and never truncated and never given a passage of its own over the bound: truncating would lose retained text the transcript still holds, and an over-long singleton passage is exactly the unbounded row an embedding pass cannot take. The cut prefers the last whitespace in the window, but only past its half-way point — a whitespace at index 3 would otherwise make thousands of three-character fragments out of one paragraph of prose with a stray early space (plan consult F3).
// cm:guard `from` is a RESUME point and not a window: an incremental pass re-derives the open tail from the fragment offset it recorded, so a message half of which is already in a closed passage yields only the rest of itself here. Offsets are into the TRIMMED content, which is what `sourceOf` returns and what the stored offsets index.
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
// cm:guard GREEDY FROM THE LEFT, which is what makes an incremental pass write the rows a full rebuild writes: the boundary of passage k depends only on the fragments before it, so a pass that resumes at a passage boundary produces the same suffix a rebuild would. Any rule that looked ahead — balancing sizes, ending on a speaker change — would lose that and take the rebuild equality with it (ISS-1090 rule 5).
// cm:guard the unclosed tail is emitted with `isOpen`, never dropped and never closed: dropping it makes the newest of a room unsearchable until enough is said to fill a passage, and closing it makes the next pass unable to grow it without writing a row no rebuild reproduces.
// cm:guard `resumeAt` applies to the message with THAT seq and not to whichever row happens to be first: a pass reads rows from the resume point, and a row before it that the caller included must not have its offsets shifted.
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
  // cm:guard the budget is spent ABOVE the watermark and never from the resume point, and the two are different numbers whenever an open tail sits behind a run of recorded silences: a room with one message at seq 1 and a thousand silences after it resumes at seq 1 for ever, re-reads the same first 500 rows every tick, and never advances past them — so the message at seq 1002 is retained, indexed by nothing, and nothing says so (plan consult round 3 F1).
  budgetFloor: number;
}

/**
 * Index one room, once.
 */
// cm:guard the whole pass is ONE transaction holding the room's own writer lock — the same `SELECT … FOR UPDATE` on `conversations` that `store.ts:appendMessagesIn` takes before it allocates a `seq`. Three things need it and none of them is optional: the cut is only a cut if no row can appear below it afterwards, the deleted open tail and the passages replacing it must never be separately visible, and two passes over one room would otherwise both write the run the unique index refuses (plan consult F1).
// cm:guard the watermark written is the last row this pass READ and not the cut: a long room is indexed in bounded batches, and writing the cut would tell every later reader that rows nobody has looked at are covered. Under-reporting is recoverable on the next tick; over-reporting is a room that never gets indexed and never says so.
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
// cm:guard a rebuild deletes EVERY passage and resumes at the start; an ordinary pass deletes only the open tail and resumes at exactly the fragment that tail began on. Resuming after the tail instead — keeping it and appending — is what makes an incremental index diverge from a rebuild, because the tail would then be a closed passage of a size the rule never chose (ISS-1090 rule 5).
// cm:guard with no open tail and a state row, the resume point is the WATERMARK plus one and not zero: a room whose every row so far was a recorded silence has no passage to resume from and re-reading it from the beginning on every tick is the scan this index exists to remove.
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
// cm:guard read by ELIGIBILITY and bounded by the tail's own fragment ceiling rather than by the pass's row budget: everything between the tail's first fragment and the watermark that had text is in the tail, and there can be at most `PASSAGE_MAX_MESSAGES` of it, however many silences lie between. A row past that ceiling means the tail was not the last accumulator, which is an invariant break and is thrown by name rather than quietly truncated into a passage no rebuild reproduces.
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
  // cm:guard filtered again by the TypeScript rule before the count is judged: the SQL predicate is the
  // same class, and this is what makes that a property the code holds rather than one it asserts.
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
// cm:guard a room is chosen by comparing the transcript's own maximum against the state row, never by a flag a writer sets: a flag is a second copy of a fact the two tables already hold between them, and a missed flag is a room that is never indexed again and never says so.
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
