/**
 * Every open issue's semantic neighbours, one seed at a time (ISS-1173).
 *
 * The scoring does not move: each seed goes through `runMemorySearch` with the same query text,
 * `topK`, `sourceFilter` and `surface` the REST route passes today, so the cosine measure, the
 * stale demotion, the usage bump and the analytics row are the ones already there. What moves is
 * the loop — the CLI spends one HTTP call per seed, this spends none. Titles are embedded in
 * batches and handed to `runMemorySearch` as `queryVec`, the vector it would have computed
 * itself, so the scores are identical. Seeds are paged keyset, exactly: see `page-read.ts`.
 */

import type { IssueStatus } from '../../db/schema.js';
import { issues } from '../../db/schema.js';
import { embedBatch } from '../../embeddings/index.js';
import { runMemorySearch } from '../../memory/search-service.js';
import { issueRefFormatter } from '../issue-prefix-read.js';
import type { Cancellation } from './cancellation.js';
import type { BacklogSource, SourceDone } from './emitter.js';
import { issuePage, type PageCursor } from './page-read.js';

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

async function readSeeds(input: AlikeInput, after: PageCursor | null) {
  return issuePage({
    columns: { id: issues.id, issSeq: issues.issSeq, title: issues.title },
    projectId: input.projectId,
    statuses: input.statuses,
    after,
    limit: EMBED_BATCH_SIZE,
  });
}

/** A sweep short of a vector would report itself complete over seeds it never searched. */
function shortBatch(wanted: number, got: number): Error {
  return Object.assign(
    new Error(
      `embeddings returned ${got} vector(s) for ${wanted} seed(s); refusing rather than sweeping ` +
        'past the seeds that have none and reporting the answer complete',
    ),
    { code: 'EMBEDDING_COUNT_MISMATCH' },
  );
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
 * batch and before each search, so a client that goes mid-page buys no more of that page.
 */
export async function* alikeSource(input: AlikeInput): BacklogSource<unknown> {
  if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
  const displayIdOf = await issueRefFormatter(input.projectId);
  let cursor: PageCursor | null = null;

  for (;;) {
    if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
    const seeds = await readSeeds(input, cursor);
    if (seeds.length === 0) return { exhausted: true } satisfies SourceDone;

    if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
    const vectors = await embedBatch(seeds.map((s) => s.title.slice(0, SEED_QUERY_MAX)));
    if (vectors.length !== seeds.length) throw shortBatch(seeds.length, vectors.length);

    for (const [index, seed] of seeds.entries()) {
      if (input.cancellation.cancelled) return { exhausted: false } satisfies SourceDone;
      const queryVec = vectors[index];
      if (!queryVec) throw shortBatch(seeds.length, index);
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
    cursor = { cursorAt: last.cursorAt, id: last.id };
  }
}
