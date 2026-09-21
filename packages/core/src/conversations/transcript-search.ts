/**
 * Asking a room about its own past (ISS-1090).
 *
 * One door, and it checks access ITSELF. `memory/search-service.ts` says in its
 * own header that it does not authorize and leaves that to its routes, which is
 * a fair arrangement for rows that carry the project they belong to. A room
 * carries none: its scope is the union of its live handles' projects, read at
 * the moment of the read, so a search that took an already-checked caller would
 * be one caller away from answering under the wrong room's audience. The fence
 * is `readableConversation`, which is the same one the room's own screens take.
 *
 * Every bound below is spent here, in core, and none of them is asked of the
 * model. What could not be shown is a stated limitation and never a guess.
 */

import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { readableConversation } from '../assistant/conversation-access.js';
import { db as defaultDb } from '../db/client.js';
import { conversationMessages } from '../db/schema-conversations.js';
import { conversationIndexState, conversationPassages } from '../db/schema-transcript-index.js';
import { identifierTsQuery } from '../db/schema-types.js';
import { hasText, PASSAGE_MAX_MESSAGES, WATERMARK_EMPTY } from './transcript-index.js';

/** Passages one call may return, however many the caller asks for. */
export const RETRIEVAL_MAX_RESULTS = 5;
/** Characters of a passage one hit may carry. */
export const RETRIEVAL_PASSAGE_CHAR_CAP = 1200;
/** The author label a source row carries. */
export const SOURCE_LABEL_CAP = 40;
/**
 * The transport id a source row carries.
 */
export const SOURCE_EXTERNAL_ID_CAP = 64;

/** One message a passage was built from. */
export interface PassageSource {
  messageId: string;
  seq: number;
  at: string;
  author: string | null;
  /** The transport's own id for this message, where it had one inside the bound. */
  externalId: string | null;
}

export interface PassageHit {
  passageId: string;
  firstSeq: number;
  lastSeq: number;
  startedAt: string;
  endedAt: string;
  text: string;
  /** The stored passage was longer than the per-hit cap and this is its head. */
  truncated: boolean;
  /** The passage may still grow — the index has not closed it. */
  stillOpen: boolean;
  sources: PassageSource[];
}

export interface IndexCoverage {
  /** The highest transcript seq the index has read, or {@link WATERMARK_EMPTY} where it has read none. */
  indexedThroughSeq: number;
  indexedThroughAt: string | null;
  /** The highest seq the transcript holds right now. */
  latestSeq: number;
  /** How many messages the room holds that the index has not read. */
  messagesBeyondIndex: number;
}

export interface TranscriptSearchResult {
  conversationId: string;
  query: string;
  matches: PassageHit[];
  coverage: IndexCoverage;
  /** Everything that could not be shown, joined; null when nothing was missing. */
  limitation: string | null;
}

export interface TranscriptSearchArgs {
  conversationId: string;
  userId: string | null | undefined;
  query: string;
  limit?: number | undefined;
  /** Something the venue knows this conversation does not cover, said as a limitation. */
  venueLimitation?: string | null | undefined;
  db?: typeof defaultDb;
}

const clip = (s: string, cap: number): string => (s.length > cap ? s.slice(0, cap) : s);

/**
 * Search one room's indexed past.
 */
export async function searchConversationTranscript(
  args: TranscriptSearchArgs,
): Promise<TranscriptSearchResult> {
  const dbi = args.db ?? defaultDb;
  await readableConversation(args.conversationId, args.userId);

  return dbi.transaction((tx) => searchInSnapshot(args, tx as unknown as typeof defaultDb), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

/** The whole read, against one snapshot of the index. */
async function searchInSnapshot(
  args: TranscriptSearchArgs,
  dbi: typeof defaultDb,
): Promise<TranscriptSearchResult> {
  const coverage = await readCoverage(args.conversationId, dbi);
  const requested = args.limit;
  const limit = Math.min(
    Math.max(
      1,
      Math.floor(
        typeof requested === 'number' && Number.isFinite(requested)
          ? requested
          : RETRIEVAL_MAX_RESULTS,
      ),
    ),
    RETRIEVAL_MAX_RESULTS,
  );
  const query = args.query.trim();

  const limits: string[] = [];
  if (args.venueLimitation) limits.push(args.venueLimitation);
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > limit) {
    limits.push(
      `you asked for ${Math.floor(requested)} passages and this room returns at most ${RETRIEVAL_MAX_RESULTS} a call, so ${limit} were read`,
    );
  }
  if (coverage.indexedThroughSeq === WATERMARK_EMPTY && coverage.latestSeq >= 0) {
    limits.push(
      `nothing in this room has been indexed yet, so none of its ${coverage.latestSeq + 1} messages can be found by topic here`,
    );
  } else if (coverage.messagesBeyondIndex > 0) {
    limits.push(
      `the index has read this room to message ${coverage.indexedThroughSeq} and ${coverage.messagesBeyondIndex} newer message(s) are not in it yet`,
    );
  }

  const rows = query ? await readHits(args.conversationId, query, limit, dbi) : [];
  if (!query) {
    limits.push('no query was given, so nothing was searched for');
  } else if (rows.length === 0) {
    limits.push(
      `no indexed passage in this room matches "${clip(query, 120)}"; the index covers messages 0 to ${coverage.indexedThroughSeq}`,
    );
  }

  const matches: PassageHit[] = [];
  for (const row of rows) {
    const { hit, missingIds } = await shapeHit(row, args.conversationId, dbi);
    matches.push(hit);
    if (missingIds.length > 0) {
      limits.push(
        `message(s) ${missingIds.join(', ')} carry no usable transport id, so no link to them can be built`,
      );
    }
    if (hit.truncated) {
      limits.push(
        `passage ${hit.passageId} was cut to the first ${RETRIEVAL_PASSAGE_CHAR_CAP} characters`,
      );
    }
  }

  return {
    conversationId: args.conversationId,
    query,
    matches,
    coverage,
    limitation: limits.length > 0 ? limits.join('; ') : null,
  };
}

/** What the index has read, measured against what the room holds right now. */
async function readCoverage(conversationId: string, dbi: typeof defaultDb): Promise<IndexCoverage> {
  const [state] = await dbi
    .select()
    .from(conversationIndexState)
    .where(eq(conversationIndexState.conversationId, conversationId))
    .limit(1);
  const [top] = await dbi
    .select({ seq: conversationMessages.seq })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(desc(conversationMessages.seq))
    .limit(1);
  const latestSeq = top?.seq ?? WATERMARK_EMPTY;
  const indexedThroughSeq = state?.indexedThroughSeq ?? WATERMARK_EMPTY;
  return {
    indexedThroughSeq,
    indexedThroughAt: state?.indexedThroughAt ? state.indexedThroughAt.toISOString() : null,
    latestSeq,
    messagesBeyondIndex: Math.max(0, latestSeq - indexedThroughSeq),
  };
}

interface PassageRow {
  id: string;
  firstSeq: number;
  lastSeq: number;
  startedAt: Date;
  endedAt: Date;
  text: string;
  isOpen: boolean;
}

/**
 * The passages matching a query, best first.
 */
async function readHits(
  conversationId: string,
  query: string,
  limit: number,
  dbi: typeof defaultDb,
): Promise<PassageRow[]> {
  const q = sql`websearch_to_tsquery('english', ${query})`;
  const qi = identifierTsQuery(query);
  const rank = sql<number>`ts_rank(${conversationPassages.textSearch}, ${q}) + ts_rank(${conversationPassages.identSearch}, ${qi})`;
  return dbi
    .select({
      id: conversationPassages.id,
      firstSeq: conversationPassages.firstSeq,
      lastSeq: conversationPassages.lastSeq,
      startedAt: conversationPassages.startedAt,
      endedAt: conversationPassages.endedAt,
      text: conversationPassages.text,
      isOpen: conversationPassages.isOpen,
    })
    .from(conversationPassages)
    .where(
      and(
        eq(conversationPassages.conversationId, conversationId),
        sql`(${conversationPassages.textSearch} @@ ${q} OR ${conversationPassages.identSearch} @@ ${qi})`,
      ),
    )
    .orderBy(desc(rank), desc(conversationPassages.firstSeq))
    .limit(limit);
}

/**
 * One passage, with the rows it was built from.
 */
async function shapeHit(
  row: PassageRow,
  conversationId: string,
  dbi: typeof defaultDb,
): Promise<{ hit: PassageHit; missingIds: string[] }> {
  const rows = await dbi
    .select({
      id: conversationMessages.id,
      seq: conversationMessages.seq,
      externalId: conversationMessages.externalId,
      authorLabel: conversationMessages.authorLabel,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        gte(conversationMessages.seq, row.firstSeq),
        lte(conversationMessages.seq, row.lastSeq),
        hasText(conversationMessages.content),
      ),
    )
    .orderBy(asc(conversationMessages.seq))
    .limit(PASSAGE_MAX_MESSAGES);

  const missingIds: string[] = [];
  const sources: PassageSource[] = rows.map((m) => {
    const usable =
      m.externalId && m.externalId.length <= SOURCE_EXTERNAL_ID_CAP ? m.externalId : null;
    if (!usable) missingIds.push(m.id);
    return {
      messageId: m.id,
      seq: m.seq,
      at: m.createdAt.toISOString(),
      author: m.authorLabel ? clip(m.authorLabel, SOURCE_LABEL_CAP) : null,
      externalId: usable,
    };
  });

  return {
    hit: {
      passageId: row.id,
      firstSeq: row.firstSeq,
      lastSeq: row.lastSeq,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt.toISOString(),
      text: clip(row.text, RETRIEVAL_PASSAGE_CHAR_CAP),
      truncated: row.text.length > RETRIEVAL_PASSAGE_CHAR_CAP,
      stillOpen: row.isOpen,
      sources,
    },
    missingIds,
  };
}
