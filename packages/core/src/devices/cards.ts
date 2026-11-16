// The capability cards of the device doors a master reaches through forge-runner verbs on its box
// (ISS-1251), beside their routes (`pool-routes.ts`, `run-session-routes.ts`), keyed by the door as
// the published contract lists it and built into the door catalog by `mcp/rest-cards.ts`. The box's
// own heartbeat, pool and session doors are its daemon's, called by no model, and carry no card.
// Written from the verbs' own accounts (`forge-runner question`, `run declare`, ISS-1210, ISS-1245).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const PROJECT = 'd1bb4907-74d9-4228-85ff-76121523af7d';

export const DEVICE_REST_CARDS = {
  'POST /api/devices/me/questions': {
    purpose: 'Asks a person a question from the box, with the options and the one you recommend.',
    situations: [
      {
        when: 'you need a person’s decision that no issue carries',
        do: 'ask with `forge-runner question ask`, its options and your recommended one',
      },
    ],
    practice: [
      'The verb fails loudly: a refused ask is never reported as asked.',
      'A question carried by an issue is its park instead (issues/<id>/transition, needs_info).',
    ],
    example: {
      id: 'q-reorder-prices',
      projectId: PROJECT,
      prompt: 'Does a reorder keep the original prices?',
      answerShape: 'choice',
      options: [
        {
          id: 'today',
          label: 'Today’s prices',
          authority: 'writer',
          bindsTo: 'project',
          executedBy: 'agent',
        },
        {
          id: 'original',
          label: 'Original prices',
          authority: 'writer',
          bindsTo: 'project',
          executedBy: 'agent',
        },
      ],
      recommendedOptionId: 'today',
    },
    // ISS-1210: no verb asked, so masters believed a person was asked when nobody had been
    redFlag:
      'Telling the owner in a pane or a comment and treating that as asked: only this records the ask.',
    family: 'issue-order',
    audience: ['master'],
  },
  'POST /api/devices/me/run-sessions': {
    purpose: 'Declares a run a master starts in its own tree, so its slot and lease are held.',
    situations: [
      {
        when: 'you start a builder or judge run on this box',
        do: 'declare it with `forge-runner run declare`, its issues and its role, then brief it',
      },
    ],
    practice: ['Only an upgraded runner binds the declared run; an old one never does.'],
    example: {
      runId: 'b0f3c2a1-5d4e-4f6a-8b7c-9d0e1f2a3b4c',
      projectId: PROJECT,
      name: 'iss1251-cards',
      issueKeys: ['ISS-1251'],
    },
    // memory direct-mode-run-declare: a run not declared on an old runner had its tree reaped
    redFlag: 'Starting a builder without declaring its run: its tree and lease are nobody’s.',
    family: 'issue-work',
    audience: ['master'],
  },
  'POST /api/devices/me/run-sessions/:sessionId/close': {
    purpose: 'Says a declared run is finished or never started, releasing its slot.',
    situations: [
      {
        when: 'a run you declared has reported, or will not start',
        do: 'close it with `forge-runner run close`, saying how it ended',
      },
    ],
    practice: ['A judge run’s reads end at its close.'],
    example: {
      outcome: 'ended',
      detail: 'The builder reported its commits; the master folds them.',
    },
    // workspace-hygiene: a run left open holds its slot, its lease and its tree
    redFlag: 'Leaving a finished run open, so its slot and its tree stay held.',
    family: 'issue-work',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;
