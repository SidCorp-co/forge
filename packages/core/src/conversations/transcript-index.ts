/**
 * The pass that writes a room's transcript passages (ISS-1090). It is total over
 * retained content — every row with text is indexed, whatever its window decided —
 * and rebuildable: the unclosed tail is written open and re-derived rather than
 * resumed from.
 */

import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { conversationMessages, conversations } from '../db/schema-conversations.js';
import { conversationIndexState, conversationPassages } from '../db/schema-transcript-index.js';
import {
  buildPassages,
  eligibleForIndex,
  hasText,
  type IndexableMessage,
  PASSAGE_BUILDER_REVISION,
  PASSAGE_MAX_MESSAGES,
  type PassageDraft,
  WATERMARK_EMPTY,
} from './transcript-passages.js';

/** Transcript rows one pass reads, so a first index of a long room is many bounded passes rather than one unbounded one. */
const INDEX_PASS_MESSAGE_LIMIT = 500;

type IndexTx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

const MESSAGE_COLUMNS = {
  seq: conversationMessages.seq,
  role: conversationMessages.role,
  authorLabel: conversationMessages.authorLabel,
  content: conversationMessages.content,
  createdAt: conversationMessages.createdAt,
} as const;

/** What one pass did. */
interface IndexPass {
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
  /** The seq above which this pass spends its row budget. */
  budgetFloor: number;
}

/** Index one room, once: rebuild the open tail, then spend the row budget above the watermark. */
export async function indexConversationOnce(
  conversationId: string,
  opts: { rebuild?: boolean; db?: typeof defaultDb } = {},
): Promise<IndexPass> {
  return (opts.db ?? defaultDb).transaction(async (tx) => {
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
    const tailRows = await readTailRows(tx, conversationId, resume);
    const newRows = await readNewRows(
      tx,
      conversationId,
      resume.budgetFloor,
      top?.seq ?? WATERMARK_EMPTY,
    );
    const drafts = buildPassages([...tailRows, ...newRows], resume);
    await insertPassages(tx, conversationId, drafts);

    const last = newRows[newRows.length - 1];
    const readThrough = last ? last.seq : resume.budgetFloor;
    await writeState(tx, conversationId, readThrough, last?.createdAt ?? null);
    return {
      conversationId,
      outcome: 'indexed' as const,
      passagesWritten: drafts.length,
      indexedThroughSeq: readThrough,
      rebuilt: rebuild,
    };
  });
}

async function insertPassages(tx: IndexTx, conversationId: string, drafts: PassageDraft[]) {
  if (drafts.length === 0) return;
  await tx
    .insert(conversationPassages)
    .values(
      drafts.map(({ fragmentCount, ...d }) => ({
        conversationId,
        ...d,
        messageCount: fragmentCount,
      })),
    );
}

async function writeState(
  tx: IndexTx,
  conversationId: string,
  indexedThroughSeq: number,
  indexedThroughAt: Date | null,
) {
  const set = {
    indexedThroughSeq,
    indexedThroughAt,
    builderRevision: PASSAGE_BUILDER_REVISION,
    indexedAt: new Date(),
  };
  await tx
    .insert(conversationIndexState)
    .values({ conversationId, ...set })
    .onConflictDoUpdate({ target: conversationIndexState.conversationId, set });
}

/** Take the index back to the point this pass must resume from, and say where that is. */
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

/** The rows the deleted open tail was built from. */
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

/** The rooms whose transcript has moved past what the index has read. */
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
