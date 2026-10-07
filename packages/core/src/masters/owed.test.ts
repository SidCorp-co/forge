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
