// The capability card of the skill delete door (ISS-1251), beside its route (`studio-routes.ts`),
// keyed by the door as the published contract lists it and built into the door catalog by
// `mcp/rest-cards.ts`. Written from its one call on forge (2026-11-03, not found).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const SKILL_REST_CARDS = {
  'DELETE /api/skills/:id': {
    purpose: 'Deletes a project’s own skill, as a project admin.',
    situations: [
      {
        when: 'a project skill is replaced or no longer used by any status',
        do: 'delete it by its id; a global skill is read-only (SKILL_GLOBAL_READ_ONLY)',
      },
    ],
    practice: ['Read the forge-skills prompt before changing a project’s pipeline skills.'],
    example: {},
    // forge: the one call named a skill this project holds none as
    redFlag: 'Deleting by a skill’s name or a global skill’s id: it takes the project skill’s id.',
    family: 'setup',
    audience: ['master'],
    scenarios: ['a skill deleted by a name this project holds none as'],
  },
} satisfies Record<string, CapabilityCardBody>;
