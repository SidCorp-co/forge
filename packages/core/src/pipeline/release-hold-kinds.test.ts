import { describe, expect, it } from 'vitest';
import type { IssueCriteriaReport } from '../issues/criteria-verdicts.js';
import {
  closeRefusedHold,
  closeUnreadableHold,
  criteriaHold,
  criteriaUnreadableHold,
  cutFailedHold,
  gateUnreadableHold,
  NO_RELEASE_GATE_HOLD,
  queuedBehindHold,
  type ReleaseHold,
  refusalHold,
  releaseHoldComment,
  runtimeUnroutedHold,
  targetUndeclaredHold,
} from './release-hold.js';

// ISS-1421 r8 repair 2: every kind a hold comment comes in is what holds it, what a person does
// and what happens then — three short sentences, no backticked word, no code.
const HEADING = '**Held by the automatic release**';
const REPORT: IssueCriteriaReport = {
  issueId: 'iss-1',
  broken: [],
  serving: {
    kind: 'serving',
    served: [{ commit: '33637c612ef15be6f924520c0d201a0889d8ed7e', where: 'https://app.test' }],
    unread: [],
    readAt: '2026-09-26T23:55:00.000Z',
  },
  runtimes: [],
  uncorroborated: [],
  unearned: [
    { criterion: 3, verdict: null, standing: null, why: 'no verdict was recorded for it' },
    { criterion: 5, verdict: null, standing: null, why: 'no verdict was recorded for it' },
  ],
};
const QUESTION = {
  code: 'OPEN_QUESTIONS',
  reason: 'holds 1 open question',
  clears: 'Answer it on the issue.',
  clearsHere: 'Answer it in the Decision waiting card above.',
};
const UNMERGED = {
  code: 'CLOSE_REQUIRES_SHIPPED',
  reason: 'not marked merged',
  clears:
    "Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed.",
  clearsHere:
    "Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed.",
};
const RECORDS = {
  code: 'ENTRY_CRITERIA_UNMET',
  reason: 'missing a test report, which this project requires before a close',
  clears: 'An agent writes them. To start one, press Open session at the top of the issue page.',
  clearsHere: 'An agent writes them. To start one, press Open session at the top of this page.',
};
// r10: judge-46 read a 25-word sentence where the issue had no session to open.
const RECORDS_NO_SESSION = {
  code: 'ENTRY_CRITERIA_UNMET',
  reason: 'missing a plan, acceptance criteria and a release note, which this project requires before a close',
  clears:
    "An agent writes them through Forge's issue tools. This issue has no session to open, so use Reopen in the issue's actions menu. The agent that takes it writes them.",
  clearsHere:
    "An agent writes them through Forge's issue tools. This issue has no session to open, so use Reopen in the actions menu at the top of this page. The agent that takes it writes them.",
};
const QUESTIONS = { ...QUESTION, reason: 'holds 2 open questions' };
const UNREAD_REPORT: IssueCriteriaReport = {
  ...REPORT,
  unearned: REPORT.unearned.map((c) => ({ ...c, clears: ['give Forge a deploy key it can read with'] })),
};
const TARGET =
  'This project declares a release chain and has no active deploy binding carrying the `live` stage, so there is nowhere for a release to land.';

const KINDS: ReadonlyArray<[string, ReleaseHold, string]> = [
  [
    'criteria unearned',
    criteriaHold(REPORT),
    'The automatic release leaves this issue out, because criteria 3 and 5 are not earned at the deployment. ' +
      'A person records a verdict on each at the running deployment, or closes the issue by hand. ' +
      'The next sweep weighs it again.',
  ],
  [
    'no runtime route',
    runtimeUnroutedHold('this project has no active deploy binding', 'bind one'),
    "The automatic release cannot read what this project is serving, so no waiting issue's criteria can be weighed. " +
      'A person gives this project a deploy binding that reports the commit it serves, under Settings → Integrations. ' +
      'The next sweep then weighs every waiting issue again.',
  ],
  [
    'close refused for one reason',
    closeRefusedHold([QUESTION]),
    'The automatic release cannot close this issue, because it holds 1 open question. ' +
      'To clear it, answer the question in the Decision waiting card above. ' +
      'The next sweep releases it once that is done.',
  ],
  [
    'close refused for several reasons',
    closeRefusedHold([UNMERGED, QUESTION, RECORDS]),
    'The automatic release cannot close this issue, for 3 reasons.\n\n' +
      '- It is not marked merged. Use Mark merged in its properties and fill in Where it landed.\n' +
      '- It holds 1 open question. Answer the question in the Decision waiting card above.\n' +
      '- It is missing a test report. Press Open session at the top of this page, and the agent writes the missing records.\n\n' +
      'The next sweep releases it once each is done.',
  ],
  [
    'close refused for missing records, with no session to open',
    closeRefusedHold([RECORDS_NO_SESSION]),
    'The automatic release cannot close this issue, because it is missing a plan, acceptance criteria and a release note. ' +
      'To clear it, use Reopen in the actions menu at the top, and an agent writes the missing records. ' +
      'The next sweep releases it once that is done.',
  ],
  [
    'close refused for several reasons, with no session to open',
    closeRefusedHold([QUESTIONS, RECORDS_NO_SESSION]),
    'The automatic release cannot close this issue, for 2 reasons.\n\n' +
      '- It holds 2 open questions. Answer the questions in the Decision waiting cards above.\n' +
      '- It is missing a plan, acceptance criteria and a release note. Use Reopen in the actions menu at the top, and an agent writes the missing records.\n\n' +
      'The next sweep releases it once each is done.',
  ],
  [
    'criteria unearned with an unreadable repository',
    criteriaHold(UNREAD_REPORT),
    'The automatic release leaves this issue out, because criteria 3 and 5 are unearned and its repository is unreadable. ' +
      'A person makes the repository readable to Forge again, then records a verdict on each or closes the issue. ' +
      'The next sweep weighs it again.',
  ],
  [
    'close unreadable',
    closeUnreadableHold('connection reset'),
    'The automatic release could not read whether this issue can be closed, so it did not carry it. ' +
      'Nobody needs to act unless this repeats, and then a person reports it. ' +
      'The next sweep reads it again.',
  ],
  [
    'gate unreadable',
    gateUnreadableHold('connection reset'),
    "The automatic release could not read this project's release gate, so it decided nothing about this issue. " +
      'Nobody needs to act unless this repeats, and then a person reports it. ' +
      'The next sweep reads the gate again.',
  ],
  [
    'verdicts unreadable',
    criteriaUnreadableHold('connection reset'),
    'The automatic release could not read the verdicts on this issue, so it could not weigh its criteria. ' +
      'Nobody needs to act unless this repeats, and then a person reports it. ' +
      'The next sweep reads them again.',
  ],
  [
    'no live deploy binding',
    targetUndeclaredHold(TARGET),
    'A release has nowhere to land, because no active deploy binding of this project carries its live stage. ' +
      'A person adds one under Settings → Integrations, or chooses "Repository, no release" under Shape & release. ' +
      'The next sweep then releases the waiting issues.',
  ],
  [
    'queued behind',
    queuedBehindHold(20),
    'One release carries at most 20 issues, oldest merge first, and this one is behind them. ' +
      'Nobody needs to act. A later automatic release carries it.',
  ],
  [
    'no release declared',
    NO_RELEASE_GATE_HOLD,
    'This project declares no release, so nothing carries this issue on from Awaiting release. ' +
      'A person declares a release chain under Settings → Shape & release, or closes the issue. ' +
      'The next sweep then releases it.',
  ],
  [
    'a refusal a person clears',
    refusalHold('NO_RUNNER_ONLINE', [
      'No box that can run this release is online. `dev1` last reported 3 minutes ago.',
    ]),
    'The automatic release was refused, because no box that can run this release is online. ' +
      'A person clears what Settings → Shape & release lists under "Can this project release?". ' +
      'The next sweep tries the release again.',
  ],
  [
    'a refusal that clears itself',
    refusalHold('BATCH_IN_FLIGHT', ['A release of this project is already running.']),
    'The automatic release was refused, because a release of this project is already running. ' +
      'Nobody needs to act. The next sweep tries the release again.',
  ],
  [
    'a failed cut',
    cutFailedHold(['lock timeout']),
    'An automatic release attempt failed, and this issue was left as it was. ' +
      'Nobody needs to act unless this repeats, and then a person reports it. ' +
      'The next sweep tries again on its own.',
  ],
];

describe('every hold kind is commented in three short sentences (ISS-1421 r8 repair 2)', () => {
  // r10, criterion 133: every builder in release-hold-kinds.ts (a refusal as a person's and as one
  // that clears itself), and each variant one of them words differently, is measured above.
  it('measures every kind a hold comes in', () => {
    expect(new Set(KINDS.map(([, hold]) => hold.code)).size).toBe(12);
    expect(KINDS.length).toBe(16);
  });

  it.each(KINDS)(
    'words the %s hold as what holds it, what a person does, what follows',
    (_k, hold, said) => {
      const body = releaseHoldComment(hold, true, ['ISS-8']);
      expect(body).toBe(`${HEADING}\n\n${said}`);
      expect(body).not.toMatch(/`|RELEASE_|NO_RELEASE|NO_RUNNER|BATCH_IN|It is waiting for/);
      // A list of reasons is one part of the three; its lines are each held to the word cap.
      const parts = said.split(/\n\n/);
      const sentences = parts.length === 3 ? parts : said.split(/(?<=\.)\s+(?=[A-Z])/);
      expect(sentences.length, said).toBeLessThanOrEqual(3);
      // r9: judge-43 read two sentences of 32 and 48 words in a three-shortfall comment.
      for (const one of said.split(/\n|(?<=\.)\s+(?=[A-Z-])/)) {
        if (one.trim() === '') continue;
        expect(one.split(/\s+/).length, one).toBeLessThanOrEqual(20);
      }
    },
  );

  it('keeps a long refusal reason to the page that lists it, never a long sentence', () => {
    const long = `${'The release check found one more thing to fix before this project can release, '.repeat(2)}.`;
    const body = releaseHoldComment(refusalHold('NO_RUNNER_ONLINE', [long]));
    expect(body).toContain(
      'The automatic release was refused, for a reason Settings → Shape & release lists.',
    );
  });

  it('names the rows one shared comment stands for in its heading, not in a fourth sentence', () => {
    const body = releaseHoldComment(queuedBehindHold(20), true, ['ISS-5', 'ISS-3', 'ISS-4']);
    expect(body.split('\n\n')[0]).toBe(`${HEADING} for ISS-5, ISS-3 and ISS-4`);
    expect(body).not.toContain('stands for');
  });
});
