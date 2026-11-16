// What knowledge reaches but does not own, composed at the root (ADR 0008): recall through the find
// door (ISS-1256), memory's re-check of what a rewritten rule names (REQ-89 BC-5, ISS-1121), and the
// re-embedding of the requirements and feedback items whose vectors knowledge keeps.

import { embedFeedback } from './feedback/index.js';
import { recallThroughFind } from './find/index.js';
import { provideKnowledgePorts } from './knowledge/index.js';
import { moduleBySlug } from './labels/index.js';
import { flagMemoriesForChange } from './memory/index.js';
import { embedRequirementHead } from './requirements/index.js';

export function provideKnowledgeDomainPorts(): void {
  provideKnowledgePorts({
    recall: recallThroughFind,
    flagMemoryRecheck: (projectId, change) => flagMemoriesForChange(projectId, change),
    reembedRequirement: embedRequirementHead,
    reembedFeedback: embedFeedback,
    moduleIdOf: async (projectId, slug) => (await moduleBySlug(projectId, slug)).id,
  });
}
