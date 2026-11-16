// The capability card of the questionnaire answer door (ISS-1251), beside its route (`routes.ts`),
// keyed by the door as the published contract lists it and built into the door catalog by
// `mcp/rest-cards.ts`. Written from its refusals on forge between 2026-10-17 and 2026-11-16.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const QUESTIONNAIRE_REST_CARDS = {
  'POST /api/projects/:id/questionnaires/:bid/answers': {
    purpose: 'Answers a questionnaire a person was asked, item by item, or skips it.',
    situations: [
      {
        when: 'a person answers a questionnaire they were asked',
        do: 'send each item’s choice, choices, decision or text by its itemId',
      },
    ],
    practice: ['The submitter needs questionnaires.answer; an agent never answers for the person.'],
    example: { answers: [{ itemId: 'reorder-prices', choice: 'today' }] },
    // forge, 2026-10-17..11-16: all 5 answers refused, each sent by an agent credential for the
    // person it asked (questionnaires/rules.ts:submitterRefusal)
    redFlag: 'An agent answering a person’s questionnaire for them.',
    family: 'onboarding',
    audience: ['person'],
  },
} satisfies Record<string, CapabilityCardBody>;
