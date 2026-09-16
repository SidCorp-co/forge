/**
 * ISS-1064 — the gate's one dependency, bound to a project: the closest existing notes read through
 * the memory search the assistant itself uses. Kept apart from `memory-note-gate.ts` so the gate's
 * rules import nothing that needs a database, and from the doors so both bind it the same way.
 */

import { logger } from '../../logger.js';
import type { PreCall } from '../run-turn-core.js';
import { EXISTING_TOP_K, memoryNotePreCall } from './memory-note-gate.js';

export function memoryNoteGateFor(projectId: string): PreCall {
  return memoryNotePreCall({
    existingNotes: async (text) => {
      if (text.trim().length === 0) return [];
      // cm:why imported at the call and not at the top: `search-service` reaches the database and the validated env, and `run-turn.ts` is loaded by tests that hold neither; the gate's rules stay in the pure module either way
      const { runMemorySearch } = await import('../../memory/search-service.js');
      const found = await runMemorySearch({
        projectId,
        query: text,
        topK: EXISTING_TOP_K,
        sourceFilter: ['note'],
        strategy: 'semantic',
        surface: 'web',
      });
      return found.hits.map((h) => ({ text: h.text, score: h.score }));
    },
    onSearchError: (err) =>
      logger.warn(
        { projectId, err: err instanceof Error ? err.message : String(err) },
        'memory-note gate: existing-note search failed, judged without it',
      ),
  });
}
