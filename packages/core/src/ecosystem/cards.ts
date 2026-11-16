// The capability cards of the ecosystem doors a consumer's master calls over REST with no
// forge_ecosystem twin (ISS-1251), beside their routes (`project-routes.ts`,
// `contract/waits-routes.ts`), keyed by the door as the published contract lists it and built into the
// door catalog by `mcp/rest-cards.ts`. The interface, link-write, builder-run and contract-version acts are
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
  'POST /api/issues/:id/contract-waits/:waitId/retract': {
    purpose: 'Ends an issue’s wait on a contract version that it no longer needs, saying why.',
    situations: [
      {
        when: 'an issue waits on a contract version but was rebuilt without it, or the wait was wrong',
        do: 'retract that wait with the reason, so the issue is admitted again',
      },
    ],
    practice: ['A wait the version’s approval settles needs no retract.'],
    example: { reason: 'Reorder now reads the lines from 2.3.0; it needs nothing 2.4.0 adds.' },
    audience: ['master'],
    changed: CHANGED,
  },
  'DELETE /api/projects/:id/links/:link': {
    purpose:
      'Retires a link to a provider’s contract once this project calls nothing of it any more.',
    situations: [
      {
        when: 'the consumer deleted every call site of a contract',
        do: 'PUT the link with state building and callSites [] first, then delete it',
        watch: 'a link still naming a call site is refused LINK_RETIRE_WITH_CALL_SITES',
      },
    ],
    practice: [
      'Take the link out of an open builder run’s links too, or its next write is BUILDER_RUN_LINK_UNKNOWN.',
    ],
    example: {},
    // ISS-790: with no retire door a consumer left a dead link at `unverified` with a note
    redFlag:
      'Leaving a link whose call sites are gone as unverified, so it reads as a live dependency.',
    audience: ['master'],
    changed: CHANGED,
  },
} satisfies Record<string, CapabilityCardBody>;
