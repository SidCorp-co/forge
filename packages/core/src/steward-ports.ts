// The ports of the domains a steward act reaches through, filled once at boot by the process entry
// (ADR 0008): the steward calls each door through this app as the project's steward account and wakes
// a master over the socket (REQ-48 BC-12); a suggestion reads whether its project's steward is held;
// and a mockup's correction is read through the mockup's own view, never its table (REQ-50 BC-1).

import { provideLessonsPorts } from './lessons/index.js';
import { getMockupAs } from './mockups/index.js';
import { heldStewardOf, provideStewardPorts } from './steward/index.js';
import { provideSuggestionsPorts } from './suggestions/index.js';
import { wakeMastersForSteward } from './ws/index.js';

export function provideStewardDomainPorts(
  doorFetch: (request: Request) => Promise<Response>,
): void {
  provideStewardPorts({ doorFetch, wakeMasters: wakeMastersForSteward });
  provideSuggestionsPorts({ stewardOf: heldStewardOf });
  provideLessonsPorts({
    mockupOf: async (projectId, mockupId, viewer) =>
      (await getMockupAs(viewer, projectId, mockupId)) ?? null,
  });
}
