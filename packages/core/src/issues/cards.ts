// The capability cards of the issue doors a run, a judge and a master call over REST (ISS-1251),
// beside the routes they teach (`merge-routes.ts`, `criteria/routes.ts`, `design-routes.ts`,
// `record-events/routes.ts`, `check-run-routes.ts`, `pattern-routes.ts`, `attachment-routes.ts`,
// `dependency-routes.ts`). Each is keyed by its door as the published contract lists it, and
// `mcp/rest-cards.ts` builds them into the door catalog. Written from how runs and masters used each
// door on forge's issues and from the refusals each door was given for the wrong use.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const SHA = 'c82e7d7c3a339c5035efea3bcbb8b6f45c9510ee';
/** One check as a run records it, the example of both the check and the merge-check doors. */
const TYPECHECK = {
  id: '7b0c6a52-3a1e-4c55-9d3f-2f4f8c1e9a10',
  kind: 'typecheck',
  name: 'pnpm tc:changed',
  scope: 'changed',
  command: 'pnpm tc:changed',
  files: [],
  result: 'pass',
  durationMs: 71000,
  startedAt: '2026-11-16T05:00:00Z',
};

export const ISSUE_REST_CARDS = {
  'DELETE /api/issues/:id/merge': {
    purpose: 'Clears an issue’s merge mark so it can be marked again at the right commit.',
    situations: [
      {
        when: 'a mark names the wrong commit, or a later round landed the issue again',
        do: 'clear the mark, then mark again with `commit` naming the landing that holds the work',
        watch: 'a merged issue that is closed takes merge/correction instead, never a clear',
      },
      {
        when: 'Forge tells you a mark it observed is not this work',
        do: 'clear it, so the next pass offers the merge as unheld work for its master to decide',
      },
    ],
    practice: [
      'The first stamp wins: a second mark changes nothing until the first is cleared.',
      'Mark again in the same breath, naming `commit`, or the release cannot place the issue.',
    ],
    example: {},
    // ISS-489 round 3 and memory remark-must-name-commit: a re-mark naming no commit left an
    // already-shipped issue in no release; MARK_ALREADY_STANDS is the refusal that asks for the clear
    redFlag:
      'Clearing a mark and re-marking with the commit only in `note`: the issue then sits in no release.',
    family: 'issue-landing',
    audience: ['master', 'run'],
  },
  'POST /api/issues/:id/verdicts': {
    purpose: 'Records one judged criterion, with the build it was judged on and what proves it.',
    situations: [
      {
        when: 'you have just judged one acceptance criterion on a build',
        do: 'post its verdict at once, naming the criterion by its number and the commit whole',
      },
      {
        when: 'a criterion the design classes observable passed or fell short',
        do: 'send the probe you ran with it, and a clip or `withoutClip` saying why none',
      },
      {
        when: 'you review a change you did not build and judge a code-property criterion',
        do: 'post it with `judge: "review"` and the reviewing run in `run`',
      },
    ],
    practice: [
      'evidence is a list of strings (an attachment name, a URL or a repo path), never one string.',
      'Your own pass on work you built is kept as evidence and never counts; a fail always counts.',
      'A resend of the same verdict answers duplicate: true, so it is safe after a lost answer.',
    ],
    example: {
      criterion: 2,
      verdict: 'pass',
      reason: 'The reorder button fills the cart with the order’s three items.',
      identity: { kind: 'commit', sha: SHA },
      evidence: ['reorder-c2.webm', 'reorder-c2.png'],
    },
    // ISS-766 brief and VERDICT_COMMIT_NOT_FULL / VERDICT_PROBE_REQUIRED: criteria named by uuid,
    // short shas and observable passes with no probe were each refused
    redFlag:
      'Holding verdicts to write at the end, or naming a short sha: a run that stops loses them, and a short sha is refused.',
    family: 'issue-work',
    audience: ['run', 'master'],
  },
  'POST /api/issues/:id/merge-check': {
    purpose: 'Records the merge check run on the change rebased onto its base, before it lands.',
    situations: [
      {
        when: 'a batch’s gate passed over the change rebased onto the latest base',
        do: 'post its report whole on each issue the batch lands, before you mark them',
      },
      {
        when: 'a mark is refused MERGE_CHECK_MISSING',
        do: 'run the merge check at the commit you mark and post its report, then mark again',
      },
    ],
    practice: [
      'Land the commit you checked: a rebase after the check is a new check.',
      'Send the report the script wrote, not a hand-made one; its checks are recorded with it.',
    ],
    example: {
      base: { branch: 'dev', sha: SHA },
      head: SHA,
      mode: 'pre-merge',
      touched: [{ path: 'packages/core/src/issues/cards.ts', change: 'added' }],
      checks: [TYPECHECK],
    },
    // MERGE_BEHIND_BASE: reports from a branch behind its base were refused; ISS-472 saw reports
    // posted before the shape they used was served
    redFlag: 'Rebasing again after the check and landing the new head on the old report.',
    family: 'issue-landing',
    audience: ['master', 'run'],
  },
  'PATCH /api/issues/:id': {
    purpose: 'Changes an issue’s own fields: its plan, notes, labels, criteria text or work step.',
    situations: [
      {
        when: 'you hold an issue and its work moves to the next step (design, build, test)',
        do: 'patch `workState.step`, which core reads to say where the work stands',
      },
      {
        when: 'you wrote the plan or the release notes of an issue you hold',
        do: 'patch `plan` or `releaseNotes`, and read the answer’s `warnings`',
      },
    ],
    practice: [
      'Read the answer’s warnings: a criteria list kept only in the description is named there.',
      'Status moves are transitions, never a patch.',
    ],
    example: { workState: { step: 'build' } },
    // FB-503: a lease patched in another shape was stored and only the next move refused it NO_HOLDER
    redFlag:
      'Patching a lease or a status by hand: the lease shape is the kernel’s, and a status moves only by transition.',
    family: 'issue-work',
    audience: ['master', 'run'],
  },
  'PUT /api/issues/:id/design': {
    purpose: 'Records how each criterion will be proven and which modules the change touches.',
    situations: [
      {
        when: 'the project’s design_record gate is on and you are about to build',
        do: 'put one line per criterion (class, pattern, proof) and the modules and contracts it alters',
      },
      {
        when: 'a move into build is refused DESIGN_RECORD_MISSING or DESIGN_RECORD_INCOMPLETE',
        do: 'read GET …/design `check`, then put the design with each gap it names filled',
      },
    ],
    practice: [
      'A module is one whose behaviour changes; a line in a shared registry or a face does not make its owner one.',
    ],
    example: {
      criteria: [
        {
          criterion: 1,
          class: 'observable',
          pattern: null,
          proof: 'probe: GET /api/orders/1 shows Reorder',
        },
      ],
      modules: ['orders'],
      contracts: [],
    },
    // ISSUE_SCOPE_HELD: designs naming registry owners as modules collided with every live run
    redFlag:
      'Naming every module whose registry line you touched, which collides with every live run (ISSUE_SCOPE_HELD).',
    family: 'issue-work',
    audience: ['run'],
  },
  'POST /api/issues/:id/events': {
    purpose: 'Records a run’s own typed record on the issue: a decision, a correction, a wave.',
    situations: [
      {
        when: 'you took a choice under an assumption, or a criterion was found wrong and rewritten',
        do: 'post a decision (with how to reverse it) or a correction record saying why',
      },
      {
        when: 'you dispatched a wave of issues as a master',
        do: 'post a wave record on its headline issue naming the members, the role and the pass',
      },
    ],
    practice: [
      'One record per fact, in the closed set of kinds; a comment names it in a sentence, never repeats it.',
    ],
    example: {
      kind: 'decision',
      contract: 1,
      fields: [
        { key: 'decision', value: 'Keep the old route one release' },
        { key: 'why', value: 'forge-plugin still calls it' },
      ],
    },
    // EVENT_KIND_KERNEL_ONLY and the record-in-comment rule: transitions, verdicts and fenced records
    // were posted as events or pasted into comments
    redFlag:
      'Posting a verdict, transition or park as an event, or pasting a record into a comment: each has its own store.',
    family: 'issue-work',
    audience: ['master', 'run'],
  },
  'PUT /api/issues/:id/criteria': {
    purpose: 'Writes an issue’s whole criteria list, each traced to its requirement’s BC.',
    situations: [
      {
        when: 'you take an issue whose criteria are only listed in its description',
        do: 'put them on the record before you build, each traced line led by `(REQ-n BC-m)`',
      },
      {
        when: 'an issue reached awaiting_release with no criterion ever on the record',
        do: 'put them once as the run holding it; a second late add is refused',
      },
    ],
    practice: [
      'Only an unchanged wording keeps its verdicts and trace; the answer names what was kept and voided.',
      'A traced line reworded without its tag is refused CRITERIA_TRACE_DROPPED: restate its tag.',
    ],
    example: {
      criteria: [{ n: 1, statement: '(REQ-12 BC-3) A past order’s page offers Reorder.' }],
    },
    // memory triage-issue-criteria-on-record and CRITERIA_TRACE_DROPPED: triage-filed issues carried
    // criteria only in prose, and rewrites dropped their traces
    redFlag: 'Leaving the criteria in the description: a verdict has nothing to attach to.',
    family: 'issue-work',
    audience: ['master', 'run'],
  },
  'POST /api/issues/:id/checks': {
    purpose: 'Records each check a run ran, with how long it took, on the issue.',
    situations: [
      {
        when: 'you ran the typecheck, tests or probes of a change',
        do: 'post them with the head they ran at and each one’s duration',
      },
    ],
    practice: [
      'A merge check’s report records its own checks, so do not send them twice.',
      'A check is kept once by its id: a resend adds nothing, and an id reused for another check is refused.',
    ],
    example: {
      head: SHA,
      checks: [TYPECHECK],
    },
    // forge, 2026-10-17..11-16: 170 of 485 posts refused, chiefly an id reused for another check
    // (CHECK_RUN_CONFLICT)
    redFlag:
      'Reusing one check id for a different check, or resending what a merge check already recorded.',
    family: 'issue-work',
    audience: ['run', 'master'],
  },
  'POST /api/issues/:id/review': {
    purpose: 'Records a review of a change by a run that did not build it, line by line.',
    situations: [
      {
        when: 'you are the reviewing run on a project that declares the merge check',
        do: 'read GET …/review for what it owes, then post each checklist line and code-property criterion',
      },
    ],
    practice: [
      'Rerun nothing: cite what is recorded at head. Name your run in `run` from a shared box credential.',
    ],
    example: {
      base: SHA,
      head: SHA,
      checklist: [{ pattern: 'core-module', line: 1, result: 'pass', note: 'faces only' }],
      criteria: [],
    },
    // REVIEW_BY_BUILDER / REVIEW_RUN_UNNAMED: the building run reviewed itself, or a box call named no run
    redFlag: 'Reviewing your own build, or sending checks and tests in the review body.',
    family: 'issue-work',
    audience: ['run'],
  },
  'PATCH /api/issues/:id/criteria/:ref': {
    purpose: 'Corrects one criterion’s wording at any status, keeping its verdicts and trace.',
    situations: [
      {
        when: 'a criterion’s words are wrong but what it promises is not, even after landing',
        do: 'patch its statement with a reason; it keeps its id, trace and verdicts',
      },
      {
        when: 'a judge finds a criterion misworded mid-judging',
        do: 'name it for the issue’s holder to patch, and judge the corrected words',
      },
    ],
    practice: ['A change to its lead tag is refused here: retrace through the whole list instead.'],
    example: {
      statement: 'A past order’s page offers Reorder.',
      reason: 'The old text named the wrong page.',
    },
    redFlag: 'Relaxing a criterion to match what got built, rather than correcting its words.',
    family: 'issue-work',
    audience: ['run', 'master'],
  },
  'POST /api/issues/:id/criteria/:ref/supersede': {
    purpose: 'Retires a landed issue’s criterion that your landed change alters on purpose.',
    situations: [
      {
        when: 'your landed change deliberately changes what another landed issue’s criterion promised',
        do: 'supersede that criterion naming your issue and the criterion now holding it',
      },
    ],
    practice: [
      'Do it once your issue is at awaiting_release or closed, so a re-judge does not reopen theirs.',
    ],
    example: {
      by: 'ISS-1240',
      criterion: 3,
      reason: 'The board now groups by step, which ISS-1240 c3 holds.',
    },
    // ISS-1240 / ISS-1241: a change that moved an older promise left it standing for a re-judge to fail
    redFlag:
      'Leaving the old criterion standing, so the next re-judge fails it and reopens a landed issue.',
    family: 'issue-work',
    audience: ['run', 'master'],
  },
  'POST /api/issues/:id/criteria/traces': {
    purpose: 'Adds one criterion per requirement BC code, worded as the BC and traced to it.',
    situations: [
      {
        when: 'an issue must prove its requirement’s BCs and has no criterion tracing them',
        do: 'add them by code; each is worded as the BC’s current wording',
      },
    ],
    practice: ['It ties no criterion you wrote: tag your own line `(REQ-n BC-m)` for that.'],
    example: { codes: ['BC-3', 'BC-4'] },
    // forge: 4 of 43 traces refused, codes the requirement's live head does not hold
    redFlag:
      'Tracing BC codes the requirement no longer holds, or writing the BC’s text by hand beside the trace.',
    family: 'issue-work',
    audience: ['run', 'master'],
  },
  'POST /api/issues/:id/merge/correction': {
    purpose: 'Replaces a closed issue’s landing commit in place, moving no status.',
    situations: [
      {
        when: 'a closed issue names the wrong landing commit, so its release reads it wrongly',
        do: 'correct it with the right commit and why; the issue stays closed',
      },
    ],
    practice: ['Send `landedAt` when the commit landed earlier than the mark was made.'],
    example: { commit: SHA, reason: 'The branch merged at this commit, not the one first read.' },
    // ISS-1027 / ISS-1226: a closed issue was unmarked and re-marked, which a closed issue refuses
    redFlag: 'Clearing a closed issue’s mark to re-mark it: a closed issue takes the correction.',
    family: 'issue-landing',
    audience: ['master'],
  },
  'POST /api/issues/:id/attachments': {
    purpose: 'Uploads a file to an issue that a verdict, comment or post can name.',
    situations: [
      {
        when: 'a verdict cites a clip, a still, a capture or a log',
        do: 'upload it first (multipart field `file`) and cite its name in the verdict’s evidence',
      },
    ],
    practice: [
      'From a box, `forge-runner api issues/<id>/attachments -F file=@<path>`; a local path in evidence is refused.',
    ],
    example: {},
    // the door takes the file in the multipart `file` field: a local path or base64 in evidence is refused
    redFlag:
      'Citing a local file path in a verdict’s evidence instead of uploading the file first.',
    family: 'issue-work',
    audience: ['run', 'master'],
  },
  'POST /api/issues/:id/events/:eventId/withdraw': {
    purpose: 'Withdraws a decision record that should not stand, keeping it on the record.',
    situations: [
      {
        when: 'a decision you recorded was a probe or a mistake',
        do: 'withdraw it with a reason; it stops reading as standing and stays in history',
      },
    ],
    practice: ['Its writer or a project admin may withdraw it.'],
    example: { reason: 'A probe of the route, not a decision.' },
    // forge, 2026-10-17..11-16: 10 of 14 withdrawals refused, among them a core act
    // (EVENT_WITHDRAW_CORE_ACT) and a decision kept as a comment (EVENT_WITHDRAW_IN_COMMENT)
    redFlag:
      'Withdrawing a record core wrote, or a decision kept as a comment, which this door does not hold.',
    family: 'issue-work',
    audience: ['master', 'run'],
  },
  'POST /api/issues/:id/patterns': {
    purpose: 'Names the pattern a change builds to, from the project’s catalog or as a new one.',
    situations: [
      {
        when: 'the project reads a pattern catalog and you are about to build',
        do: 'read GET …/patterns, then name the catalogued slug the change follows',
      },
      {
        when: 'no catalogued pattern fits the change',
        do: 'name a new slug with a summary; the work waits until another holder approves it',
      },
    ],
    practice: [
      'Where `catalog.declared` is false the project reads none: skip it.',
      'An approved new pattern’s catalog page lands in the same change.',
    ],
    example: { pattern: 'core-module' },
    redFlag:
      'Naming a new slug where a catalogued pattern fits, which holds the work until it is approved.',
    family: 'issue-work',
    audience: ['run'],
  },
  'POST /api/issues/:id/patterns/:patternId/retract': {
    purpose: 'Takes back the pattern a change named, saying why it no longer builds to it.',
    situations: [
      {
        when: 'the change no longer follows the pattern it named, or named the wrong one',
        do: 'retract it with the reason, then name the pattern it does follow',
      },
    ],
    practice: ['A retracted pattern stays on the record as retracted.'],
    example: { reason: 'The change follows core-module, not the new one first named.' },
    // forge: 1 of 2 retractions refused
    redFlag: 'Retracting a pattern a holder approved instead of asking them to return it.',
    family: 'issue-work',
    audience: ['run'],
  },
  'POST /api/issues/:id/patterns/:patternId/decision': {
    purpose: 'Approves or returns a new pattern a change named, as a holder of patterns.approve.',
    situations: [
      {
        when: 'a new pattern named on an issue waits on your approval',
        do: 'approve or return it with the reason; its author never decides it',
      },
    ],
    practice: ['The work naming it waits until another holder decides.'],
    example: {
      decision: 'returned',
      reason: 'core-module already covers a module with one route file.',
    },
    // forge: all 3 decisions were the naming run's master approving its own run's pattern, forbidden
    redFlag:
      'Approving a pattern your own run named: another holder of patterns.approve decides it.',
    family: 'issue-work',
    audience: ['person'],
  },
  'DELETE /api/issues/:id/dependencies/:edgeId': {
    purpose: 'Removes an edge between two issues that was recorded by mistake.',
    situations: [
      {
        when: 'an edge names the wrong issue, or was sent twice',
        do: 'remove it by its edge id; an edge that ended in time is retracted with validUntil instead',
      },
    ],
    practice: [
      'A blocks edge that held until something landed keeps its history: retract it, do not remove it.',
    ],
    example: {},
    // forge: both removals in the window were a master's own mistaken edges
    redFlag: 'Removing a blocks edge that once held, which erases why the work waited.',
    family: 'issue-order',
    audience: ['master', 'run'],
  },
  'DELETE /api/attachments/:id': {
    purpose: 'Deletes a file uploaded to an issue by mistake, as its uploader or a project admin.',
    situations: [
      {
        when: 'you uploaded the wrong file, or one holding something that must not stay',
        do: 'delete it by its attachment id',
      },
    ],
    practice: ['A file a verdict cites is that verdict’s evidence: supersede the verdict first.'],
    example: {},
    // forge: 4 deletes in the window, none refused
    redFlag: 'Deleting a file a standing verdict cites as its evidence.',
    family: 'issue-work',
    audience: ['master', 'run'],
  },
} satisfies Record<string, CapabilityCardBody>;
