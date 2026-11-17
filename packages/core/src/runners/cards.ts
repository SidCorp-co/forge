// The capability card of the runner registration door (ISS-1251), beside its route, keyed by the
// door as the published contract lists it and built into the door catalog by `mcp/rest-cards.ts`.
// Written from its one agent call on forge (2026-10-22, forbidden).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const RUNNER_REST_CARDS = {
  'POST /api/runners': {
    purpose: 'Registers a runner on a paired box for a project, as a project admin.',
    situations: [
      {
        when: 'a person adds a box’s runner to a project',
        do: 'register it naming the device, the project and its labels',
      },
    ],
    practice: ['A box pairs first (forge-runner login); its runner is then registered here.'],
    example: {
      deviceId: '7c1e9b2a-4d3f-4e8a-9b6c-1a2b3c4d5e6f',
      projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
      name: 'box-1',
      type: 'claude-code',
    },
    // forge: the one agent call was forbidden: registering a runner is a person's act
    redFlag: 'An agent registering a runner for itself: a person adds a box’s runner.',
    family: 'setup',
    audience: ['person'],
    scenarios: ['an agent registering a runner for itself, forbidden'],
  },
} satisfies Record<string, CapabilityCardBody>;
