// The capability cards of the memory doors a master and a run call over REST (ISS-1251), beside their
// routes (`write-routes.ts`), keyed by the door as the published contract lists it and built into the
// door catalog by `mcp/rest-cards.ts`. Writing a memory and recalling one carry the orientation's
// cards (`prompt/facts/affordance-cards.ts`). Written from the memory-and-knowledge guide, the
// curated-memory rule and the hand curation recorded on forge's issues.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const PROJECT = '6f1c2a0e-5b7d-4c1e-9a3f-2d8e4b6c7a10';
const MEMORY_A = '3d9e1f42-7a6b-4c2d-8e1f-5a7b9c0d2e14';
const MEMORY_B = '8b2c4d6e-1f3a-4b5c-9d7e-2a4c6e8f0b13';

export const MEMORY_REST_CARDS = {
  'POST /api/memory/feedback': {
    purpose: 'Says whether a recalled memory still holds once you checked it against live code.',
    situations: [
      {
        when: 'a memory hit you recalled still matches the code and git you just read',
        do: 'report it `confirmed` with its `source` and `sourceRef`, so decay leaves it standing',
      },
      {
        when: 'the code or a later decision disproves a memory you recalled',
        do: 'report it `outdated` with `evidence` naming what disproved it, which retires it at once',
      },
    ],
    practice: [
      'An `outdated` report without `evidence` is refused MEMORY_EVIDENCE_REQUIRED.',
      'A check you made and never reported leaves the memory unverified for the next reader.',
      'A pointer to no memory answers 404 found: false; an already retired one changes nothing.',
    ],
    example: {
      projectId: PROJECT,
      source: 'note',
      sourceRef: 'deploy-dev-route',
      verdict: 'outdated',
      evidence: 'deploy-dev.yml now waits on /api/version sourceCommit; the note says it does not.',
    },
    audience: ['master', 'run'],
  },
  'POST /api/memory/verify': {
    purpose: 'Stamps one or many memories, by id, as checked and still true now.',
    situations: [
      {
        when: 'you went through the memories that read needs-checking and found them still true',
        do: 'verify them in one call, naming the project in `?projectId` and each memory id in `ids`',
      },
    ],
    practice: [
      'Takes ids, up to 200; one unknown id refuses the whole call MEMORY_NOT_FOUND and stamps none.',
      'Holding `project.write` is enough: a run’s or a master’s token may verify, not only a person.',
    ],
    example: { ids: [MEMORY_A, MEMORY_B] },
    audience: ['master', 'run'],
  },
  'POST /api/memory/retire': {
    purpose: 'Retires many memories in one call under one reason, or deletes them for good.',
    situations: [
      {
        when: 'a curation pass finds memories that are wrong, duplicated or no longer worth keeping',
        do: 'retire them in one call with `?projectId`, every id in `ids` and one `reason`',
      },
      {
        when: 'a memory should not be kept even as a retired record',
        do: 'send `delete: true` with the same call, which removes the rows instead of archiving them',
      },
    ],
    practice: [
      'Up to 100 ids; each is answered retired or refused by name, so read the answer per id.',
      'Before retiring a duplicate, fold what it adds into the entry you keep (curated-memory rule).',
    ],
    example: {
      ids: [MEMORY_A, MEMORY_B],
      reason: 'Superseded by the forge-dev-push-route note; both described the old push route.',
    },
    // ISS-1104: 55 memories were retired one call each against the per-user write limit on
    // 2026-11-07, which is why this door takes a list
    redFlag:
      'Retiring a sweep one memory per call: the memory write limit runs out before the sweep does.',
    audience: ['master', 'run'],
  },
} satisfies Record<string, CapabilityCardBody>;
