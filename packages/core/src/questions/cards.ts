// The capability cards of the question doors a run and a master call over REST (ISS-1251), beside
// their routes (`routes.ts`), keyed by the door as the published contract lists it and built into the
// door catalog by `mcp/rest-cards.ts`. Answering is the forge_questions door's (`questions.answer`),
// so its REST twin carries no second card. Written from the issue-flow and dispatch guides and from
// the asks, voids and refusals on forge's issues.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const CHANGED = { on: '2026-11-16', by: 'ISS-1251' } as const;

export const QUESTION_REST_CARDS = {
  'POST /api/questions': {
    purpose: 'Asks a person a choice an issue waits on, with options and the one you recommend.',
    situations: [
      {
        when: 'your issue cannot go on without a business rule or a contract shape only a person decides',
        do: 'ask it about the requirement, feedback item or contract it belongs to, then park the issue on it',
      },
      {
        when: 'a choice is yours or your master’s to take under the project’s gate profile',
        do: 'decide it and record the decision on the item, or ask the master with blockerKind master_or_peer',
        watch: 'a routine question to a person is refused QUESTION_AGENT_DECIDES',
      },
    ],
    practice: [
      'about is one object ({ requirement: null } for the issue’s own); a bare REQ-n is refused.',
      'Recommend one option and say why in plain words; the person answers by one click.',
    ],
    example: {
      issueId: '6f1c2a0e-5b7d-4c1e-9a3f-2d8e4b6c7a10',
      prompt: 'May a customer reorder an item that is out of stock?',
      options: [
        {
          id: 'skip',
          label: 'Reorder the rest',
          authority: 'writer',
          bindsTo: 'project',
          executedBy: 'agent',
        },
        {
          id: 'block',
          label: 'Refuse the reorder',
          authority: 'writer',
          bindsTo: 'project',
          executedBy: 'agent',
        },
      ],
      recommendedOptionId: 'skip',
      about: { requirement: null },
    },
    // ISS-583 / FB-149 and QUESTION_ABOUT_SHAPE: asks sent `about: "REQ-n"`; QUESTION_AGENT_DECIDES
    // (questions/owed.ts) answers asks of the owner for what the agent decides (decision-authority)
    redFlag:
      'Asking the owner a routine choice, or parking the issue on prose with no question behind it.',
    audience: ['run', 'master'],
    changed: CHANGED,
  },
  'POST /api/questions/:id/void': {
    purpose: 'Withdraws an open question that no longer needs an answer, saying why.',
    situations: [
      {
        when: 'a question you asked was settled another way, or its issue moved on without it',
        do: 'void it with the reason, so it leaves the person’s list',
      },
    ],
    practice: ['Void only your own or your project’s question; an answered one is history.'],
    example: { reason: 'Settled by REQ-12 r3, which the owner agreed on 2026-11-07.' },
    audience: ['master', 'run'],
    changed: CHANGED,
  },
  'PUT /api/questions/:id/plain': {
    purpose: 'Writes the plain summary a person reads before deciding an open question.',
    situations: [
      {
        when: 'an open question of your project reads "No summary" where its person decides',
        do: 'write at most three plain lines: what changes for the user, why now, what you recommend',
      },
    ],
    practice: [
      'In the project’s content language; name each choice by its outcome, never by an ISS-, REQ- or BC- key.',
    ],
    example: {
      plain:
        'Customers could reorder in one tap.\nIt waits on your choice for out-of-stock items.\nWe recommend reordering the rest.',
    },
    audience: ['master'],
    changed: CHANGED,
  },
} satisfies Record<string, CapabilityCardBody>;
