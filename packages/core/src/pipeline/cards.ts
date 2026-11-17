// The capability cards of the pipeline doors a drive run writes its journal through (ISS-1251),
// beside their routes (`phase-routes.ts`, `step-handoff-routes.ts`), keyed by the door as the
// published contract lists it and built into the door catalog by `mcp/rest-cards.ts`. Written from
// the drive rules that teach them (`prompt/facts/drive-rules.ts`).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const PIPELINE_REST_CARDS = {
  'POST /api/pipeline-runs/:id/phases': {
    purpose: 'Declares the phase a drive run is entering in its run’s phase journal.',
    situations: [
      {
        when: 'your drive run moves into a new phase of its step',
        do: 'declare it on the running pipeline run of your issue',
      },
    ],
    practice: ['Find the run at projects/<id>/pipeline-runs?issueId=<id>&status=running.'],
    example: { phase: 'build' },
    // the journal is how a stuck run is read: a phase never declared reads as no work done
    redFlag: 'Working through a phase without declaring it, so the journal reads the run idle.',
    family: 'issue-work',
    audience: ['run'],
    scenarios: ['a drive run’s phase declared on its running pipeline run'],
  },
  'POST /api/pipeline-runs/:id/phases/end': {
    purpose: 'Ends a declared phase with its outcome and a note.',
    situations: [
      {
        when: 'a phase you declared is over, whatever came of it',
        do: 'end it with ok, failed or abandoned',
      },
    ],
    practice: ['Name the attempt the declare answered.'],
    example: {
      phase: 'build',
      attempt: 1,
      outcome: 'ok',
      note: 'Typecheck and direct tests green.',
    },
    redFlag: 'Ending a failed phase as ok to move on.',
    family: 'issue-work',
    audience: ['run'],
    scenarios: ['a failed phase ended as failed, never ok'],
  },
  'POST /api/issue-step-contexts': {
    purpose:
      'Writes a step’s handoff for the steps after it: what it found, decided and left open.',
    situations: [
      {
        when: 'your step of a drive run is ending and a later step builds on what it learned',
        do: 'write your step’s handoff in its step’s payload shape; read the prior steps’ first',
      },
    ],
    practice: ['The prompt carries only a pointer: the next step reads this, not your session.'],
    example: {
      projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
      issueId: '6f1c2a0e-5b7d-4c1e-9a3f-2d8e4b6c7a10',
      pipelineRunId: '2a9d7c3b-8e1f-4a6b-9c5d-0e2f4a6b8c1d',
      step: 'plan',
      payload: {
        step: 'plan',
        schema_version: 1,
        planSummary: 'Clear the order cache on reorder; add the direct test.',
        affectedFiles: ['src/orders/cache.ts'],
        acceptanceChecklist: ['A reorder right after checkout lists this order.'],
        unknowns: [],
      },
    },
    // the drive rules: a step that leaves no handoff makes the next one read the issue cold
    redFlag:
      'Ending a step with its findings only in your session, where no later step reads them.',
    family: 'issue-work',
    audience: ['run'],
    scenarios: ['a drive step’s handoff refused BAD_REQUEST on forge'],
  },
} satisfies Record<string, CapabilityCardBody>;
