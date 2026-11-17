// The capability cards of the find door (ISS-1256), beside its routes (`routes.ts`), keyed by the
// door as the published contract lists it and built into the door catalog by `mcp/rest-cards.ts`.
// `forge_find` answers the same ranks over MCP. Written from the owner's ask of 2026-11-16 (what "run
// slots" are called, which no search could answer) and the module map's "search, then walk".

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const FIND_REST_CARDS = {
  'POST /api/projects/:id/find': {
    purpose:
      'Finds anything the project knows by its words: terms, rules, cards, requirements, issues and more.',
    situations: [
      {
        when: 'you are unsure where something lives or what a thing is called',
        do: 'find it before you read code with the words you have, then open the top hit',
      },
      {
        when: 'a person names a thing in their own words or in Vietnamese',
        do: 'find it first; a term carries its aliases, so their words reach it',
      },
      {
        when: 'a find answers `gap: true`, or you finish work in a module',
        do: 'write the term or rule that was missing, with its aliases and module; GET …/find/gaps lists the misses',
      },
    ],
    practice: [
      'Hits come grouped by type, each with its path (module › type); filter by `type`, `module`, `status`.',
      'Open a hit through its `open` path: that read is counted for the node it opens.',
      'Over MCP, `forge_find { query, projectId }` answers the same hits beside the matching actions.',
    ],
    example: { q: 'chia slot' },
    // owner 2026-11-16: asked what "run slots" are called; no glossary entry and 8 split searches
    redFlag:
      'Grepping the code for a word a person used before finding it: their word is an alias.',
    audience: ['master', 'run', 'bot'],
    scenarios: ['“run slots” searched eight ways with no glossary entry: owner 2026-11-16'],
    family: 'knowledge',
  },
} satisfies Record<string, CapabilityCardBody>;
