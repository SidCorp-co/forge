// The capability cards of the requirement doors a project's master and its judge call over REST to
// move a requirement through agreement and delivery (ISS-1251), beside their routes (`routes.ts`,
// `issue-routes.ts`), keyed by the door as the published contract lists it and built into the door
// catalog by `mcp/rest-cards.ts`. Writing, revising, proposing, withdrawing and tracing are
// forge_requirements', so their REST twins carry no second card. Written from the
// requirement-lifecycle guide, the owner's rulings that a master agrees and moves requirements
// without parking on a person (2026-11-07), and the agrees, accepts and verdicts on forge's issues.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const CHANGED = { on: '2026-11-16', by: 'ISS-1251' } as const;
const RELEASE_SHA = 'c82e7d7c3a339c5035efea3bcbb8b6f45c9510ee';

export const REQUIREMENT_REST_CARDS = {
  'POST /api/projects/:id/requirements/:req/agree': {
    purpose:
      'Agrees a requirement’s current head, writing the baseline that pins its linked designs.',
    situations: [
      {
        when: 'a requirement waits on “agree” and its ready checklist is complete',
        do: 'agree it yourself with the revision and why; the kernel judges the checklist, not a person',
        watch: 'each gap is refused CHECKLIST_INCOMPLETE on /answers/<question>, naming it',
      },
      {
        when: 'the agree is refused for a gap',
        do: 'read GET …/checklist, fill the gap in a new revision, accept it and agree again',
      },
    ],
    practice: [
      'Outside strict the master holds the act; ask a person only where the project’s gate says so.',
    ],
    example: {
      revision: 2,
      reason: 'Ready checklist complete; REQ-12 r2 states the reorder rule.',
    },
    // owner 2026-11-07 on REQ-90, stuck at "You: agree r1": stop making me agree routine requirements
    redFlag: 'Parking a routine agree on the owner instead of agreeing it and recording why.',
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/projects/:id/requirements/:req/revisions/:n/accept': {
    purpose:
      'Accepts a proposed revision: it becomes current and, on an agreed requirement, re-baselines it.',
    situations: [
      {
        when: 'a proposed revision waits on its approver and its checklist holds',
        do: 'accept it with why and on whose authority; on an agreed requirement that is its new baseline',
      },
    ],
    practice: ['A blank reason is refused REQUIREMENT_SIGNOFF_REASON_REQUIRED.'],
    example: { reason: 'Adds BC-4 for sold-out lines, as FB-212’s triage asked.' },
    // ISS-645: accepts recorded no reason, so a revision went current with no why
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/projects/:id/requirements/:req/revisions/:n/return': {
    purpose: 'Sends a proposed revision back to draft, with what it must change.',
    situations: [
      {
        when: 'a proposed revision needs a change before it can be accepted, including your own',
        do: 'return it with the reason, then rewrite the draft and propose it again',
      },
    ],
    practice: ['A proposed revision cannot be edited or replaced; this is the way back to draft.'],
    example: { reason: 'BC-3 opens with “Verify”; restate it as what holds on the product.' },
    // ISS-766: an author stuck on a proposed revision was sent between two refusals, never to return
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/projects/:id/requirements/:req/repin': {
    purpose:
      'Re-baselines an agreed requirement on the same text, pinning a newly approved design or contract.',
    situations: [
      {
        when: 'a linked design was approved past what the baseline pins, or a linked contract moved',
        do: 're-pin it with the head revision and why; nothing re-pins by itself',
      },
    ],
    practice: ['Only an agreed requirement; nothing moved is refused REQUIREMENT_PINS_CURRENT.'],
    example: { revision: 2, reason: 'The reorder design r4 was approved on 2026-11-15.' },
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/projects/:id/requirements/:req/issues': {
    purpose:
      'Links an issue as one that delivers a requirement, from this project or a sibling one.',
    situations: [
      {
        when: 'you break an agreed requirement down into issues',
        do: 'link each issue that delivers it; a sibling project’s issue is named by its uuid',
        watch:
          'an issue serves one requirement: REQUIREMENT_ISSUE_LINKED_ELSEWHERE names the holder to unlink first',
      },
    ],
    practice: ['Outside strict a draft requirement links too; under strict only once agreed.'],
    example: { issue: 'ISS-640' },
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/projects/:id/requirements/:req/start-delivery': {
    purpose: 'Moves an agreed requirement to in delivery once a live issue builds it.',
    situations: [
      {
        when: 'the standing asks you to start delivery',
        do: 'move it; every refusal comes at once, each naming what clears it',
        watch:
          'REQUIREMENT_QUESTION_OPEN is cleared by answering that question; REQUIREMENT_UNCHECKED is the steward’s, not yours',
      },
    ],
    practice: ['Nothing moves on its own and no notice announces it.'],
    example: { reason: 'ISS-640 builds BC-1 to BC-3.' },
    // ISS-1084: a held start-delivery was asked again and again while its delivery check could not finish
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/projects/:id/requirements/:req/mark-delivered': {
    purpose: 'Moves a requirement in delivery to delivered once every live criterion passes.',
    situations: [
      {
        when: 'the standing reads every issue closed and every BC passing on the running build',
        do: 'mark it delivered; a BC with no pass is refused REQUIREMENT_CRITERIA_UNPROVEN, naming it',
      },
    ],
    practice: ['Agreed straight to delivered is no edge: start delivery first.'],
    example: { reason: 'BC-1 to BC-4 pass on 0.4.0-dev.690.' },
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/projects/:id/requirements/:req/accept': {
    purpose: 'Accepts a requirement’s delivery at its head, judged by the acceptance checklist.',
    situations: [
      {
        when: 'every live issue shipped and every current BC passes on the running build',
        do: 'accept it naming the head revision, with why',
      },
      {
        when: 'a gap is known and the owner or the project accepts it anyway',
        do: 'accept with byDecision true and a reason naming whose decision; each waived item is recorded',
      },
    ],
    practice: ['A correction after it comes in as feedback; a new revision accepted re-agrees it.'],
    example: { revision: 2, reason: 'All four BCs pass on 0.4.0-dev.690; ISS-640 shipped.' },
    redFlag: 'Accepting by decision to clear a gap nobody decided to leave.',
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/projects/:id/requirements/:req/verdicts': {
    purpose:
      'Judges one criterion on the running build at the requirement itself, with no issue behind it.',
    situations: [
      {
        when: 'a requirement was agreed over a capability that already shipped',
        do: 'judge each BC on the live build at the commit it serves, citing what you ran and saw',
      },
      {
        when: 'you judge as a run',
        do: 'declare it over the requirement (forge-runner run declare --requirement REQ-n --role qa) and send its run',
      },
    ],
    practice: [
      'The identity is the commit the live build serves, or the release where production names none.',
      'Read the answer’s coverage: a verdict counts only where the live build holds its commit.',
    ],
    example: {
      criterion: 'BC-2',
      verdict: 'pass',
      identity: { kind: 'commit', sha: RELEASE_SHA },
      evidence: ['GET /api/orders/1042/reorder answered 200 with the 3 in-stock lines'],
    },
    // REQ-45 r3 BC-8 (ISS-588): issues were filed whose only work was verifying a shipped capability
    redFlag: 'Filing an issue whose only work is verifying something that already shipped.',
    audience: ['run', 'master'],
    changed: CHANGED,
  },
} satisfies Record<string, CapabilityCardBody>;
