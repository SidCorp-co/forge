// The capability card of the intake answer door (ISS-1251), beside its route (`routes.ts`), keyed by
// the door as the published contract lists it and built into the door catalog by
// `mcp/rest-cards.ts`. Written from the feedback and requirements guides that teach it and its
// calls on forge between 2026-10-17 and 2026-11-16.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const INTAKE_REST_CARDS = {
  'POST /api/projects/:id/intake-drafts/:ref/answers': {
    purpose: 'Answers a blocking question the intake assistant asked about a new item.',
    situations: [
      {
        when: 'the reporter of a new FB-n or REQ-n is asked a question before triage is proposed',
        do: 'answer the question by its number with the option chosen',
      },
    ],
    practice: ['A holder of the approve permission still decides the item.'],
    example: { question: 1, option: 'today' },
    // forge: 1 of the 2 answers refused, an option the question did not offer
    redFlag: 'An agent answering the reporter’s question for them.',
    family: 'product.ask',
    audience: ['person'],
    scenarios: ['a reporter’s question answered with an option it did not offer'],
  },
} satisfies Record<string, CapabilityCardBody>;
