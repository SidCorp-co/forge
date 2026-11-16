// The capability cards of the item-comment doors a master and a run call over REST to record a
// decision on the requirement, design or feedback item it governs (ISS-1251), beside their routes
// (`entity-routes.ts`), keyed by the door as the published contract lists it and built into the door
// catalog by `mcp/rest-cards.ts`. An issue's comment is the orientation's card. Written from the
// decision-authority rule, the steward's decision doors (`masters/owed.ts:DECISION_DOOR`) and the
// dated decisions masters recorded on forge's requirements (ISS-739).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const DECISION_PRACTICE = [
  'A dated reversedWhen (2026-12-01) ends the decision on that date; any other text is a condition it holds under.',
  'Say the choice and why in plain words; the decision is read back by forge_decisions and the steward.',
];

export const COMMENT_REST_CARDS = {
  'POST /api/projects/:id/requirements/:req/comments': {
    purpose: 'Records a decision, question or note on the requirement it governs.',
    situations: [
      {
        when: 'you settled a choice that shapes a requirement (a rule, a scope cut, why it waits)',
        do: 'record it there with intent decision: what was decided and why',
      },
      {
        when: 'the steward asks you about a requirement that waits on a person or a date',
        do: 'record why it waits as a decision, reversedWhen the date it is looked at again',
      },
    ],
    practice: DECISION_PRACTICE,
    example: {
      intent: 'decision',
      decision: {
        decision: 'Out-of-stock lines are skipped on reorder, the rest go to the cart.',
        reason: 'A blocked reorder loses the whole cart; the owner agreed on 2026-11-07.',
      },
    },
    // ISS-739: masters answered the steward with dated decisions on REQ-36/65/67; decision-authority
    // asks each decision to live on the item it shapes
    redFlag:
      'Settling a requirement’s rule in an issue comment or the requirement’s prose, where no decision read finds it.',
    family: 'requirements',
    audience: ['master', 'run'],
  },
  'POST /api/projects/:id/workflows/:workflow/comments': {
    purpose: 'Records a decision, question or note on the workflow design it governs.',
    situations: [
      {
        when: 'a design waits on something and the steward asks about it',
        do: 'record why it waits as a decision on the design, not on an issue',
        watch: 'the issue events door answers 404 for a design',
      },
    ],
    practice: DECISION_PRACTICE,
    example: {
      intent: 'decision',
      decision: {
        decision: 'The reorder design waits for the stock contract 2.4.0.',
        reason: 'Its stock check step reads a field only 2.4.0 adds.',
        reversedWhen: '2026-11-30',
      },
    },
    // ISS-935: a workflow's wait was sent to the issue events door, which answered 404
    family: 'design',
    audience: ['master'],
  },
  'POST /api/projects/:id/feedback/:fb/comments': {
    purpose: 'Records a decision, question or note on the feedback item it governs.',
    situations: [
      {
        when: 'a feedback item waits on something that is not its triage (a person, a release, a date)',
        do: 'record why as a decision on the item, so the steward stops asking',
      },
    ],
    practice: [
      ...DECISION_PRACTICE,
      'Routing the item is its triage’s act, never a comment; the reporter reads a reply, not this.',
    ],
    example: {
      intent: 'decision',
      decision: {
        decision: 'FB-212 waits for the 1.31 release that carries its fix.',
        reason: 'The fix landed in ISS-640; the reporter can verify once it is live.',
        reversedWhen: '2026-11-25',
      },
    },
    family: 'project-feedback',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;
