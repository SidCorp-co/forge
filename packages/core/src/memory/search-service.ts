import type { MemoryStanding } from '@forge/contracts/memory';
import type { MemorySource } from '../db/schema.js';
import { embedQuery } from '../integrations/llm/index.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { clampTopK } from '../lib/search-fusion.js';
import { noteWindowDays, standingOf } from './note-lifetime.js';
import { foldBySubject, sameSubjectPairs } from './one-per-subject.js';
import { keywordSearchMemories, type MemoryHit, searchMemories, touchMemories } from './search.js';
import { type CiteReader, resolveCitations } from './stale-refs.js';

/**
 * Read the memory store for a query: the find door's memory arm (`find/arms-memory.ts`) reads it by
 * keyword and by meaning, and the note gate reads it for the notes nearest a draft. No door answers it
 * directly: `POST /api/memory/search` and `forge_memory search` are the find door's memory filter
 * (ISS-1256, `find-port.ts`).
 *
 * Strategies (memory-v2 phase 1):
 *  - `semantic` (default) — cosine over embeddings. Scores are similarity
 *    (≈0..1); existing consumers threshold on these (knowledge dedup fact
 *    uses > 0.8).
 *  - `keyword`  — Postgres FTS. No embedding call; exact-identifier recall.
 * The find door fuses the two by rank itself (`find/rank.ts`).
 *
 * Does NOT check authorization on `projectId` — callers must verify project membership
 * before invoking this function. `reader` decides which other projects a hit's cites are read in.
 */

type MemorySearchStrategy = 'semantic' | 'keyword';

interface RunMemorySearchInput {
  projectId: string;
  query: string;
  topK?: number | undefined;
  sourceFilter?: MemorySource[] | undefined;
  strategy?: MemorySearchStrategy | undefined;
  /** Who the hits are read for: a cite in a project they may not read is never read (REQ-30 BC-10). */
  reader: CiteReader;
  /**
   * The query already embedded by the caller. The find door (`find/`) holds one because it
   * searches two stores from one query, and embedding it a second time here buys nothing but the
   * call. Absent, this function embeds the query itself as it always did.
   */
  queryVec?: number[] | undefined;
}

/**
 * A hit as a search answers it, with its standing (ISS-1063): `verified` when checked after its last
 * write and within the project's note window, `unverified` otherwise — a lead to check, never a fact.
 */
export type MemorySearchHit = MemoryHit & { standing: MemoryStanding };

interface MemorySearchResult {
  hits: MemorySearchHit[];
  model: string;
  took_ms: number;
  /** What the query's embedding took, over every attempt; absent when none was made here (a keyword search, or a vector the caller supplied). */
  embedMs?: number;
  strategy: MemorySearchStrategy;
  /** How many retrieved hits were moved below the fresh ones because they name a record that no longer resolves (`staleRefs`). Absent when none were. */
  demotedStale?: number;
  /**
   * How many retrieved entries were withheld because a change took them out of service (`staleSince`,
   * REQ-89 r3 BC-5): kept, readable at `GET /api/memory/entries` as `flagged`, served to no agent until
   * someone confirms, rewrites or retires them. Absent when none were.
   */
  withheldForRecheck?: number;
  /** How many retrieved entries were folded into the entry answering their subject (its `duplicates`). Absent when none were. */
  duplicatesFolded?: number;
}

/**
 * One hit per subject (REQ-89 BC-2, one-per-subject.ts). A failed read of which hits share a subject
 * leaves them as they were and says so in the log: the search still answers.
 */
async function onePerSubject(
  projectId: string,
  hits: MemoryHit[],
): Promise<{ hits: MemoryHit[]; folded: number }> {
  try {
    return foldBySubject(hits, await sameSubjectPairs(hits));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, projectId },
      'memory.search: reading which hits share a subject failed, hits are not folded',
    );
    return { hits, folded: 0 };
  }
}

/** Naming a record that no longer resolves: still served, below the fresh hits. */
const readsStale = (h: MemoryHit) => (h.staleRefs?.length ?? 0) > 0;

function demoteStale(hits: MemoryHit[]): { hits: MemoryHit[]; demoted: number } {
  const fresh = hits.filter((h) => !readsStale(h));
  if (fresh.length === hits.length) return { hits, demoted: 0 };
  const stale = hits.filter(readsStale);
  return { hits: [...fresh, ...stale], demoted: stale.length };
}

/**
 * An entry a change took out of service (`staleSince`: a landing met its re-check condition, a release
 * contradicted it, or its unobservable ending went unchecked) is withheld, never served (REQ-89 r3 BC-5).
 */
function withholdOutOfService(hits: MemoryHit[]): { hits: MemoryHit[]; withheld: number } {
  const served = hits.filter((h) => !h.stale);
  return { hits: served, withheld: hits.length - served.length };
}

/**
 * Each hit that names a record no longer resolving carries `staleRefs` (MJ-3). A failed resolution
 * leaves the hits as they were and says so in the log: the search still answers.
 */
async function withStaleRefs(
  projectId: string,
  hits: MemoryHit[],
  reader: CiteReader,
): Promise<MemoryHit[]> {
  if (hits.length === 0) return hits;
  try {
    const resolved = await resolveCitations(
      projectId,
      hits.map((h) => h.text),
      reader,
    );
    return hits.map((h, i) => {
      const c = resolved[i];
      if (!c) return h;
      return {
        ...h,
        ...(c.cites.length > 0 ? { cites: c.cites } : {}),
        ...(c.staleRefs.length > 0 ? { staleRefs: c.staleRefs } : {}),
      };
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, projectId },
      'memory.search: cited-record resolution failed, hits carry no staleRefs',
    );
    return hits;
  }
}

async function retrieve(
  input: RunMemorySearchInput,
  poolTopK: number,
): Promise<{ hits: MemoryHit[]; resolved: MemorySearchStrategy; embedMs?: number }> {
  const requested: MemorySearchStrategy = input.strategy ?? 'semantic';
  const base = {
    projectId: input.projectId,
    topK: poolTopK,
    sourceFilter: input.sourceFilter,
  };
  if (requested === 'keyword') {
    const hits = await keywordSearchMemories({ ...base, query: input.query });
    return { hits, resolved: requested };
  }
  const embedStarted = Date.now();
  const queryVec = input.queryVec ?? (await embedQuery({ surface: 'memory' }, input.query));
  return {
    hits: await searchMemories({ ...base, queryVec }),
    resolved: requested,
    ...(input.queryVec === undefined ? { embedMs: Date.now() - embedStarted } : {}),
  };
}

export async function runMemorySearch(input: RunMemorySearchInput): Promise<MemorySearchResult> {
  const startedAt = Date.now();
  const topK = clampTopK(input.topK);

  // a subject held twice takes one slot: the pool is wider than topK so the slot it frees is filled
  const retrieved = await retrieve(input, clampTopK(topK * 2));
  const subjects = await onePerSubject(input.projectId, retrieved.hits);
  // withheld before the cut to topK, so the slots it frees go to entries in service
  const service = withholdOutOfService(subjects.hits);
  let hits = service.hits.slice(0, topK);

  hits = await withStaleRefs(input.projectId, hits, input.reader);
  const demotion = demoteStale(hits);
  hits = demotion.hits;

  const windowDays = await noteWindowDays(input.projectId);
  const now = Date.now();
  const standing = hits.map((h) => ({ ...h, standing: standingOf(h, windowDays, now) }));

  const tookMs = Date.now() - startedAt;
  if (hits.length > 0) {
    const hitIds = hits.map((h) => h.id);
    queueMicrotask(() => {
      touchMemories(hitIds).catch((err) => {
        logger.warn(
          { err: (err as Error).message, projectId: input.projectId },
          'memory.search: usage tracking failed',
        );
      });
    });
  }

  return {
    hits: standing,
    model: env.EMBEDDINGS_MODEL,
    took_ms: tookMs,
    ...(retrieved.embedMs !== undefined ? { embedMs: retrieved.embedMs } : {}),
    strategy: retrieved.resolved,
    ...(demotion.demoted > 0 ? { demotedStale: demotion.demoted } : {}),
    ...(service.withheld > 0 ? { withheldForRecheck: service.withheld } : {}),
    ...(subjects.folded > 0 ? { duplicatesFolded: subjects.folded } : {}),
  };
}
