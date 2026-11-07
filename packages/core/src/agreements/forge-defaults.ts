// Forge's working agreements (REQ-90 BC-13): the layer every project inherits, shipped in code so the
// page never ships empty and no deployment has to be seeded by hand. Each is a term as its name and
// one sentence as its default, the owner's own words of 2026-11-07 (REQ-90 r5 scopeIn, FB-569,
// FB-570); detail opens on demand. A change to a default is a new revision appended here, never an
// edit of an old one: a run's recorded `forge@<n>` must read back as what it was given, and a project
// override written over an older revision reads Conflict until an editor re-affirms or restores it.
//
// Two are locked core guarantees (`locked: true`): access and state honesty. No project changes them.

import type { AgreementLink } from '@forge/contracts/agreements';

export interface ForgeAgreementRevision {
  revision: number;
  rule: string;
  detail: string | null;
  /** ISO date the revision shipped. */
  at: string;
  reason: string;
}

export interface ForgeAgreement {
  slug: string;
  name: string;
  locked: boolean;
  /** Whose decision it is, and when. */
  source: string;
  /** The existing sources it restates: one instruction, not two. */
  restates: readonly AgreementLink[];
  /** Oldest first; the last is in force. */
  revisions: readonly ForgeAgreementRevision[];
}

const OWNER_2026_11_07 = "The owner's decision of 2026-11-07 (FB-569)";
const FIRST = {
  revision: 1,
  at: '2026-11-07',
  reason: 'Seeded with working agreements (REQ-90 BC-13).',
};

const rule = (ref: string, title: string): AgreementLink => ({ kind: 'rule', ref, title });
const req = (ref: string, title: string): AgreementLink => ({ kind: 'requirement', ref, title });

export const FORGE_AGREEMENTS: readonly ForgeAgreement[] = [
  {
    slug: 'outcome-driven-autonomy',
    name: 'Outcome-driven autonomy',
    locked: false,
    source: OWNER_2026_11_07,
    restates: [
      rule('decision-authority', 'Agents decide and execute; humans set policy'),
      req('REQ-79', 'Agents decide and implement by default (BC-11, BC-13, BC-18)'),
    ],
    revisions: [
      {
        ...FIRST,
        rule: 'An agent chooses how and completes the goal within its granted authority, calling a person only for a decision beyond it.',
        detail:
          'A decision beyond an agent is one that is irreversible, spends real money, touches credentials or sets product direction; it is asked once, in at most three plain lines, with a recommendation. Everything else the agent decides and records on the item it shapes: what was chosen, the options and why. A routine approval is a defect, not a safeguard.',
      },
    ],
  },
  {
    slug: 'proportional-verification',
    name: 'Proportional verification',
    locked: false,
    source: OWNER_2026_11_07,
    restates: [
      rule('batch-delivery', 'Per change, typecheck, lint and related tests only'),
      req('REQ-79', 'An issue lands on build, healthy deploy and scoped tests (BC-2, BC-16)'),
      req('REQ-76', 'Gate profiles and per-gate overrides'),
    ],
    revisions: [
      {
        ...FIRST,
        rule: "Verify in proportion to a change's impact, widening the checks only on evidence; never verify beyond what the scope needs.",
        detail:
          "Per change: typecheck, lint and the direct tests of what it touched. Check wide early only when a change touches shared logic, billing, permissions or data, or when a red names a gap. A project's gate profile and overrides say which gates hold; this agreement says how much proof each change owes.",
      },
    ],
  },
  {
    slug: 'batch-delivery',
    name: 'Batch delivery',
    locked: false,
    source: OWNER_2026_11_07,
    restates: [
      rule('batch-delivery', 'Work moves in batches, one gate per batch'),
      req('REQ-79', 'Fast delivery: issues ship app-alive'),
    ],
    revisions: [
      {
        ...FIRST,
        rule: 'Related work goes in batches of at least one whole issue, checked in scope before it moves on; the full suite and CI run after the push, per batch.',
        detail:
          'One issue is never split across releases. One batch is one worktree and one branch. A red the batch gate finds is fixed inside the batch; a red the full suite finds after the push is fixed forward in the next batch. Then one release and one live judge.',
      },
    ],
  },
  {
    slug: 'continuous-audit',
    name: 'Continuous audit',
    locked: false,
    source: OWNER_2026_11_07,
    restates: [
      rule('product-delivery-audit-loop', 'Product, Delivery, Release, Audit, and round again'),
      req('REQ-79', 'Cleanup runs apart, on its own capacity (BC-7, BC-20, BC-21)'),
    ],
    revisions: [
      {
        ...FIRST,
        rule: 'Audit on a schedule or on real signals; simplifying, normalising and independent refactors happen there, while what bounds or proves the current fix stays in that fix.',
        detail:
          'What a delivery batch leaves unclean is recorded as debt for the Audit, never chased inside the batch. The Audit reads what landed and what ran after a period of running: code defects, logic not simplified or reused, and the use of the product. Its outputs are items for the next Product round and lessons stored for retrieval.',
      },
    ],
  },
  {
    slug: 'progressive-disclosure',
    name: 'Progressive disclosure',
    locked: false,
    source: OWNER_2026_11_07,
    restates: [
      rule('ui-copy-rule', 'The least text that lets the person decide'),
      rule('prompt-is-a-map', 'The prompt is a map; detail is fetched when needed'),
      req('REQ-12', 'Progressive disclosure on every screen (BC-4)'),
    ],
    revisions: [
      {
        ...FIRST,
        rule: 'Show by default what the current task and decision need, open detail on demand, and keep what changes a decision or why something is blocked visible at once.',
        detail:
          'On a screen: a name, a status and the one next action; history, reasons, evidence and logs open on demand. In a prompt: always-on text stays a few short lines per rule, and detail, lessons and guides are fetched when the work needs them, as this agreement map is.',
      },
    ],
  },
  {
    slug: 'single-source-of-truth',
    name: 'Single source of truth',
    locked: false,
    source: OWNER_2026_11_07,
    restates: [rule('prompt-is-a-map', 'Rewrite every text that speaks to a changed direction')],
    revisions: [
      {
        ...FIRST,
        rule: 'Each decision has one authoritative source; a change updates it and what depends on it, and marks what is retired.',
        detail:
          'A working agreement is written once, into the place it governs: the gates for a gate profile, the project document for its content language, a ruling for who agrees to an act, the agreement itself otherwise. Never append a new rule beside an old one: rewrite or retire the old text in the same change.',
      },
    ],
  },
  {
    slug: 'evidence-backed-state',
    name: 'Evidence-backed state',
    locked: true,
    source: `${OWNER_2026_11_07}; VISION state-never-lies`,
    restates: [
      { kind: 'vision', ref: 'state-never-lies', title: 'State never lies' },
      rule('release-is-the-agents-record', "Whether code is live is the agent's confirmation"),
      { kind: 'kernel', ref: 'transition_evidence', title: 'No status move without its evidence' },
    ],
    revisions: [
      {
        ...FIRST,
        rule: 'State reflects its evidence and tells fixed, verified, released and confirmed on the target environment apart.',
        detail:
          'This is state honesty, a core guarantee no project overrides: the kernel refuses a status move without its evidence, an awaiting_release without a recorded merge and a close without every criterion met in scope or moved out on the record.',
      },
    ],
  },
  {
    slug: 'continuous-improvement',
    name: 'Continuous improvement',
    locked: false,
    source: OWNER_2026_11_07,
    restates: [
      rule('product-delivery-audit-loop', 'No stage is dropped and no stage is added'),
      rule('prompt-is-a-map', 'Fix the text an agent followed before adding a mechanism'),
    ],
    revisions: [
      {
        ...FIRST,
        rule: 'Audit gates, prompts and skills too, and remove steps that make work wait or repeat once agents can do it; no process heavier than the work needs.',
        detail:
          'When an agent works the wrong way, find which text it followed, quote it and fix that text before adding a refusal or a mechanism. A gate that makes work wait without catching anything is a candidate for removal in the Audit.',
      },
    ],
  },
  {
    slug: 'lean-testing',
    name: 'Lean testing',
    locked: false,
    source: "The owner's decision of 2026-11-07 (FB-570)",
    restates: [
      { kind: 'feedback', ref: 'FB-570', title: 'Lean testing as a working agreement' },
      req('REQ-79', 'Scoped tests at landing (BC-2)'),
    ],
    revisions: [
      {
        ...FIRST,
        rule: 'Add a test only where it proves behaviour that matters or stops a specific regression the existing tests miss; extend an existing test first, and audit duplicate, stale and implementation-bound tests on a schedule.',
        detail:
          'No test file by default for each change, helper or branch; table or parameterized cases for one behaviour; tests hold the behaviour callers rely on, not function names or file splits; the audit weighs protected behaviour against upkeep, never a file count or coverage alone, and never deletes in bulk by threshold. The agreement stops new accumulation; auditing the existing suite is separate Audit work that needs evidence first. It works with proportional verification and continuous audit, and adds no manual review gate per test.',
      },
    ],
  },
  {
    slug: 'access',
    name: 'Access',
    locked: true,
    source: 'REQ-90 scope: access stays a core guarantee',
    restates: [
      { kind: 'kernel', ref: 'pat_fence', title: 'A fenced token reaches only its own project' },
      { kind: 'kernel', ref: 'run_holder', title: 'Only the holding run moves an issue' },
    ],
    revisions: [
      {
        ...FIRST,
        rule: 'Who may read, write or act is decided by grants alone; no agreement widens what a person, agent or token may reach.',
        detail:
          'An agreement edit never grants a permission its editor does not hold, and an agreement cannot relax a permission, a token fence or a holder check. To change who may act, change the grant where it is made.',
      },
    ],
  },
];

/** The revision in force. */
export const currentRevision = (a: ForgeAgreement): ForgeAgreementRevision =>
  a.revisions[a.revisions.length - 1] as ForgeAgreementRevision;

export const forgeAgreementOf = (slug: string): ForgeAgreement | null =>
  FORGE_AGREEMENTS.find((a) => a.slug === slug) ?? null;
