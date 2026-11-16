// The capability card of the steward note write a master calls over REST (ISS-1251), beside its route
// (`routes.ts`), keyed by the door as the published contract lists it and built into the door catalog
// by `mcp/rest-cards.ts`. The steward's own notes are written by the gateway's code from the standing
// (`steward/door-writes.ts:NOTE`); this card teaches the override a steward act's undo points at
// (`steward/undo-rules.ts`). Written from the stale note a judge found on REQ-43 (ISS-496) and the
// refusals the vet gives (`vet.ts:vetNote`).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const STEWARD_NOTE_REST_CARDS = {
  'PUT /api/projects/:id/steward-notes/:subjectKind/:key': {
    purpose: 'Replaces the two-line note an open item shows on where it stands and what is next.',
    situations: [
      {
        when: 'an open item’s steward note states something the item no longer shows, and no undo reverses it',
        do: 'write the note yourself: two lines, the claims and basis copied from the item’s standing, `runId: null`',
      },
    ],
    practice: [
      'The vet checks the note against the standing: a moved basis is refused STEWARD_NOTE_STALE; read it again and resend.',
      'Cite the record the standing waits on, and say stuck only where the standing reads stuck.',
      'A closed item, or one waiting at awaiting_release, holds no open standing and is refused.',
    ],
    example: {
      lines: [
        'Waits on the release approval for 1.31.1.',
        'Next: the release holder approves it, due 18 November.',
      ],
      cites: [{ kind: 'release', ref: '1.31.1' }],
      claims: {
        group: 'release',
        waitingKind: 'person',
        ref: '1.31.1',
        stuck: false,
        stuckCode: null,
        dueAt: '2026-11-18T00:00:00Z',
      },
      basis: 'waiting|person|release.approve|1.31.1',
      runId: null,
    },
    family: 'knowledge',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;
