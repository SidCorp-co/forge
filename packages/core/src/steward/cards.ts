// The capability card of the steward door a steward job calls over REST itself (ISS-1251), beside its
// route (`routes.ts`), keyed by the door as the published contract lists it and built into the door
// catalog by `mcp/rest-cards.ts`. The decision door is posted by the gateway's own code
// (`door-decide.ts`), never by the model, so it carries no card. Written from the steward jobs that
// ended failed on forge's issues and from the job's brief (`job.ts:jobDoneStep`).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const CHANGED = { on: '2026-11-16', by: 'ISS-1251' } as const;

export const STEWARD_REST_CARDS = {
  'POST /api/projects/:id/steward-runs/:runId/done': {
    purpose: 'Ends a steward job, naming each write that never landed.',
    situations: [
      {
        when: 'your steward job’s acts are over, whatever happened in them',
        do: 'call it once as your last act, with `refused: []` and `broken: []` where every write landed',
      },
      {
        when: 'a door refused a write (a 4xx) and resending it right never landed it',
        do: 'name it in `refused` as `METHOD path: CODE detail`; a 5xx a door could not answer goes in `broken`',
      },
    ],
    practice: [
      'Any entry in `refused` marks the run failed: list only writes that never landed.',
      'The job’s token ends with this call, so a second call cannot correct the first.',
      'Without it the box reads the finished job as failed a quarter hour later.',
    ],
    example: {
      refused: [
        'POST /api/issues/ISS-1240/verdicts: VERDICT_JUDGED_BY_REVIEW criterion 2 is judged by review',
      ],
    },
    // memory steward-done-refused-list (ISS-575 follow-through, ISS-738): refusals already
    // corrected by a resend were listed, and the run closed failed though every write landed
    redFlag:
      'Listing a refusal you already fixed by resending, or a probe you expected to be refused: the run closes failed.',
    audience: ['run'],
    changed: CHANGED,
  },
} satisfies Record<string, CapabilityCardBody>;
