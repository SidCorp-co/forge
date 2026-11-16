// The capability card of the preview door (ISS-1251), beside its route (`routes.ts`), keyed by the
// door as the published contract lists it and built into the door catalog by `mcp/rest-cards.ts`.
// Written from its one agent call on forge (2026-10-21) and its subjects (`subjects.ts`).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const PREVIEW_REST_CARDS = {
  'POST /api/projects/:id/previews': {
    purpose:
      'Opens a preview: an idea built from a brief, or a reported bug reproduced on a build.',
    situations: [
      {
        when: 'a person wants to try an idea for a requirement or feedback item before it is built',
        do: 'open an idea preview about it with the brief',
      },
      {
        when: 'a reported bug should be reproduced on a release or commit',
        do: 'open a reproduce preview on the feedback item naming the build',
      },
    ],
    practice: ['An idea needs project.write, a reproduce project.read.'],
    example: { kind: 'reproduce', feedback: 'FB-212', build: { release: '1.31.1' } },
    // forge: its one call in the window landed, a master probing it
    redFlag:
      'Opening a preview to test your own change, where a judge run on the deployed build is the act.',
    family: 'product.requirement',
    audience: ['person'],
  },
} satisfies Record<string, CapabilityCardBody>;
