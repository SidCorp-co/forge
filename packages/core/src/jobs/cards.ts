// The capability card of the job cancel door (ISS-1251), beside its route (`lifecycle-routes.ts`),
// keyed by the door as the published contract lists it and built into the door catalog by
// `mcp/rest-cards.ts`. Written from its use on forge between 2026-10-17 and 2026-11-16.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const JOB_REST_CARDS = {
  'POST /api/jobs/:id/cancel': {
    purpose: 'Cancels a queued or running job of the project, with the reason.',
    situations: [
      {
        when: 'a job was started on the wrong issue or input, or its work is no longer wanted',
        do: 'cancel it with the reason; the box stops its session',
      },
    ],
    practice: ['A job that finished is not undone by this: its records stand.'],
    example: { reason: 'Started on ISS-640 by mistake; ISS-641 was meant.' },
    // forge: its one call in the window landed (a master's onboarding job, 2026-11-01)
    redFlag:
      'Cancelling a slow job that is still making progress, instead of reading its events first.',
    family: 'issue-work',
    audience: ['master'],
    scenarios: ['a master’s onboarding job cancelled with the reason, 2026-11-01'],
  },
} satisfies Record<string, CapabilityCardBody>;
