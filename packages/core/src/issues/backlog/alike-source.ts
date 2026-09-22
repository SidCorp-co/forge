/**
 * Every open issue's semantic neighbours, one seed at a time (ISS-1173).
 *
 * The scoring does not move: each seed goes through `runMemorySearch` with the same query text,
 * `topK`, `sourceFilter` and `surface` the REST route passes today, so the cosine measure, the
 * stale demotion, the usage bump and the analytics row are the ones already there. What moves is
 * the loop — the CLI spends one HTTP call per seed, this spends none.
 *
 * Titles are embedded in batches through `embedBatch` and handed to `runMemorySearch` as
 * `queryVec`, a parameter it already carries so a caller holding a vector does not pay to make it
 * twice. The vector is the one it would have computed itself, so the scores are identical.
 */

import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { type IssueStatus, issues } from '../../db/schema.js';
import { embedBatch } from '../../embeddings/index.js';
import { runMemorySearch } from '../../memory/search-service.js';
import { issueRefFormatter } from '../issue-prefix-read.js';
import type { Cancellation } from './cancellation.js';
import type { BacklogSource, SourceDone } from './emitter.js';

/** Seeds embedded per provider round trip. `embedBatch` sends whatever it is given in one request. */
export const EMBED_BATCH_SIZE = 64;

/** The CLI truncates a seed to this before searching; the same bound keeps the query text identical. */
export const SEED_QUERY_MAX = 4_000;

export interface AlikeInput {
  projectId: string;
  statuses: IssueStatus[];
  topK: number;
  cancellation: Cancellation;
}

type Cursor = { createdAt: Date; id: string } | null;

function matching(projectId: string, statuses: IssueStatus[]) {
  return and(eq(issues.projectId, projectId), inArray(issues.status, statuses));
}

export async function countSeeds(projectId: string, statuses: IssueStatus[]): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .where(matching(projectId, statuses));
  return row?.n ?? 0;
}

async function readSeeds(input: AlikeInput, after: Cursor) {
  const keyset = after
    ? and(
        matching(input.projectId, input.statuses),
        or(
          gt(issues.createdAt, after.createdAt),
          and(eq(issues.createdAt, after.createdAt), gt(issues.id, after.id)),
        ),
      )
    : matching(input.projectId, input.statuses);
  return db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(keyset)
    .orderBy(asc(issues.createdAt), asc(issues.id))
    .limit(EMBED_BATCH_SIZE);
}

async function neighboursOf(
  input: AlikeInput,
  seed: { title: string },
  queryVec: number[],
): Promise<Array<Record<string, unknown>>> {
  const result = await runMemorySearch({
    projectId: input.projectId,
    query: seed.title.slice(0, SEED_QUERY_MAX),
    topK: input.topK,
    sourceFilter: ['issue'],
    strategy: 'semantic',
    surface: 'web',
    queryVec,
  });
  return result.hits.map((hit) => ({
    memoryId: hit.id,
    sourceRef: hit.sourceRef,
    score: hit.score,
    stale: hit.stale,
  }));
}

/**
 * Yields one item per seed. Cancellation is checked before the page read, before the embedding
 * batch and before each search — not only at the page boundary, so a client that disconnects
 * during a page's first search does not buy the rest of that page.
 */
export async function* alikeSource(input: AlikeInput): BacklogSource<unknown> {
  if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
  const displayIdOf = await issueRefFormatter(input.projectId);
  let cursor: Cursor = null;

  for (;;) {
    if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
    const seeds = await readSeeds(input, cursor);
    if (seeds.length === 0) return { exhausted: true } satisfies SourceDone;

    if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
    const vectors = await embedBatch(seeds.map((s) => s.title.slice(0, SEED_QUERY_MAX)));

    for (const [index, seed] of seeds.entries()) {
      if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
      const queryVec = vectors[index];
      if (!queryVec) continue;
      yield {
        issueId: seed.id,
        displayId: displayIdOf(seed.issSeq),
        title: seed.title,
        hits: await neighboursOf(input, seed, queryVec),
      };
    }

    const last = seeds[seeds.length - 1];
    if (!last) return { exhausted: true } satisfies SourceDone;
    if (seeds.length < EMBED_BATCH_SIZE) return { exhausted: true } satisfies SourceDone;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
}
