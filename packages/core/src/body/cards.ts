// The capability card of the body preview door (ISS-1251), beside its route (`routes.ts`), keyed by
// the door as the published contract lists it and built into the door catalog by
// `mcp/rest-cards.ts`. Written from its one agent call on forge (2026-10-31, refused).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const BODY_REST_CARDS = {
  'POST /api/body/preview': {
    purpose: 'Renders a text as a stored body would show it, writing nothing.',
    situations: [
      {
        when: 'an editor shows a person how their markdown or html will read before they save it',
        do: 'send the raw text and its format; it answers the rendered body',
      },
    ],
    practice: ['It reads and writes no row: the save is the write door’s own.'],
    example: { raw: '**Reorder** keeps the original prices.', format: 'markdown' },
    // forge: the one agent call was refused; a body written through its door is screened there
    redFlag:
      'An agent previewing a comment here before posting, where the write door answers the same.',
    audience: ['person'],
  },
} satisfies Record<string, CapabilityCardBody>;
