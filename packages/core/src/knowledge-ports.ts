// What knowledge reaches but does not own, composed at the root (ADR 0008): recall through the find
// door and a find of one project's records filtered to the types a caller names (ISS-1256), memory's
// search as the door's memory filter, memory's re-check of what a rewritten rule names (REQ-89 BC-5,
// ISS-1121), and the re-embedding of the requirements and feedback items whose vectors knowledge keeps.

import { embedFeedback } from './feedback/index.js';
import { memoryThroughFind, recallThroughFind, runFind } from './find/index.js';
import { provideKnowledgePorts } from './knowledge/index.js';
import { moduleBySlug } from './labels/index.js';
import { flagMemoriesForChange, provideMemoryFindPort } from './memory/index.js';
import { embedRequirementHead } from './requirements/index.js';

export function provideKnowledgeDomainPorts(): void {
  provideKnowledgePorts({
    recall: recallThroughFind,
    // the door's own fused order, filtered: a group of the shaped answer would reorder it by type
    find: async ({ projectId, reader, query, types, limit, askedBy }) => {
      const { fused } = await runFind({
        projectId,
        projectIds: [projectId],
        query: { q: query, type: [...types], limit },
        reader,
        askedBy,
      });
      return fused
        .filter((c) => types.includes(c.type))
        .slice(0, limit)
        .map(({ type, ref, key, title, text }) => ({ type, ref, key, title, text }));
    },
    flagMemoryRecheck: (projectId, change) => flagMemoriesForChange(projectId, change),
    reembedRequirement: embedRequirementHead,
    reembedFeedback: embedFeedback,
    moduleIdOf: async (projectId, slug) => (await moduleBySlug(projectId, slug)).id,
  });
  provideMemoryFindPort({ memoryThroughFind });
}
