// Memory search as a filter of the find door (ISS-1256): `POST /api/memory/search` and `forge_memory
// search` answer the door's memory filter. The door is a read model memory may not import, so the
// composition root fills this at boot (`memory-ports.ts`).

import type { MemoryAuthoredSource, MemoryStanding } from '@forge/contracts/memory';
import { MEMORY_AUTHORED_SOURCES } from '@forge/contracts/memory';
import { z } from 'zod';
import type { ProjectReader } from '../lib/authz.js';
import { portSlot } from '../lib/port-slot.js';
import { retiredSearchStrategy } from '../lib/search-fusion.js';
import type { MemoryHit } from './search.js';

/**
 * A search request as `POST /api/memory/search` and `forge_memory search` take it. A mirror source is
 * refused by name: core's issue copies are the find door's issue type, and comment and job copies
 * are no type of it (they are read through their issue).
 */
export const memorySearchInputSchema = z.object({
  projectId: z.uuid(),
  query: z.string().trim().min(1).max(4000),
  topK: z.number().int().min(1).max(50).default(10),
  sourceFilter: z
    .array(
      z.enum(MEMORY_AUTHORED_SOURCES, {
        error:
          'memory search is the find door\'s memory filter: note, knowledge, policy or decision. Issues are POST /api/projects/:id/find with type ["issue"]; a comment or job copy is read through its issue',
      }),
    )
    .optional(),
  strategy: retiredSearchStrategy,
});

/** One search's answer: memory's hits in the find door's order, the score being the door's. */
export interface MemoryFindResult {
  hits: (MemoryHit & { standing: MemoryStanding })[];
  model: string;
  took_ms: number;
  degraded?: true;
  withheldForRecheck?: number;
  duplicatesFolded?: number;
}

const slot = portSlot<{
  /** `find/memory-filter.ts:memoryThroughFind`. */
  memoryThroughFind: (input: {
    projectId: string;
    query: string;
    topK?: number | undefined;
    sourceFilter?: readonly MemoryAuthoredSource[] | undefined;
    reader: ProjectReader;
  }) => Promise<MemoryFindResult>;
}>('memory find', 'provideMemoryFindPort');
export const provideMemoryFindPort = slot.provide;
export const memoryThroughFind = slot.port('memoryThroughFind');
