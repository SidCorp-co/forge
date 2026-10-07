// MJ-1: the project's memory as a person reads it — what it says, who wrote it and when, whether
// anyone checked it, which records it names and which of those no longer resolve, and every
// correction or retirement a person made with their reason. Behind `GET /api/memory/entries`.
//
// Does NOT check authorization — callers MUST verify project membership before invoking.

import {
  MEMORY_AUTHORED_SOURCES,
  MEMORY_ENTRY_STATES,
  type MemoryAct,
  type MemoryActor,
  type MemoryEntry,
} from '@forge/contracts/memory';
import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memories, memorySources } from '../db/schema.js';
import { peopleOf } from '../lib/people.js';
import { memoryOfLiveIssue } from './live-issue.js';
import { type Citations, resolveCitations } from './stale-refs.js';

const NO_CITATIONS: Citations = { cites: [], staleRefs: [] };

export const memoryEntriesInputSchema = z.object({
  projectId: z.uuid(),
  /** Words to find in the text or the ref, any order; empty lists everything. */
  q: z.string().trim().max(200).optional(),
  sources: z
    .array(z.enum(memorySources))
    .min(1)
    .default([...MEMORY_AUTHORED_SOURCES]),
  /** `live` and `stale` hide retired and archived rows; `retired` lists only those. */
  state: z.enum(MEMORY_ENTRY_STATES).default('live'),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

type MemoryEntriesInput = z.infer<typeof memoryEntriesInputSchema>;

/** What `metadata` keeps of a person's act, before the actor is named. */
interface StoredAct {
  by: string | null;
  at: string;
  reason: string;
}

function storedAct(v: unknown): StoredAct | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== 'string' || typeof o.reason !== 'string') return null;
  return { by: typeof o.by === 'string' ? o.by : null, at: o.at, reason: o.reason };
}

function storedActs(v: unknown): StoredAct[] {
  return Array.isArray(v) ? v.map(storedAct).filter((a): a is StoredAct => a !== null) : [];
}

function likeWords(q: string | undefined): SQL[] {
  if (!q) return [];
  return q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((w) => {
      const pat = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return sql`(${memories.textContent} ILIKE ${pat} OR ${memories.sourceRef} ILIKE ${pat})`;
    });
}

/**
 * The rows the `stale` state reads: a release flagged them, or — derived after the page is read —
 * they name a record that no longer resolves. The first half is a column condition; the second is
 * applied to the rows read, so `stale` pages over flagged rows and every row citing a key.
 */
const CITES_A_KEY = sql`${memories.textContent} ~ '\\m[A-Z][A-Z0-9]{1,5}-[0-9]{1,6}\\M'`;

export async function readMemoryEntries(
  input: MemoryEntriesInput,
): Promise<{ rows: MemoryEntry[]; total: number }> {
  const conds: SQL[] = [
    eq(memories.projectId, input.projectId),
    inArray(memories.source, input.sources),
    ...likeWords(input.q),
  ];
  if (input.state === 'retired') conds.push(isNotNull(memories.archivedAt));
  else conds.push(isNull(memories.archivedAt), memoryOfLiveIssue(input.projectId));
  if (input.state === 'stale') {
    conds.push(sql`(${memories.metadata}->>'staleSince' IS NOT NULL OR ${CITES_A_KEY})`);
  }
  const where = and(...conds);

  const columns = {
    id: memories.id,
    source: memories.source,
    sourceRef: memories.sourceRef,
    text: memories.textContent,
    metadata: memories.metadata,
    createdAt: memories.createdAt,
    updatedAt: memories.updatedAt,
    lastVerifiedAt: memories.lastVerifiedAt,
    archivedAt: memories.archivedAt,
  };
  const ordered = () =>
    db
      .select(columns)
      .from(memories)
      .where(where)
      .orderBy(desc(memories.updatedAt), asc(memories.id));

  let page: { r: Awaited<ReturnType<typeof ordered>>[number]; c: Citations }[];
  let total: number;
  if (input.state === 'stale') {
    // Which candidates are stale is known only once their keys resolve, so the page is cut after.
    const read = await ordered();
    const resolved = await resolveCitations(
      input.projectId,
      read.map((r) => r.text),
    );
    const stale = read
      .map((r, i) => ({ r, c: resolved[i] ?? NO_CITATIONS }))
      .filter(
        ({ r, c }) =>
          c.staleRefs.length > 0 || Boolean((r.metadata as Record<string, unknown>)?.staleSince),
      );
    page = stale.slice(input.offset, input.offset + input.limit);
    total = stale.length;
  } else {
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(memories)
      .where(where);
    const read = await ordered().limit(input.limit).offset(input.offset);
    const resolved = await resolveCitations(
      input.projectId,
      read.map((r) => r.text),
    );
    page = read.map((r, i) => ({ r, c: resolved[i] ?? NO_CITATIONS }));
    total = Number(n);
  }

  const md = (m: unknown) => (m ?? {}) as Record<string, unknown>;
  const actorIds = page.flatMap(({ r }) => {
    const m = md(r.metadata);
    return [
      typeof m.writtenBy === 'string' ? m.writtenBy : null,
      ...storedActs(m.corrections).map((a) => a.by),
      storedAct(m.retired)?.by ?? null,
    ];
  });
  const people = await peopleOf(actorIds);
  const actor = (id: string | null): MemoryActor | null => {
    if (!id) return null;
    const p = people.get(id);
    return p ? { id, name: p.name, agent: p.kind === 'agent' } : { id, name: id, agent: false };
  };
  const act = (a: StoredAct): MemoryAct => ({ by: actor(a.by), at: a.at, reason: a.reason });

  const rows = page.map(({ r, c }): MemoryEntry => {
    const m = md(r.metadata);
    const retired = storedAct(m.retired);
    return {
      id: r.id,
      source: r.source,
      sourceRef: r.sourceRef,
      text: r.text,
      writtenAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      writtenBy: actor(typeof m.writtenBy === 'string' ? m.writtenBy : null),
      verifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
      cites: c.cites,
      staleRefs: c.staleRefs,
      flagged:
        typeof m.staleSince === 'string'
          ? {
              since: m.staleSince,
              by: typeof m.supersededBy === 'string' ? m.supersededBy : null,
            }
          : null,
      corrections: storedActs(m.corrections).map(act),
      retired: retired ? act(retired) : null,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      archivedBy: r.archivedAt && !retired ? archivedByOf(m) : null,
    };
  });
  return { rows, total };
}

/** Why a row no person retired is archived: decay's rule, or an agent's outdated verdict. */
function archivedByOf(m: Record<string, unknown>): string | null {
  if (typeof m.archivedBy === 'string') return m.archivedBy;
  const feedback = Array.isArray(m.feedback) ? m.feedback : [];
  const last = feedback[feedback.length - 1] as Record<string, unknown> | undefined;
  if (last && last.verdict === 'outdated' && typeof last.evidence === 'string') {
    return `outdated: ${last.evidence}`;
  }
  return null;
}
