// forge_requirements' capability cards (ISS-1251), apart from the tool only for its length. Written
// from how product clients used the door: the drafts and revisions of ISS-538, ISS-829 and ISS-766,
// the duplicate draft of ISS-117, the stuck draft of ISS-733, and the design a person could not link
// or trace from MCP (FB-622, FB-219). progress, unlink_design and answer carry no card: nothing
// records a use of them (the no-use list of ISS-1251 names what each could become).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { ACTIONS } from './requirements-tool.js';

/** When a person's client reaches for the requirement door, from how product roles used it. */
export const CARDS = {
  list: {
    purpose:
      'Lists a project’s requirements with their state, whom each waits on and how delivery goes.',
    situations: [
      {
        when: 'a person asks what the product is meant to do, or which requirements wait on someone',
        do: 'list them, with state when they name one, and tell each one’s `waitingOn` and `progress.says`',
      },
      {
        when: 'a person names a requirement in their own words rather than by its key',
        do: 'list and match it by title, or call similar with their words, and confirm the key with them',
      },
    ],
    practice: [
      'Repeat `progress.says`, never a date the block does not hold.',
      'For how the project stands overall, project.status reads it in one call.',
    ],
    example: { projectId: '<project uuid>', state: 'agreed' },
    audience: ['person'],
  },
  get: {
    purpose:
      'Reads one requirement whole: its latest revision and criteria, questions, designs, issues and progress.',
    situations: [
      {
        when: 'you are about to revise a requirement',
        do: 'get it first and keep currentRevision as baseRevision and revision.criteria as the list you edit',
      },
      {
        when: 'a person asks what a requirement says, what it waits on, or how its delivery goes',
        do: 'get it and answer from its criteria, its open questions and `progress.says`',
      },
    ],
    practice: [
      'openRevision names a draft or proposed revision already open; a new revision waits on it.',
      'Name it by its key, REQ-12; a project holding no such key answers NOT_FOUND.',
    ],
    example: { projectId: '<project uuid>', requirement: 'REQ-12' },
    audience: ['person'],
  },
  similar: {
    purpose: 'Finds the requirements nearest a wish, so a wish already covered is revised there.',
    situations: [
      {
        when: 'a person wants new or changed behaviour and you are about to draft a requirement for it',
        do: 'call similar with their wish and revise the requirement that already covers it instead of drafting',
      },
      {
        when: 'you file feedback and need the requirement it touches as its target',
        do: 'call similar with the report’s words and name the hit as the target, REQ-n',
      },
    ],
    practice: [
      'provider_not_configured or withheld_by_policy does not mean none is similar: read the list.',
      'A hit can be a dropped requirement, which takes no revision: get it before revising.',
    ],
    example: { projectId: '<project uuid>', text: 'customers reorder a past order in one tap' },
    audience: ['person'],
  },
  create: {
    purpose: 'Drafts a new requirement at revision 1, with its criteria and why it is wanted.',
    situations: [
      {
        when: 'a person wants new behaviour no requirement covers (similar found none)',
        do: 'create it in their words with its criteria; leave out each code',
      },
      {
        when: 'the person has not said why they want it',
        do: 'create it without a reason: its author is asked why',
      },
    ],
    practice: ['A criterion is a sentence a judge finds true or false on the running product.'],
    example: {
      title: 'Reorder a past order',
      criteria: [{ body: 'An order’s page offers Reorder.' }],
    },
    // ISS-117: REQ-14 was drafted as a duplicate of REQ-11, which already covered it
    redFlag: 'Drafting a second requirement for a wish one already covers: revise that one.',
    audience: ['person'],
  },
  revise: {
    purpose:
      'Writes a new draft revision of a requirement: its criteria, its title or its spec changed.',
    situations: [
      {
        when: 'a person wants an agreed or drafted requirement to say something different, its title included',
        do: 'get it, then revise with baseRevision as its currentRevision and the WHOLE criteria list, changed where meant',
      },
      {
        when: 'the requirement already holds a draft revision you or its author wrote',
        do: 'rewrite that draft whole by sending revision: n in place of baseRevision',
      },
      {
        when: 'its open revision is proposed and must change',
        do: 'tell the person: its approver returns it to a draft first, which this door does not do',
        // ISS-766: a proposed revision met REQUIREMENT_REVISION_OPEN on a new one and NOT_DRAFT on an edit
        watch:
          'a new revision is refused REQUIREMENT_REVISION_OPEN and an edit REQUIREMENT_REVISION_NOT_DRAFT while it stays proposed',
      },
    ],
    practice: [
      'Build the list from get’s revision.criteria: each criterion that stays keeps its code, a new one has none.',
      'REQUIREMENT_REVISION_STALE means the head moved: get it again and rebuild the list.',
    ],
    example: {
      projectId: '<project uuid>',
      requirement: 'REQ-12',
      baseRevision: 1,
      criteria: [
        {
          code: 'BC-1',
          body: 'A past order’s page offers Reorder, which fills the cart with its items.',
        },
      ],
    },
    // REQ-75, 2026-11-01: a revision sent only the reworded BC-12, which would have retired the other
    // 37 criteria; ISS-855, ISS-856 and ISS-865 then briefed "send the whole criteria list"
    redFlag:
      'Sending only the criterion that changed: the list is the whole new set, so every code left out is retired.',
    audience: ['person'],
  },
  propose: {
    purpose: 'Puts a draft revision before the people who agree it.',
    situations: [
      {
        when: 'a draft revision says what the person wants and is ready to be agreed',
        do: 'get it, check its criteria against what was meant, then propose that revision',
      },
    ],
    practice: [
      'A code the head held that the draft lacks is retired once accepted: check before proposing.',
      'Accepting and agreeing are not done here: the master’s outside a strict project, a person’s on its page in one.',
    ],
    example: { projectId: '<project uuid>', requirement: 'REQ-12', revision: 2 },
    audience: ['person'],
  },
  withdraw: {
    purpose: 'Withdraws an open draft revision for good, saying why.',
    situations: [
      {
        when: 'a draft revision is no longer wanted, or blocks a new one with REQUIREMENT_REVISION_OPEN',
        do: 'withdraw it with the reason, then write the revision that is wanted',
      },
      {
        when: 'a dropped requirement still holds a draft revision',
        do: 'withdraw it: it is the one act a dropped requirement still takes',
      },
    ],
    practice: [
      'Its author may withdraw it; anyone else needs requirements.approve.',
      'A proposed revision is returned to a draft by its approver before it can be withdrawn.',
    ],
    example: {
      projectId: '<project uuid>',
      requirement: 'REQ-12',
      revision: 2,
      reason: 'Written against the wrong requirement.',
    },
    audience: ['person'],
  },
  link_design: {
    purpose: 'Links an existing workflow design to a requirement, so its next agree pins it.',
    situations: [
      {
        when: 'a design was drawn after its requirement was drafted, and reads no requirement',
        do: 'link it by its flow name, then trace each criterion onto its steps with trace_criterion',
      },
    ],
    practice: [
      'The next agree pins the design’s approved revision; a withdrawn design is refused.',
      'Link before you trace: a trace onto an unlinked design is refused REQUIREMENT_DESIGN_UNLINKED.',
    ],
    example: { projectId: '<project uuid>', requirement: 'REQ-12', workflow: 'reorder' },
    audience: ['person'],
  },
  trace_criterion: {
    purpose: 'Traces one business criterion onto the steps and edges of a linked design.',
    situations: [
      {
        when: 'a design’s approval is refused asking which business criteria each step serves',
        do: 'trace each criterion of the requirement linking it onto the steps that serve it',
      },
      {
        when: 'a criterion was reworded or a design changed its steps',
        do: 'trace that criterion again with its whole list of steps and edges',
      },
    ],
    practice: [
      'Each call writes the criterion’s WHOLE trace onto that design; empty lists clear it.',
      'Steps are the step ids of the design’s latest revision; an unknown one is refused by name.',
    ],
    example: {
      projectId: '<project uuid>',
      requirement: 'REQ-12',
      code: 'BC-1',
      workflow: 'reorder',
      steps: ['fill-cart'],
    },
    audience: ['person'],
  },
} satisfies Partial<Record<(typeof ACTIONS)[number], CapabilityCardBody>>;
