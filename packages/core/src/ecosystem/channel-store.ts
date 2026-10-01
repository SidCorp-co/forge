import { and, arrayContains, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  channelDocumentEvents,
  channelDocuments,
  channelThreadHolds,
} from '../db/schema-ecosystem.js';
import type { Author } from './channel-schema.js';
import type { DocumentType } from './schema.js';

export type StoredState = 'draft' | 'submitted' | 'returned' | 'published';

export interface DocumentRow {
  id: string;
  ecosystemId: string;
  type: DocumentType;
  fromProjectId: string;
  toProjectIds: string[];
  number: string | null;
  state: StoredState;
  inReplyTo: string | null;
  thread: string | null;
  document: unknown;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
}

export interface EventRow {
  id: string;
  documentId: string;
  verb: string;
  fromState: string | null;
  toState: string;
  actorKind: string;
  actorId: string;
  actorVia: string;
  userId: string;
  reason: string | null;
  supersededBy: string | null;
  at: Date;
}

export interface HoldRow {
  id: string;
  ecosystemId: string;
  thread: string;
  action: string;
  byKind: string;
  byId: string;
  byVia: string;
  userId: string;
  sideProjectId: string;
  reason: string | null;
  at: Date;
}

const documentColumns = {
  id: channelDocuments.id,
  ecosystemId: channelDocuments.ecosystemId,
  type: channelDocuments.type,
  fromProjectId: channelDocuments.fromProjectId,
  toProjectIds: channelDocuments.toProjectIds,
  number: channelDocuments.number,
  state: channelDocuments.state,
  inReplyTo: channelDocuments.inReplyTo,
  thread: channelDocuments.thread,
  document: channelDocuments.document,
  createdAt: channelDocuments.createdAt,
  updatedAt: channelDocuments.updatedAt,
  publishedAt: channelDocuments.publishedAt,
};

const asRow = (r: { type: string; state: string } & Omit<DocumentRow, 'type' | 'state'>) =>
  ({ ...r, type: r.type as DocumentType, state: r.state as StoredState }) satisfies DocumentRow;

export async function readDocument(tx: Tx, id: string): Promise<DocumentRow | null> {
  const [row] = await tx
    .select(documentColumns)
    .from(channelDocuments)
    .where(eq(channelDocuments.id, id))
    .limit(1);
  return row ? asRow(row) : null;
}

export async function readNumbered(tx: Tx, number: string): Promise<DocumentRow | null> {
  const [row] = await tx
    .select(documentColumns)
    .from(channelDocuments)
    .where(eq(channelDocuments.number, number))
    .limit(1);
  return row ? asRow(row) : null;
}

export async function documentsWhere(
  tx: Tx,
  filter: { ecosystem?: string; from?: string; to?: string; thread?: string; published?: true },
): Promise<DocumentRow[]> {
  const conditions = [
    ...(filter.ecosystem ? [eq(channelDocuments.ecosystemId, filter.ecosystem)] : []),
    ...(filter.from ? [eq(channelDocuments.fromProjectId, filter.from)] : []),
    ...(filter.to ? [arrayContains(channelDocuments.toProjectIds, [filter.to])] : []),
    ...(filter.thread ? [eq(channelDocuments.thread, filter.thread)] : []),
    ...(filter.published ? [eq(channelDocuments.state, 'published')] : []),
  ];
  if (conditions.length === 0) throw new Error('channel: documentsWhere needs a filter');
  const rows = await tx
    .select(documentColumns)
    .from(channelDocuments)
    .where(and(...conditions))
    .orderBy(asc(channelDocuments.createdAt));
  return rows.map(asRow);
}

export async function insertDraft(
  tx: Tx,
  row: {
    id: string;
    ecosystemId: string;
    type: DocumentType;
    fromProjectId: string;
    toProjectIds: string[];
    inReplyTo: string | null;
    author: Author;
    document: unknown;
    userId: string;
  },
): Promise<void> {
  await tx.insert(channelDocuments).values({
    id: row.id,
    ecosystemId: row.ecosystemId,
    type: row.type,
    fromProjectId: row.fromProjectId,
    toProjectIds: row.toProjectIds,
    state: 'draft',
    inReplyTo: row.inReplyTo,
    authorKind: row.author.kind,
    authorId: row.author.id,
    authorVia: row.author.via,
    document: row.document,
    createdBy: row.userId,
  });
}

export async function rewriteDocument(
  tx: Tx,
  id: string,
  patch: {
    state: StoredState;
    number: string | null;
    thread: string | null;
    toProjectIds: string[];
    inReplyTo: string | null;
    author: Author;
    document: unknown;
    publishedAt: Date | null;
  },
): Promise<void> {
  await tx
    .update(channelDocuments)
    .set({
      state: patch.state,
      number: patch.number,
      thread: patch.thread,
      toProjectIds: patch.toProjectIds,
      inReplyTo: patch.inReplyTo,
      authorKind: patch.author.kind,
      authorId: patch.author.id,
      authorVia: patch.author.via,
      document: patch.document,
      publishedAt: patch.publishedAt,
      updatedAt: new Date(),
    })
    .where(eq(channelDocuments.id, id));
}

export async function insertEvent(
  tx: Tx,
  event: {
    documentId: string;
    verb: string;
    fromState: string | null;
    toState: string;
    actor: Author;
    userId: string;
    reason?: string | null;
    supersededBy?: string | null;
    at?: Date;
  },
): Promise<void> {
  await tx.insert(channelDocumentEvents).values({
    documentId: event.documentId,
    verb: event.verb,
    fromState: event.fromState,
    toState: event.toState,
    actorKind: event.actor.kind,
    actorId: event.actor.id,
    actorVia: event.actor.via,
    userId: event.userId,
    reason: event.reason ?? null,
    supersededBy: event.supersededBy ?? null,
    ...(event.at ? { at: event.at } : {}),
  });
}

export async function eventsOf(tx: Tx, documentIds: readonly string[]): Promise<EventRow[]> {
  if (documentIds.length === 0) return [];
  return tx
    .select()
    .from(channelDocumentEvents)
    .where(inArray(channelDocumentEvents.documentId, [...documentIds]))
    .orderBy(
      asc(channelDocumentEvents.at),
      asc(
        sql`array_position(ARRAY['draft','edit','submit','return','approve','publish','withdraw','supersede']::text[], ${channelDocumentEvents.verb})`,
      ),
    );
}

export async function reserveNumber(tx: Tx, ecosystemId: string, type: DocumentType) {
  const rows = await tx.execute<{ last_number: number }>(sql`
    INSERT INTO channel_counters (ecosystem_id, type, last_number) VALUES (${ecosystemId}, ${type}, 1)
    ON CONFLICT (ecosystem_id, type) DO UPDATE SET last_number = channel_counters.last_number + 1
    RETURNING last_number
  `);
  const n = [...rows][0]?.last_number;
  if (typeof n !== 'number') throw new Error('channel: the counter returned no number');
  return n;
}

export async function holdsOn(tx: Tx, threads: readonly string[]): Promise<HoldRow[]> {
  if (threads.length === 0) return [];
  return tx
    .select()
    .from(channelThreadHolds)
    .where(inArray(channelThreadHolds.thread, [...threads]))
    .orderBy(asc(channelThreadHolds.at));
}

export async function insertHold(tx: Tx, row: Omit<HoldRow, 'at'> & { at: Date }) {
  await tx.insert(channelThreadHolds).values(row);
}

export async function repliesFrom(
  tx: Tx,
  projectId: string,
  numbers: readonly string[],
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const rows = await tx
    .select({ inReplyTo: channelDocuments.inReplyTo })
    .from(channelDocuments)
    .where(
      and(
        eq(channelDocuments.fromProjectId, projectId),
        eq(channelDocuments.state, 'published'),
        inArray(channelDocuments.inReplyTo, [...numbers]),
        sql`NOT EXISTS (SELECT 1 FROM channel_document_events e WHERE e.document_id = ${channelDocuments.id} AND e.verb = 'withdraw')`,
      ),
    )
    .orderBy(desc(channelDocuments.publishedAt));
  return new Set(rows.flatMap((r) => (r.inReplyTo ? [r.inReplyTo] : [])));
}
