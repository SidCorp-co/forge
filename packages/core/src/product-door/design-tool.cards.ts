// `forge_design`'s capability cards (ISS-1251), declared on the tool in design-tool.ts and kept here
// only because that file is at its line budget.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { DESIGN_TOOL_ACTIONS } from '@forge/contracts/mcp-product';
import { DESIGN_EXAMPLE_DOCUMENT } from './design-describe.js';
import { MOCKUP_CARDS } from './design-tool.mockup-cards.js';

/** When a product role reaches for each design action (ISS-1251). */
export const CARDS = {
  design_list: {
    purpose: 'Lists every workflow design of a project with its status, revision and health.',
    situations: [
      {
        when: 'a person asks which flows the product is designed as, or which designs wait on approval',
        do: 'list them and name each by its title and status: draft, proposed, returned or approved',
      },
      {
        when: 'you are about to draw a flow and do not know whether the project already has a design of it',
        do: 'list first and revise the design that exists, rather than create a second one of the same flow',
      },
    ],
    practice: ['The list carries no document: read one design whole with design_get.'],
    example: { projectId: '<project uuid>', view: 'summary' },
    // forge, 2026-10-17..11-16: 12 of 13 calls refused (the log keeps no code); the input takes the
    // project's uuid, which projects.list answers, and refuses a slug or a name by its pattern
    redFlag: 'Naming the project by its slug or name instead of the uuid projects.list answers.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a project named by its slug: 12 of 13 design lists refused'],
  },
  design_get: {
    purpose: 'Reads one design as it stands, a draft included, and whom it waits on.',
    situations: [
      {
        when: 'a person asks what a flow does, or where its design stands',
        do: 'get it with view summary and say its status, `progress.waitingOn` and each issue building it',
      },
      {
        when: 'you are about to write the next revision of a design',
        do: 'get it with view full and keep its `revision`: design_revise writes the whole document on that revision',
      },
      {
        when: 'a design is long and you need only some of its steps',
        do: 'get it with view steps and stepFrom and stepTo, rather than the whole document',
      },
    ],
    practice: [
      'current is the working document, a draft’s included; revision names a proposed revision to read instead.',
      'A design has no forecast of its own: say when it is likely done from the issues building it.',
    ],
    example: { projectId: '<project uuid>', workflowId: '<workflow uuid>', view: 'full' },
    // forge, 2026-10-17..11-16: 7 of 7 calls refused (the log keeps no code); the input takes the
    // project's uuid, which projects.list answers, and refuses a slug or a name by its pattern
    redFlag: 'Reading a design by its flow’s name instead of its workflow id from design_list.',
    family: 'design',
    audience: ['person'],
    scenarios: ['every design read refused: the input takes the project’s uuid'],
  },
  template_list: {
    purpose: 'Lists the templates a design may be drawn in, with their node types and edge kinds.',
    situations: [
      {
        when: 'you are about to draw a new design and must name the template it is drawn in',
        do: 'list the templates and pick by what the approver will ask: the business flow, the customer journey, the screens, or the states one thing moves through',
      },
      {
        when: 'a design write is refused for a node type or edge kind its template does not take',
        do: 'list the templates and draw each step and line with the types and kinds its template names',
      },
    ],
    practice: [
      'One flow, one template: a screen flow and the business flow it drives are two designs linked by refs.',
      'Guide workflow-templates says which template fits which question and what each type requires.',
    ],
    example: { projectId: '<project uuid>' },
    redFlag:
      'Drawing a design in a template without reading which node types and edge kinds it takes.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a design drawn in a template whose node types it broke: FB-622'],
  },
  design_create: {
    purpose: 'Writes a new workflow design at revision 1, as a draft.',
    situations: [
      {
        when: 'a requirement is about a flow, journey or state machine that no design of the project draws yet',
        do: 'pick its template with template_list, then create it with baseRevision null, before anyone builds it',
      },
      {
        when: 'the design you drew is what a requirement should rest on',
        do: 'link it with requirements.link_design once it exists, so the design has a requirement and can be observed',
        // FB-622: a PM's client drew and proposed a design it could not link, and it read unrooted
        watch:
          'a design no requirement links stays unrooted: it cannot be observed against the code',
      },
    ],
    practice: [
      'Send { baseRevision: null, document }: id, createdAt, updatedAt and writtenBy are the server’s.',
      'Write labels and purposes in the approver’s words, not the code’s: the canvas shows only what the design says.',
      'A new design is a draft: nothing waits on its approver until design_propose.',
    ],
    example: {
      projectId: '<project uuid>',
      body: { baseRevision: null, document: DESIGN_EXAMPLE_DOCUMENT },
    },
    // forge, 2026-10-17..11-16: 16 of 24 creates refused, nodes and edges a template does not
    // hold among them (WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE, WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE)
    redFlag:
      'Drawing nodes and edges the template does not hold, or leaving the design unlinked from its requirement.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a design drawn with nodes its template does not hold'],
  },
  design_revise: {
    purpose: 'Writes the next revision of a design, whole, on the revision you read.',
    situations: [
      {
        when: 'a design was returned with a reason, or a person asks for a change to a flow already drawn',
        do: 'read it with design_get view full, change what was asked, and write the whole document back with the revision you read as baseRevision',
      },
      {
        when: 'a draft you were asked to finish still lacks steps or lines',
        do: 'revise it as often as needed; a draft’s revision proposes nothing until design_propose',
      },
    ],
    practice: [
      'A write to a proposed, returned or approved design proposes the new revision itself: there is nothing to re-send.',
      'Name issue when the issue the last revision was drawn under is closed or dropped, or the write is refused.',
      'A document that changes nothing writes nothing; read ignored in the answer for what was dropped.',
    ],
    example: {
      projectId: '<project uuid>',
      workflowId: '<workflow uuid>',
      body: {
        baseRevision: 1,
        document: { ...DESIGN_EXAMPLE_DOCUMENT, summary: 'A past order becomes a cart.' },
      },
    },
    // forge, 2026-10-17..11-16: 45 of 63 revisions refused, a base revision moved past
    // (WORKFLOW_DESIGN_REVISION_STALE) among them
    redFlag:
      'Writing a revision on a stale baseRevision, or only the steps that change instead of the whole document.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a design revised on a stale base: WORKFLOW_DESIGN_REVISION_STALE'],
  },
  design_decide: {
    purpose: 'Approves or returns the proposed revision of a design.',
    situations: [
      {
        when: 'a person asks you to approve or return a design that waits on them',
        do: 'read it with design_get, then decide its newest revision, and on a return say what the next revision must change',
      },
      {
        when: 'a person approves with a condition, such as a revision still owed or a deviation accepted',
        do: 'approve with that condition as the reason: it is given to every build job with the approved revision',
      },
    ],
    practice: [
      'Decide only what the person asked; the project’s approvals gate says who may, and anyone else is refused by name.',
      'Approval is refused while a base the design rests on is not approved at the revision it names: approve the base first.',
    ],
    example: {
      projectId: '<project uuid>',
      workflowId: '<workflow uuid>',
      revision: 2,
      decision: 'return',
      reason: 'The reorder step must show what is out of stock before the cart fills.',
    },
    // FB-272: a throwaway design was returned to get rid of it, and the master was asked to revise it on every pass
    redFlag:
      'Returning a test or abandoned design to be rid of it: a return asks its writer to revise it on every pass. Withdraw it instead.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a throwaway design returned to be rid of it: FB-272'],
  },
  design_withdraw: {
    purpose: 'Takes back a design never approved; it leaves the list and Needs you.',
    situations: [
      {
        when: 'a design was a test, a mistake, or a flow nobody will build',
        do: 'withdraw it with a reason, so it stops waiting on anyone',
      },
    ],
    practice: ['An approved design, or one a live design rests on, is refused: revise it.'],
    example: {
      projectId: '<project uuid>',
      workflowId: '<workflow uuid>',
      reason: 'A test design; it describes no flow of the product.',
    },
    // forge: 2 of 3 withdrawals refused; an approved design is refused (DESIGN_WITHDRAW_APPROVED)
    redFlag: 'Withdrawing an approved design to retire it, where a revision changes it.',
    family: 'design',
    audience: ['person'],
    scenarios: ['an approved design withdrawn to retire it: DESIGN_WITHDRAW_APPROVED'],
  },
  suggestion_list: {
    purpose: 'Lists the suggestions on a requirement, issue, feedback item or design.',
    situations: [
      {
        when: 'a person asks what is proposed on a requirement or waits on their decision there',
        do: 'list it with status proposed and tell them each suggestion’s kind and rationale',
      },
      {
        when: 'you are about to accept a breakdown',
        do: 'list it with view full and read every slice: its criteria, the design it builds and where its accept would refuse',
      },
      {
        when: 'you are about to propose a change on a record',
        do: 'list what is already proposed there first: the same change twice is refused, and at most five wait on one target',
      },
    ],
    practice: ['Name exactly one target; view full reads each payload, summary leaves them out.'],
    example: { projectId: '<project uuid>', requirement: 'REQ-2', status: ['proposed'] },
    redFlag: 'Proposing a suggestion without listing those already waiting on the same record.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a re-proposal’s answer leaking into breakdown slices: FB-139'],
  },
  suggestion_create: {
    purpose: 'Proposes a change that waits on a decision instead of changing the record.',
    situations: [
      {
        when: 'two requirements or issues ask for the same thing',
        do: 'propose kind duplicate on the one that repeats, naming the one it repeats',
      },
      {
        when: 'you want a requirement, issue or design changed and the decision is someone else’s',
        do: 'propose it (revision_diff on a requirement, triage on an issue, design_change on a design) with why in rationale',
      },
      {
        when: 'a suggestion of yours was rejected and you propose again',
        do: 'change the payload, answer the rejection in rationale and name the rejected one in supersedes',
        // FB-139: a re-proposal's answer to its rejection went into breakdown slices and leaked into the filed issues
        watch:
          'an answer written in the payload, a breakdown slice’s description, is copied into what the accept writes',
      },
    ],
    practice: [
      'baseRevision is the target’s head you read; null on an issue, a feedback item or a requirement with no revision yet.',
      'A breakdown is the master’s to propose; a person’s client rarely writes one.',
    ],
    example: {
      projectId: '<project uuid>',
      body: {
        kind: 'duplicate',
        requirement: 'REQ-2',
        baseRevision: null,
        payload: { duplicateOf: 'REQ-1' },
        rationale: 'Both ask for reordering a past order.',
      },
    },
    // FB-152 and ISS-476: callers tried 0 and 1 for a revisionless target, and a model typed the base itself
    redFlag:
      'Guessing baseRevision: a number, 0 included, on a target with no revision is refused; send null there, and the revision you read elsewhere.',
    family: 'design',
    audience: ['person'],
    scenarios: ['baseRevision guessed as 0 on a target with no revision: FB-152'],
  },
  suggestion_accept: {
    purpose: 'Accepts a suggestion, which writes what it proposes in the same act.',
    situations: [
      {
        when: 'a person agrees with a suggestion waiting on them',
        do: 'accept it with their reason, which names the authority behind the act',
      },
      {
        when: 'a person accepts a breakdown',
        do: 'read every slice with suggestion_list view full first: the accept files each slice as an issue at draft',
        // FB-90: an owner accepted a breakdown from its slice titles and learned a slice's scope only from the filed issue
        watch: 'a slice judged by its title alone files work nobody agreed to',
      },
    ],
    practice: [
      'A target that moved since the suggestion was written is refused stale: read the head and propose against it.',
      'A breakdown with a gap in its checklist is refused naming it; the effect names each filed issue’s admission.',
    ],
    example: {
      projectId: '<project uuid>',
      suggestionId: '<suggestion uuid>',
      reason: 'Agreed with the owner on the requirement’s thread.',
    },
    // FB-411: the steward accepted its own feedback_triage on items the master had already triaged, voiding his decision
    redFlag:
      'Accepting a suggestion the record has already moved past, such as a triage on an item already triaged: it overwrites the decision taken since.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a breakdown accepted from its slice titles: FB-90'],
  },
  suggestion_reject: {
    purpose: 'Rejects a suggestion, saying why, so the next one on that record does not repeat it.',
    situations: [
      {
        when: 'a person says no to a suggestion waiting on them',
        do: 'reject it with their reason in their words: the reason is what the next proposal must answer',
      },
    ],
    practice: ['Where only one part is wrong, such as a breakdown slice, revise instead.'],
    example: {
      projectId: '<project uuid>',
      suggestionId: '<suggestion uuid>',
      reason: 'REQ-1 covers reordering already; this one is about saved carts.',
    },
    // forge: 6 of 28 rejections refused
    redFlag:
      'Rejecting with no reason the next proposal can answer, or rejecting where one slice needs revising.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a person saying no to a suggestion, rejected with their reason'],
  },
  suggestion_revise: {
    purpose: 'Replaces a suggestion with your edited payload; the original is closed.',
    situations: [
      {
        when: 'a suggestion is mostly right, such as a breakdown with one weak slice',
        do: 'revise it with the whole corrected payload and a reason naming what you changed',
      },
      {
        when: 'you produced a suggestion and want to change what it asks before it is decided',
        do: 'revise it yourself: the original is withdrawn, not rejected',
      },
    ],
    practice: [
      'The payload is whole, not a patch; one that changes nothing is refused.',
      'A reviewer’s revise is a decision and needs suggestions.approve.',
    ],
    example: {
      projectId: '<project uuid>',
      suggestionId: '<suggestion uuid>',
      payload: { duplicateOf: 'REQ-3' },
      reason: 'It repeats REQ-3, not REQ-1.',
    },
    redFlag:
      'Revising someone else’s suggestion without suggestions.approve, or sending a patch instead of the whole payload.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a breakdown with one weak slice revised whole, with a reason'],
  },
  suggestion_withdraw: {
    purpose: 'Retracts a suggestion you produced, before anyone decides it.',
    situations: [
      {
        when: 'a suggestion you made is wrong, or the record it targets changed so it no longer applies',
        do: 'withdraw it, so it stops waiting on a decision',
      },
    ],
    practice: ['Only its producer withdraws; anybody else rejects or revises it.'],
    example: { projectId: '<project uuid>', suggestionId: '<suggestion uuid>' },
    // forge: 10 of 21 withdrawals refused, 3 of them forbidden: only its producer withdraws
    redFlag: 'Withdrawing a suggestion you did not produce, where rejecting it is the act.',
    family: 'design',
    audience: ['person'],
    scenarios: ['a suggestion withdrawn by someone else: forbidden'],
  },
  ...MOCKUP_CARDS,
  // design_propose's one card is its REST twin's, the orientation's (`mcp/twins.ts`)
} satisfies Record<
  Exclude<(typeof DESIGN_TOOL_ACTIONS)[number], 'design_propose'>,
  CapabilityCardBody
>;
