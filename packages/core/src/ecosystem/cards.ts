// The capability cards of the ecosystem doors a consumer's master calls over REST with no
// forge_ecosystem twin (ISS-1251), beside their routes (`project-routes.ts`,
// `contract/waits-routes.ts`), keyed by the door as the published contract lists it and built into the
// door catalog by `mcp/rest-cards.ts`. The interface, link, builder-run and contract-version writes are
// forge_ecosystem's and forge_channel's (`tool.cards.ts`, `channel-tool.cards.ts`), so their REST
// twins carry no second card. Written from the ecosystem-inbox and suggestions guides and the
// adoptions and waits on forge's ecosystem issues (ISS-246, ISS-248, ISS-61).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const CHANGED = { on: '2026-11-16', by: 'ISS-1251' } as const;

export const ECOSYSTEM_REST_CARDS = {
  'POST /api/projects/:id/interface/adopt': {
    purpose:
      'Adopts a provider’s approved, non-breaking contract version in one act: interface and links.',
    situations: [
      {
        when: 'the bell says a provider approved a non-breaking version of a contract this project consumes',
        do: 'adopt it: one transaction writes the interface revision and moves every link’s pinned version',
      },
      {
        when: 'the adopt answer lists staleRequirements',
        do: 'have each re-pinned by whoever approves requirements: adopt never re-pins a baseline',
      },
    ],
    practice: [
      'A breaking version is not adopted here: it comes as a contract-change feedback with its own work.',
    ],
    example: { contract: 'catalog-api/orders', version: '2.4.0' },
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/issues/:id/contract-waits': {
    purpose:
      'Makes an issue wait on a contract version, so it is not admitted until that version is approved.',
    situations: [
      {
        when: 'an issue needs a version of a contract another project publishes, or this one will',
        do: 'write the wait on the contract and its minimum version, with the date it is worked to',
        watch: 'wait on the version, never on the provider’s issue',
      },
    ],
    practice: ['The approval of that version settles the wait and wakes the issue’s master.'],
    example: {
      contract: 'catalog-api/orders',
      minVersion: '2.4.0',
      reason: 'Reorder reads the order lines 2.4.0 adds.',
      dueAt: '2026-11-30T00:00:00+07:00',
    },
    audience: ['master', 'run'],
    changed: CHANGED,
  },
} satisfies Record<string, CapabilityCardBody>;
