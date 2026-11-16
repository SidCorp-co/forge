// Memory search as a filter of the find door (ISS-1256): what `POST /api/memory/search` and
// `forge_memory search` answer is the door's memory filter (curated notes, policies, knowledge copies
// and decisions), in its order, cut to `topK`. Each hit is memory's own, its standing, curation and
// cites as memory's read made them; its `score` is the door's fused score: read the order, never the
// value. No strategy is taken, and core's issue copies are the door's issue type, never a memory hit.

import type { MemoryAuthoredSource } from '@forge/contracts/memory';
import type { ProjectReader } from '../lib/authz.js';
import { env } from '../lib/env.js';
import { clampTopK } from '../lib/search-fusion.js';
import type { MemoryFound } from './arms-memory.js';
import { MEMORY_FIND_TYPES } from './recall-filter.js';
import { runFind } from './service.js';

export interface MemoryFilterInput {
  projectId: string;
  query: string;
  topK?: number | undefined;
  /** The curated sources read; absent, all of them. */
  sourceFilter?: readonly MemoryAuthoredSource[] | undefined;
  /** Who reads: a hit's cite in a project they may not read is never read (REQ-30 BC-10). */
  reader: ProjectReader;
}

export interface MemoryFilterResult {
  hits: (MemoryFound & { score: number })[];
  model: string;
  took_ms: number;
  /** True when no embedding could be made, so only the keyword arm read. */
  degraded?: true;
  /** How many entries memory's reads withheld because a change took them out of service. */
  withheldForRecheck?: number;
  /** How many entries memory's reads folded into the entry answering their subject. */
  duplicatesFolded?: number;
}

/** The project's curated memory the find door keeps for `query`, best first. */
export async function memoryThroughFind(input: MemoryFilterInput): Promise<MemoryFilterResult> {
  const startedAt = Date.now();
  const { kept, memory, result } = await runFind({
    projectId: input.projectId,
    projectIds: [input.projectId],
    query: { q: input.query, type: [...MEMORY_FIND_TYPES], limit: clampTopK(input.topK) },
    reader: input.reader,
    askedBy: 'agent',
    filterOnly: true,
    ...(input.sourceFilter?.length ? { memorySources: input.sourceFilter } : {}),
  });
  const reads = memory ? [memory.keyword.result, memory.semantic?.result] : [];
  const most = (of: (r: NonNullable<(typeof reads)[number]>) => number | undefined) =>
    Math.max(0, ...reads.map((r) => (r ? (of(r) ?? 0) : 0)));
  const withheld = most((r) => r.withheldForRecheck);
  const folded = most((r) => r.duplicatesFolded);
  return {
    hits: kept.map((c) => ({ ...(c.native as MemoryFound), score: c.score })),
    model: env.EMBEDDINGS_MODEL,
    took_ms: Date.now() - startedAt,
    ...(result.degraded ? { degraded: true as const } : {}),
    ...(withheld > 0 ? { withheldForRecheck: withheld } : {}),
    ...(folded > 0 ? { duplicatesFolded: folded } : {}),
  };
}
