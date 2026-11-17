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
    scenarios: ['a requirement’s rule settled in an issue comment: ISS-739'],
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
    redFlag:
      'Recording a design’s wait on an issue’s events door, which answers 404, instead of on the design.',
    family: 'design',
    audience: ['master'],
    scenarios: ['a design’s wait sent to the issue events door, which answered 404: ISS-935'],
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
    // the steward asks again about an item whose wait nobody recorded; routing is the triage's act
    redFlag:
      'Routing or answering the item in a comment, where its triage or a reply to the reporter is the act.',
    family: 'project-feedback',
    audience: ['master'],
    scenarios: ['a feedback item routed in a comment instead of its triage'],
  },
  'PATCH /api/comments/:id': {
    purpose: 'Corrects a comment you wrote on an issue: its words, or what kind of comment it is.',
    situations: [
      {
        when: 'a comment you posted says something wrong or was filed as the wrong intent',
        do: 'edit its body, or send intent to turn it into one of the other two kinds',
      },
    ],
    practice: [
      'Send intent only to change it: the same intent again is refused COMMENT_INTENT_UNCHANGED.',
      'Another person’s comment is theirs; only a project admin edits it.',
    ],
    example: { body: 'Correction: the fix landed in ISS-640, not ISS-604.' },
    // forge, 2026-10-17..11-16: 7 of 19 edits refused, among them intents sent unchanged
    redFlag:
      'Rewriting a comment so its record says something else than it did, where a new comment should correct it.',
    family: 'issue-work',
    audience: ['master', 'run'],
    scenarios: ['a comment’s intent sent unchanged: COMMENT_INTENT_UNCHANGED'],
  },
  'DELETE /api/comments/:id': {
    purpose: 'Deletes a comment you posted on an issue by mistake.',
    situations: [
      {
        when: 'you posted a comment on the wrong issue, or twice',
        do: 'delete the stray one; repost it where it belongs',
      },
    ],
    practice: [
      'A decision is a record and is kept (COMMENT_RECORD_KEPT): supersede it with a new one.',
    ],
    example: {},
    // forge: 15 deletes in the window, each a master's own duplicate post; a decision is refused
    redFlag: 'Deleting a decision or another person’s comment to change what the record says.',
    family: 'issue-work',
    audience: ['master', 'run'],
    scenarios: ['a master’s own duplicate post deleted'],
  },
  'POST /api/comments/:commentId/attachments': {
    purpose: 'Attaches a file from disk to a comment, as one multipart upload.',
    situations: [
      {
        when: 'a comment needs its evidence beside it: a screenshot, a log, a report',
        do: 'post the comment first, then upload the file in the multipart `file` field to it',
      },
    ],
    practice: [
      'Upload from disk; never inline base64 bytes in a JSON request.',
      'Oversized files are refused FILE_TOO_LARGE before the body is read.',
    ],
    example: {},
    // the guides teach this route because agents inlined base64 screenshots in comment bodies
    redFlag: 'Pasting a file’s bytes as base64 into a comment body instead of uploading it here.',
    family: 'issue-work',
    audience: ['master', 'run'],
    scenarios: [
      'a screenshot inlined as base64 in a comment body, where the upload takes the file',
    ],
  },
  'PATCH /api/projects/:id/requirements/:req/comments/:comment': {
    purpose: 'Corrects a comment or decision you wrote on a requirement.',
    situations: [
      {
        when: 'a decision or note you recorded on a requirement is worded wrong or is the wrong kind',
        do: 'edit its body, or turn it into a decision with its fields',
      },
    ],
    practice: [
      'Turning it into a decision takes the decision’s fields: COMMENT_DECISION_REQUIRED without.',
    ],
    example: { body: 'REQ-104 waits for the owner’s word on pickup points.' },
    // the steward's one edit on forge in the window; a decision changed in substance is superseded
    redFlag:
      'Rewriting what a recorded decision decided instead of posting one that supersedes it.',
    family: 'requirements',
    audience: ['master'],
    scenarios: ['the steward’s note on a requirement turned into a decision'],
  },
} satisfies Record<string, CapabilityCardBody>;
