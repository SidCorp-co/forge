// The capability card of the requirement assistant door (ISS-1251), beside its route
// (`ba-door-routes.ts`), keyed by the door as the published contract lists it and built into the
// door catalog by `mcp/rest-cards.ts`. Written from its one agent call on forge (2026-10-21, refused).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const ASSISTANT_REST_CARDS = {
  'POST /api/projects/:id/requirements/:req/assistant': {
    purpose:
      'Opens a person’s conversation with the BA about one requirement, or the one already open.',
    situations: [
      {
        when: 'a person wants to work a requirement through with the BA',
        do: 'open its room; an open one is answered again (reused)',
      },
    ],
    practice: ['A master works a requirement through its own doors, not a BA room.'],
    example: {},
    // forge: the one agent call was refused
    redFlag: 'An agent opening a BA room for itself to work a requirement it can revise directly.',
    family: 'product.requirement',
    audience: ['person'],
    scenarios: ['a BA room opened by an agent for itself'],
  },
} satisfies Record<string, CapabilityCardBody>;
