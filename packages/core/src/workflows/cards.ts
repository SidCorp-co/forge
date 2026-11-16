// The capability cards of the workflow doors a master and an observer run call over REST
// (ISS-1251), beside their routes (`routes.ts`), keyed by the door as the published contract lists
// it and built into the door catalog by `mcp/rest-cards.ts`. Drafting, revising, proposing and
// deciding a design are forge_design's, so their REST twins carry no second card. Written from the
// workflow-design guide, the master skill and the design runs on forge's issues.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const WORKFLOW_REST_CARDS = {
  'POST /api/projects/:id/workflows/:workflow/builds': {
    purpose:
      'Links an issue as one that builds a workflow design, so it waits on the design’s approval.',
    situations: [
      {
        when: 'you filed the issues that build a design',
        do: 'link each, naming the steps it builds; until the design is approved they are not admissible',
      },
    ],
    practice: [
      'The issue the design is drawn under is never its own build: link the build issues after it.',
    ],
    example: { issue: 'ISS-612', steps: ['reorder'] },
    family: 'design',
    audience: ['master', 'run'],
  },
  'POST /api/projects/:id/workflows/:workflow/observations': {
    purpose:
      'Records what the code at a landed commit actually does, step by step, beside the approved design.',
    situations: [
      {
        when: 'a design’s build landed and you read what the code holds against its approved revision',
        do: 'write an observation at that commit, each step matching a planned one (or none), citing file and symbol',
      },
      {
        when: 'the code drifted from the approved design',
        do: 'record the drift with its steps and reason in the observation; the design and its approval stay untouched',
      },
    ],
    practice: [
      'Cite { kind: repo, file, symbol }, never a line number; the commit must be on the landing branch.',
    ],
    example: {
      atSha: 'c82e7d7c3a339c5035efea3bcbb8b6f45c9510ee',
      steps: [
        {
          id: 'reorder',
          matches: 'reorder',
          does: 'Fills the cart with the past order’s lines.',
          after: [],
          evidence: { kind: 'repo', file: 'src/orders/reorder.ts', symbol: 'reorder' },
        },
      ],
      drift: {
        steps: ['reorder'],
        reason: 'The code fills the cart but skips the stock check the design draws.',
      },
    },
    // ISS-145: the drift check and the product-map refresh wrote what the code holds into the design
    // document itself, so plan and reading could not be told apart
    redFlag: 'Editing the design to match the code instead of recording what the code does.',
    family: 'design',
    audience: ['run', 'master'],
  },
  'POST /api/projects/:id/workflows/:workflow/design/repins': {
    purpose: 'Re-pins every design resting on an approved base to its new revision, in one act.',
    situations: [
      {
        when: 'a base design was approved at a new revision and its dependents only pin the old one',
        do: 'read GET …/design/repins, then post the plan whole: every pin-only dependent, bases first',
      },
    ],
    practice: [
      'A dependent with any other change pending is refused and goes through its own review.',
      'Name every design of a ring in one act.',
    ],
    example: {
      revision: 3,
      designs: [{ workflowId: '5c7e9a1b-3d5f-4a7b-8c9d-0e1f2a3b4c5d', revision: 2 }],
    },
    family: 'design',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;
