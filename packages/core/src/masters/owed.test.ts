import { describe, expect, it } from 'vitest';
import { masterWork, owedLine, workDigest } from './owed.js';
import type {
  AgentConfirmOwed,
  FilingOwed,
  MarkOwed,
  ReleaseMergeOwed,
  StewardAsk,
  WaitingRequest,
} from './ports.js';

// The owed-work read is core's: the seven kinds of work a master owes are counted and digested in
// owed.ts, and the box only carries the line core composed. These are those rules.

const none = {
  designs: [],
  revisions: [],
  breakdowns: [],
  triages: [],
  confirms: [] as AgentConfirmOwed[],
  comments: [],
  documents: [],
  builderRuns: [],
  releaseNotes: [],
  warnedNotes: [],
  unnamedReleases: [] as { version: string }[],
  releaseMerges: [] as ReleaseMergeOwed[],
  releaseApprovals: [] as { runId: string; version: string | null }[],
  answers: [],
  stewardAsks: [] as StewardAsk[],
  landedWork: [] as {
    issueId: string;
    key: string;
    commit: string | null;
    mergedAt: string;
    status: 'in_progress' | 'open';
  }[],
  marks: [] as MarkOwed[],
  filings: [] as FilingOwed[],
  requests: [] as WaitingRequest[],
  contentLanguage: 'en',
};

function issue(issueId: string, status = 'open', blocker: string | null = null) {
  return {
    issueId,
    issueKey: `ISS-${issueId}`,
    projectId: 'p',
    title: null,
    description: null,
    priority: null,
    category: null,
    status,
    ageMinutes: 1,
    relations: blocker
      ? [
          {
            kind: 'blocks',
            dependsOnKey: 'ISS-9',
            blockerStatus: blocker,
            blockerMergedAt: null,
            edgeValidUntil: null,
          },
        ]
      : [],
    mergedAt: null,
    branch: null,
    pullRequests: [],
  };
}

/** A steward ask about one item, answered on that item alone. */
const askOf = (actId: string, ask: string, subject: StewardAsk['subject']): StewardAsk => ({
  actId,
  ask,
  subject,
  answeredOn: [subject],
});

describe('owedLine: what a pass is told it owes besides issues', () => {
  // hop 2026-10-07: six answers moved their parks back with nothing on the nudge, and the master
  // reported answered questions as owner-pending for several passes
  it('names each park question answered since the last pass, with what the answer did', () => {
    const line = owedLine({
      ...none,
      answers: [
        { issueKey: 'ISS-69', questionId: 'q1', outcome: { kind: 'resumed', to: 'open', at: 't' } },
        { issueKey: 'ISS-51', questionId: 'q2', outcome: { kind: 'held', at: 't' } },
        { issueKey: 'ISS-6', questionId: 'q3', outcome: null },
      ],
    });
    expect(line).toContain('3 park questions were answered since your last pass');
    expect(line).toContain('ISS-69 question q1: moved back to `open`');
    expect(line).toContain(
      'ISS-51 question q2: still parked: the answer says the issue still waits',
    );
    expect(line).toContain('ISS-6 question q3: not acted on yet');
    expect(
      masterWork([], { ...none, answers: [{ issueKey: 'ISS-6', questionId: 'q3', outcome: null }] })
        .owed,
    ).toBe(1);
  });

  it('moves the digest when an answer lands or what it did changes', () => {
    const answered = { issueKey: 'ISS-6', questionId: 'q3', outcome: null };
    const before = workDigest([], none);
    const landed = workDigest([], { ...none, answers: [answered] });
    const acted = workDigest([], {
      ...none,
      answers: [{ ...answered, outcome: { kind: 'resumed' as const, to: 'open', at: 't' } }],
    });
    expect(new Set([before, landed, acted]).size).toBe(3);
  });

  // REQ-48 BC-5: a steward wake the box missed is still read on its next sweep, and the work moves
  it("names each of the steward's asks, counts it owed, and moves the digest", () => {
    const ask = askOf('a1', 'ISS-498: no master has taken it since 10-14', {
      kind: 'issue',
      key: 'ISS-498',
    });
    const line = owedLine({ ...none, stewardAsks: [ask] });
    expect(line).toContain("The project's steward asks you to act on 1 item");
    expect(line).toContain('ISS-498: no master has taken it since 10-14');
    // ISS-607: only an ISO 8601 date ends a decision; the line says so, matching decision-until.ts
    expect(line).toContain('`until` only as an ISO 8601 date such as 2026-11-01');
    expect(masterWork([], { ...none, stewardAsks: [ask] }).owed).toBe(1);
    expect(workDigest([], { ...none, stewardAsks: [ask] })).not.toBe(workDigest([], none));
  });

  // ISS-654: the issue door answers 404 for a feedback item or a requirement, so each ask names the
  // door of its own item, and an issue's door only where an issue is asked about
  it('names the decision door of each asked item by its kind, and only those', () => {
    const fb = askOf('a2', 'FB-36: triage it', { kind: 'feedback', key: 'FB-36' });
    const req = askOf('a3', 'REQ-23: obtain the decision', { kind: 'requirement', key: 'REQ-23' });
    const line = owedLine({ ...none, stewardAsks: [fb, req] });
    expect(line).toContain(
      'on a feedback item (FB-36), `forge-runner api projects/<projectId>/feedback/<key>/comments -X POST` with `intent: decision`',
    );
    expect(line).toContain(
      'on a requirement (REQ-23), `forge-runner api projects/<projectId>/requirements/<key>/comments -X POST`',
    );
    expect(line).toContain('`reversedWhen` only as an ISO 8601 date such as 2026-11-01');
    expect(line).not.toContain('issues/<id>/events');
    const issue = askOf('a4', 'ISS-9: take it', { kind: 'issue', key: 'ISS-9' });
    const mixed = owedLine({ ...none, stewardAsks: [issue, fb] });
    expect(mixed).toContain('on an issue (ISS-9), `forge-runner api issues/<id>/events -X POST`');
    expect(mixed).toContain('on a feedback item (FB-36)');
    expect(mixed).not.toContain('on a requirement');
  });

  // ISS-564 round 2: landed work the wedge pass leaves moves no status, so the master is told the
  // move it owes on the sweep, or nothing ever makes it
  it('names landed work left at in_progress with the move it owes, counts it, and moves the digest', () => {
    const left = {
      issueId: 'u1',
      key: 'ISS-564',
      commit: `${'a'.repeat(39)}1`,
      mergedAt: '2026-10-24T20:00:00.000Z',
      status: 'in_progress' as const,
    };
    const line = owedLine({ ...none, landedWork: [left] });
    expect(line).toContain(
      '1 issue sits at `in_progress` with its work landed and nothing holding it',
    );
    expect(line).toContain(`ISS-564 u1 at ${left.commit}`);
    expect(line).toContain('"toStatus":"awaiting_release"');
    expect(line).toContain('issues/<id>/merge -X DELETE');
    expect(owedLine(none)).not.toContain('in_progress');
    expect(masterWork([], { ...none, landedWork: [left] }).owed).toBe(1);
    const once = workDigest([], { ...none, landedWork: [left] });
    expect(once).not.toBe(workDigest([], none));
    // a new mark on the same issue is new work: landed again after a reopen
    const again = { ...left, mergedAt: '2026-10-25T09:00:00.000Z' };
    expect(workDigest([], { ...none, landedWork: [again] })).not.toBe(once);
  });

  // ISS-774: Forge writes no mark and files no issue from a host's report of a merge; the master is
  // told what is owed instead, or nothing records the merge at all
  it('names a merged change request with no mark, and a merge naming no issue, as owed', () => {
    const sha = `${'b'.repeat(39)}2`;
    const mark = { issueId: 'u2', key: 'ISS-12', number: 41, commit: sha };
    const filing = { number: 42, commit: sha, title: 'Header fix', url: null };
    const line = owedLine({ ...none, marks: [mark], filings: [filing] });
    expect(line).toContain(`ISS-12 u2: !41 at ${sha}`);
    expect(line).toContain('Forge does not write a mark');
    expect(line).toContain(`!42 at ${sha} "Header fix"`);
    expect(line).toContain('file the issue for each merge');
    expect(owedLine(none)).not.toContain('file the issue');
    expect(masterWork([], { ...none, marks: [mark], filings: [filing] }).owed).toBe(2);
    expect(workDigest([], { ...none, filings: [filing] })).not.toBe(workDigest([], none));
  });

  it('names an owed triage by its key, and its method', () => {
    const line = owedLine({ ...none, triages: [{ key: 'FB-2' }] });
    expect(line).toContain('1 feedback item owes a triage (FB-2)');
    expect(line).toContain('feedback/<key>/triage -X POST');
    expect(line).not.toContain('ecosystem channel');
    expect(owedLine({ ...none, triages: [{ key: 'FB-2' }, { key: 'FB-5' }] })).toContain(
      '2 feedback items owe a triage (FB-2, FB-5)',
    );
  });

  it('names returned designs with their workflow, and returned revisions with their revision', () => {
    const line = owedLine({
      ...none,
      designs: [
        { workflowId: 'w1', flow: 'catalog-context', revision: 1 },
        { workflowId: 'w2', flow: 'catalog-design-deploy', revision: 1 },
      ],
      revisions: [{ key: 'REQ-2', revision: 2 }],
    });
    expect(line).toContain(
      '2 returned designs owe a revision no issue carries (catalog-context r1, workflow w1; catalog-design-deploy r1, workflow w2)',
    );
    expect(line).toContain('1 returned requirement revision owes a revise (REQ-2 r2)');
    expect(line).not.toContain('builder run');
  });

  it('names an overdue breakdown as overdue, and a thread reply by its comment id', () => {
    const line = owedLine({
      ...none,
      breakdowns: [
        { key: 'REQ-3', overdue: true },
        { key: 'REQ-4', overdue: false },
      ],
      comments: [{ issueKey: 'ISS-7', commentId: 'c1' }],
    });
    expect(line).toContain('2 agreed requirements have no breakdown yet (REQ-3 overdue, REQ-4)');
    expect(line).toContain('A person is owed a reply on 1 issue (ISS-7 comment c1)');
  });

  // catalog-api 0.1.0 (REQ-40 BC-14): a release with no name opened on a bare version and an
  // issue-title headline cut at 72 characters
  it('names a release drafted with no name and the write that names it, in the content language', () => {
    const line = owedLine({
      ...none,
      contentLanguage: 'vi',
      unnamedReleases: [{ version: '0.1.0' }],
    });
    expect(line).toContain('1 release drafted or cut has no name (0.1.0)');
    expect(line).toContain('releases/<version>/naming -X PUT');
    expect(line).toContain('in Vietnamese');
    expect(masterWork([], { ...none, unnamedReleases: [{ version: '0.1.0' }] }).owed).toBe(1);
  });

  it('teaches the note it asks for with its short title, so the write it names is never refused', () => {
    const line = owedLine({ ...none, releaseNotes: [{ issueId: 'u6', key: 'ISS-6' }] });
    expect(line).toContain('"title":');
    expect(line).toContain('adminSteps');
  });

  it('names an issue at the release gate with no note by key and id, and the write that clears it', () => {
    const one = owedLine({ ...none, releaseNotes: [{ issueId: 'u6', key: 'ISS-6' }] });
    expect(one).toContain('1 issue waits at the release gate with no release note (ISS-6 u6)');
    expect(one).toContain('RELEASE_RECORD_MISSING');
    expect(one).toContain('issues/<id> -X PATCH');
    const two = owedLine({
      ...none,
      releaseNotes: [
        { issueId: 'u6', key: 'ISS-6' },
        { issueId: 'u11', key: 'ISS-11' },
      ],
    });
    expect(two).toContain(
      '2 issues wait at the release gate with no release note (ISS-6 u6, ISS-11 u11)',
    );
  });

  it('lists the notes that warn with what is wrong, counts them as owed, and moves the digest', () => {
    const warned = [
      {
        issueId: 'u6',
        key: 'ISS-6',
        release: null,
        problems: ['not in Vietnamese', 'issue key ISS-6'],
      },
    ];
    const line = owedLine({ ...none, warnedNotes: warned });
    expect(line).toContain(
      '1 release note waiting to ship reads wrong to a user (ISS-6 u6 (not in Vietnamese; issue key ISS-6))',
    );
    expect(line).toContain('the release is not refused for it');
    expect(masterWork([], { ...none, warnedNotes: warned }).owed).toBe(1);
    expect(workDigest([], { ...none, warnedNotes: warned })).not.toBe(workDigest([], none));
  });

  it('says nothing when nothing is owed', () => {
    expect(owedLine(none)).toBe('');
  });
});

// REQ-70 BC-3: a note claimed by a release still open is named with that release, so it is fixed before review
describe('owedLine: a warned note names the open release holding it', () => {
  it('names the release beside the note that needs one sentence', () => {
    const claimed = [
      {
        issueId: 'u16',
        key: 'ISS-16',
        release: '0.1.0',
        problems: ['note needs one sentence (it says 2)'],
      },
    ];
    expect(owedLine({ ...none, warnedNotes: claimed })).toContain(
      'ISS-16 u16 in release 0.1.0 (note needs one sentence (it says 2))',
    );
  });
});

describe('workDigest: the same work digests the same, and changed work does not', () => {
  it('does not move with the order work was read in', () => {
    expect(workDigest([issue('a'), issue('b')], none)).toBe(
      workDigest([issue('b'), issue('a')], none),
    );
  });

  it('moves with an issue status, a gating blocker, or an owed item', () => {
    const base = workDigest([issue('a')], none);
    expect(workDigest([issue('a', 'in_progress')], none)).not.toBe(base);
    expect(workDigest([issue('a', 'open', 'open')], none)).not.toBe(base);
    expect(workDigest([issue('a')], { ...none, triages: [{ key: 'FB-1' }] })).not.toBe(base);
    const confirm = {
      key: 'FB-1',
      feedbackId: 'f1',
      reporter: 'a',
      itemProjectId: 'p',
      home: false,
    };
    expect(workDigest([issue('a')], { ...none, confirms: [confirm] })).not.toBe(base);
  });

  it("names the project's content language in the release-note nudge, so a vi project is asked for Vietnamese", () => {
    const owed = { ...none, releaseNotes: [{ issueId: 'u6', key: 'ISS-6' }] };
    const vi = owedLine({ ...owed, contentLanguage: 'vi' });
    expect(vi).toContain('content language is Vietnamese (`vi`)');
    expect(vi).toContain('in Vietnamese>');
    expect(owedLine(owed)).toContain('content language is English (`en`)');
    expect(workDigest([], { ...owed, contentLanguage: 'vi' })).toBe(workDigest([], owed));
  });

  it('keys an owed release note on its issue, so the same gate digests the same on every sweep', () => {
    const owed = { ...none, releaseNotes: [{ issueId: 'u6', key: 'ISS-6' }] };
    expect(workDigest([], owed)).toBe(workDigest([], { ...owed }));
    expect(workDigest([], owed)).not.toBe(workDigest([], none));
    expect(workDigest([], owed)).not.toBe(
      workDigest([], { ...none, releaseNotes: [{ issueId: 'u7', key: 'ISS-7' }] }),
    );
  });
});

describe('masterWork: what the box types and opens a pass on', () => {
  it('opens the pass on the one admissible issue only where nothing else is owed', () => {
    expect(masterWork([issue('a')], none).issueKey).toBe('ISS-a');
    expect(masterWork([issue('a')], { ...none, triages: [{ key: 'FB-1' }] }).issueKey).toBeNull();
    expect(masterWork([issue('a'), issue('b')], none).issueKey).toBeNull();
  });

  it('counts the owed items and carries their line on the nudge', () => {
    const work = masterWork([], {
      ...none,
      triages: [{ key: 'FB-1' }],
      builderRuns: [{ id: 'b1', ecosystem: 'e' }],
    });
    expect(work).toMatchObject({ admissible: 0, owed: 2 });
    expect(work.nudge.startsWith('Pass. Hand it to the dispatch skill')).toBe(true);
    expect(work.nudge).toContain(work.owedLine);
    expect(work.owedLine).toContain('1 ecosystem builder run is open (b1)');
  });
});

describe('an accepted merge-request release is owed to the master that merges it (REQ-71 BC-4)', () => {
  const merge = (number: number, merged: number): ReleaseMergeOwed => ({
    runId: 'r1',
    version: '0.1.0',
    next: { label: `!${number}`, number, issueId: 'u1', issueKey: 'ISS-1' },
    merged,
    total: 2,
  });

  it('names the next request in order, the door that merges it and the moved-head refusal', () => {
    const line = owedLine({ ...none, releaseMerges: [merge(5008, 0)] });
    expect(line).toContain('0.1.0 (run r1): !5008 next, 0 of 2 merged, through ISS-1 u1');
    expect(line).toContain('merge-pull-request');
    expect(line).toContain('RELEASE_MERGE_HEAD_MOVED');
  });

  it('moves the digest with each merge, so the master is asked for the one after', () => {
    const first = workDigest([], { ...none, releaseMerges: [merge(5008, 0)] });
    expect(workDigest([], { ...none, releaseMerges: [merge(5009, 1)] })).not.toBe(first);
    expect(masterWork([], { ...none, releaseMerges: [merge(5008, 0)] }).owed).toBe(1);
  });

  it('names the route a release waiting on its approval request asks with (ISS-591)', () => {
    const line = owedLine({ ...none, releaseApprovals: [{ runId: 'r2', version: '0.2.0' }] });
    expect(line).toContain('0.2.0 (run r2)');
    expect(line).toContain('release-batches/<runId>/approvals -X POST');
  });
});

// REQ-66 BC-8: an agent reporter has no bell, so the master of the project it reported from confirms for it
describe('an agent reporter’s confirm on the owed line', () => {
  it('names an agent reporter’s owed confirm by its key and reporter, at the door of the project the item sits in', () => {
    const forge: AgentConfirmOwed = {
      key: 'FB-230',
      feedbackId: 'f230',
      reporter: 'catalog-fe',
      itemProjectId: 'home',
      home: true,
    };
    const own: AgentConfirmOwed = {
      ...forge,
      key: 'FB-4',
      feedbackId: 'f4',
      itemProjectId: 'p',
      home: false,
    };
    const one = owedLine({ ...none, confirms: [forge] });
    expect(one).toContain(
      '1 shipped feedback item an agent of this project reported owes its confirm (FB-230 from catalog-fe, `forge-runner api forge/feedback/FB-230/verify -X POST`)',
    );
    expect(one).toContain('evidence');
    expect(owedLine({ ...none, confirms: [forge, own] })).toContain(
      'owe their confirm (FB-230 from catalog-fe, `forge-runner api forge/feedback/FB-230/verify -X POST`; FB-4 from catalog-fe, `forge-runner api projects/p/feedback/FB-4/verify -X POST`)',
    );
  });
});

describe('stewardAsksLine: the items a decision answers an ask on', () => {
  // ISS-739: an ask a stuck item's run made about its blocker is answered on either item, and the
  // line names both, each at its own door, and says a dated decision answers it until its date
  it('names each item a decision answers an ask on, the blocker and the stuck item, at their doors', () => {
    const blocked: StewardAsk = {
      actId: 'a5',
      ask: 'ISS-746: complete the work blocking ISS-748',
      subject: { kind: 'issue', key: 'ISS-746' },
      answeredOn: [
        { kind: 'issue', key: 'ISS-746' },
        { kind: 'issue', key: 'ISS-748' },
      ],
    };
    const line = owedLine({ ...none, stewardAsks: [blocked] });
    expect(line).toContain(
      'ISS-746: complete the work blocking ISS-748 [a decision on ISS-746 or ISS-748 answers it]',
    );
    expect(line).toContain('on an issue (ISS-746, ISS-748), `forge-runner api issues/<id>/events');
    expect(line).toContain('or such a decision answers it, one with a date until that date');
  });
});

// ISS-774: every merge the line lists is owed because its commit names no issue, so the line asks
// for the act the mark takes for exactly that commit, never one a subject check refuses
describe('owedLine: a filing is asked for as the mark takes it', () => {
  it('names the mark door and the rule that takes a merge naming no issue', () => {
    const filing = { number: 1233, commit: 'd'.repeat(40), title: 'Archived project', url: null };
    const line = owedLine({ ...none, filings: [filing] });
    expect(line).toContain('issues/<id>/merge -X POST');
    expect(line).toContain('The mark takes a merge listed here as the landing of the one issue');
    expect(line).toContain('a commit naming one issue is never another');
  });
});
