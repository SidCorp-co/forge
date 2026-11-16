// The capability cards of the project archive doors the forge CLI reaches (ISS-1251), beside their
// routes (`routes.ts`), keyed by the door as the published contract lists it and built into the door
// catalog by `mcp/rest-cards.ts`. Written from the CLI's declared routes and the org.admin they take.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const PROJECT_REST_CARDS = {
  'POST /api/projects/:id/archive': {
    purpose: 'Archives a project the organization no longer works, as an org admin.',
    situations: [
      { when: 'a person retires a project', do: 'archive it; its records stay readable' },
    ],
    practice: ['It takes org.admin; unarchive brings it back whole.'],
    example: {},
    // the door's org.admin floor: an agent's credential is refused it
    redFlag: 'An agent archiving a project to quiet its board: archiving is an owner’s decision.',
    audience: ['person'],
  },
  'POST /api/projects/:id/unarchive': {
    purpose: 'Brings an archived project back, as an org admin.',
    situations: [{ when: 'a person resumes work on an archived project', do: 'unarchive it' }],
    practice: ['It takes org.admin.'],
    example: {},
    redFlag: 'An agent unarchiving a project to file work on it without the owner’s word.',
    audience: ['person'],
  },
} satisfies Record<string, CapabilityCardBody>;
