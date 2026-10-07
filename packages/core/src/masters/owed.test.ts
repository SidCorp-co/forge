import { describe, expect, it } from 'vitest';
import { masterWork, owedLine, workDigest } from './owed.js';

// The owed-work read is core's: the seven kinds of work a master owes are counted and digested in
// owed.ts, and the box only carries the line core composed. These are those rules.

const none = {
  designs: [],
  revisions: [],
  breakdowns: [],
  triages: [],
  comments: [],
  documents: [],
  builderRuns: [],
  releaseNotes: [],
  warnedNotes: [],
  answers: [],
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
      { issueId: 'u6', key: 'ISS-6', problems: ['not in Vietnamese', 'issue key ISS-6'] },
    ];
    const line = owedLine({ ...none, warnedNotes: warned });
    expect(line).toContain(
      '1 release note at the release gate reads wrong to a user (ISS-6 u6 (not in Vietnamese; issue key ISS-6))',
    );
    expect(line).toContain('the release is not refused for it');
    expect(masterWork([], { ...none, warnedNotes: warned }).owed).toBe(1);
    expect(workDigest([], { ...none, warnedNotes: warned })).not.toBe(workDigest([], none));
  });

  it('says nothing when nothing is owed', () => {
    expect(owedLine(none)).toBe('');
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
