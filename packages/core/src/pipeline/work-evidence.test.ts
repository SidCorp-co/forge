/**
 * `collectWorkEvidence` / `hasCodeEvidence` / `hasChildIssues` /
 * `findMissingWorkEvidence` — ISS-786 child B: DB-side evidence that code
 * exists for an issue (no server-side git checkout is available).
 */

import { describe, expect, it, vi } from 'vitest';

const queue: unknown[][] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => {
      const tail = { where: () => ({ limit: async () => queue.shift() ?? [] }) };
      return { from: () => ({ ...tail, innerJoin: () => tail }) };
    },
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  collectWorkEvidence,
  hasCodeEvidence,
  hasChildIssues,
  findMissingWorkEvidence,
  missingWorkEvidenceStrict,
} = await import('./work-evidence.js');

function setup(...batches: unknown[][]) {
  queue.length = 0;
  queue.push(...batches);
}

describe('collectWorkEvidence', () => {
  it('aggregates commitSha, filesModified and branch across handoffs + sessionContext', async () => {
    setup(
      [{ id: 'job-1' }],
      [
        { payload: { step: 'code', filesModified: [{ path: 'a.ts', op: 'edit' }] } },
        { payload: { step: 'fix', commitSha: 'abc123', filesModified: [] } },
      ],
      [
        {
          sessionContext: { branch: 'ISS-1-foo' },
          baseBranch: 'main',
          releaseChain: [],
          projectKind: 'standard',
        },
      ],
    );
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence).toEqual({
      implementationJobCount: 1,
      handoffCommitSha: 'abc123',
      handoffFilesModified: 1,
      branch: 'ISS-1-foo',
      mergedCommitSha: null,
      lane: 'git',
    });
  });

  it('the project base branch is NOT evidence — it names where work lands, not that any happened', async () => {
    setup(
      [],
      [],
      [
        {
          sessionContext: { branch: 'main' },
          baseBranch: 'main',
          releaseChain: [{ branch: 'main' }],
        },
      ],
    );
    const evidence = await collectWorkEvidence('iss-1');
    expect(
      evidence.branch,
      'forge-dev 2026-09-02: 2 issues carried branch:main with zero code/fix/drive jobs and passed the gate',
    ).toBeNull();
    expect(hasCodeEvidence(evidence)).toBe(false);
  });

  it('an issue-specific branch still counts even when a base branch is configured', async () => {
    setup(
      [],
      [],
      [
        {
          sessionContext: { branch: 'ISS-9-x' },
          baseBranch: 'main',
          releaseChain: [{ branch: 'main' }, { branch: 'master', from: 'merge-branch' }],
        },
      ],
    );
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence.branch).toBe('ISS-9-x');
    expect(hasCodeEvidence(evidence)).toBe(true);
  });

  it('a bare done job with an empty handoff is NOT evidence (ISS-105 shape)', async () => {
    setup(
      [{ id: 'job-1' }],
      [
        {
          payload: {
            step: 'code',
            filesModified: [],
            decisions: [],
            verificationCommands: [],
            knownLimitations: [],
          },
        },
      ],
      [{ sessionContext: null, baseBranch: 'main', releaseChain: [] }],
    );
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence.implementationJobCount).toBe(1);
    expect(hasCodeEvidence(evidence)).toBe(false);
  });

  it('returns no evidence when nothing is recorded', async () => {
    setup([], [], [{ sessionContext: null, baseBranch: 'main', releaseChain: [] }]);
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence).toEqual({
      implementationJobCount: 0,
      handoffCommitSha: null,
      handoffFilesModified: 0,
      branch: null,
      mergedCommitSha: null,
      lane: null,
    });
  });

  it('reads the branch a hand-driven run records, at sessionContext.worklog.branch', async () => {
    setup(
      [],
      [],
      [
        {
          sessionContext: { worklog: { branch: 'ISS-1003', head: 'abc1234' } },
          baseBranch: 'main',
          releaseChain: [],
        },
      ],
    );
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence.branch).toBe('ISS-1003');
    expect(hasCodeEvidence(evidence)).toBe(true);
  });

  it('refuses the base branch in the worklog just as it does at the top level', async () => {
    setup(
      [],
      [],
      [
        {
          sessionContext: { worklog: { branch: 'main' } },
          baseBranch: 'main',
          releaseChain: [{ branch: 'main' }, { branch: 'release', from: 'merge-branch' }],
        },
      ],
    );
    expect((await collectWorkEvidence('iss-1')).branch).toBeNull();
  });

  it('ignores a blank sessionContext.branch string', async () => {
    setup([], [], [{ sessionContext: { branch: '' }, baseBranch: 'main', releaseChain: [] }]);
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence.branch).toBeNull();
  });
});

describe('hasCodeEvidence', () => {
  it('is true when only branch is set', () => {
    expect(
      hasCodeEvidence({
        implementationJobCount: 0,
        handoffCommitSha: null,
        handoffFilesModified: 0,
        branch: 'ISS-1-foo',
        mergedCommitSha: null,
        lane: 'git',
      }),
    ).toBe(true);
  });

  it('is true when only commitSha is set', () => {
    expect(
      hasCodeEvidence({
        implementationJobCount: 0,
        handoffCommitSha: 'sha',
        handoffFilesModified: 0,
        branch: null,
        mergedCommitSha: null,
        lane: 'git',
      }),
    ).toBe(true);
  });

  it('is true when only filesModified > 0', () => {
    expect(
      hasCodeEvidence({
        implementationJobCount: 0,
        handoffCommitSha: null,
        handoffFilesModified: 3,
        branch: null,
        mergedCommitSha: null,
        lane: 'git',
      }),
    ).toBe(true);
  });

  it('is false with a nonzero job count but zero content evidence', () => {
    expect(
      hasCodeEvidence({
        implementationJobCount: 5,
        handoffCommitSha: null,
        handoffFilesModified: 0,
        branch: null,
        mergedCommitSha: null,
        lane: 'git',
      }),
    ).toBe(false);
  });
});

describe('a merged commit Forge holds on the row (ISS-1318)', () => {
  const SHA = '3f1c2b4a5d6e7f8091a2b3c4d5e6f708192a3b4c';

  it('counts as evidence on an issue whose only recorded branch is the base branch', async () => {
    setup(
      [],
      [],
      [
        {
          sessionContext: { worklog: { branch: 'main' } },
          mergedAt: new Date('2026-09-30T10:00:00Z'),
          mergedCommitSha: SHA,
          baseBranch: 'main',
          releaseChain: [],
        },
      ],
    );
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence.branch).toBeNull();
    expect(evidence.mergedCommitSha).toBe(SHA);
    expect(hasCodeEvidence(evidence)).toBe(true);
  });

  it('is no evidence where merged_at is empty: a sha with no mark is unmarked', async () => {
    setup(
      [],
      [],
      [
        {
          sessionContext: { branch: 'main' },
          mergedAt: null,
          mergedCommitSha: SHA,
          baseBranch: 'main',
          releaseChain: [],
        },
      ],
    );
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence.mergedCommitSha).toBeNull();
    expect(hasCodeEvidence(evidence)).toBe(false);
  });

  it('is no evidence where the column holds only whitespace', async () => {
    setup(
      [],
      [],
      [
        {
          sessionContext: null,
          mergedAt: new Date(),
          mergedCommitSha: '  ',
          baseBranch: 'main',
          releaseChain: [],
        },
      ],
    );
    expect(hasCodeEvidence(await collectWorkEvidence('iss-1'))).toBe(false);
  });

  it('names the commit route in the refusal, beside the branch and the handoff', async () => {
    setup(
      [],
      [],
      [],
      [{ sessionContext: null, baseBranch: 'main', releaseChain: [], projectKind: 'standard' }],
    );
    const detail = await findMissingWorkEvidence('iss-1');
    expect(detail).toContain('`mark_merged` carrying `data.commit`');
    expect(detail).toContain("checks against the project's repository");
    expect(detail).toContain('sessionContext.worklog.branch');
    expect(detail).toContain('commitSha/filesModified');
  });

  it('offers no commit route on a project whose work lands outside git, and names who clears it', async () => {
    setup(
      [],
      [],
      [],
      [{ sessionContext: null, baseBranch: 'main', releaseChain: [], projectKind: 'website' }],
    );
    const detail = await findMissingWorkEvidence('iss-1');
    expect(detail).toContain('no branch or code handoff is recorded');
    expect(detail).not.toContain('`mark_merged` carrying `data.commit`');
    expect(detail).toContain("This project's work lands outside git");
    expect(detail).toContain('a person may mark it merged and move it');
    expect(detail).toContain('commitSha/filesModified');
  });

  it('offers no commit route where the project kind is none Forge knows, and says so', async () => {
    setup(
      [],
      [],
      [],
      [{ sessionContext: null, baseBranch: 'main', releaseChain: [], projectKind: 'kiosk' }],
    );
    const detail = await findMissingWorkEvidence('iss-1');
    expect(detail).not.toContain('`mark_merged` carrying `data.commit`');
    expect(detail).toContain('none of `standard`, `website`');
  });

  it.each([
    [
      'standard',
      "a person's mark naming a commit is checked only for the repository holding it, not read as this issue's landing, so it does not clear this",
    ],
    ['website', 'a landing it names is not evidence, whoever marks it'],
    ['kiosk', 'none of `standard`, `website`'],
  ])(
    'tells anyone a declared criterion holds which routes clear it on a %s project, never that it does not hold them',
    async (projectKind, says) => {
      setup(
        [],
        [],
        [],
        [{ sessionContext: null, baseBranch: 'main', releaseChain: [], projectKind }],
      );
      const detail = await findMissingWorkEvidence('iss-1', undefined, 'anyone');
      expect(detail).toContain(says);
      expect(detail).toContain('`statusEntryCriteria`');
      expect(detail).toContain('commitSha/filesModified');
      expect(detail).not.toContain('does not hold them to');
      expect(detail).not.toContain('the commit it landed at, which Forge checks');
    },
  );
});

describe('hasChildIssues', () => {
  it('true when an outgoing decomposes edge exists', async () => {
    setup([{ id: 'edge-1' }]);
    expect(await hasChildIssues('iss-1')).toBe(true);
  });

  it('false when no decomposes edge exists', async () => {
    setup([]);
    expect(await hasChildIssues('iss-1')).toBe(false);
  });
});

describe('findMissingWorkEvidence', () => {
  it('returns null for a decompose parent regardless of evidence', async () => {
    setup([{ id: 'edge-1' }]);
    expect(await findMissingWorkEvidence('iss-1')).toBeNull();
  });

  it('returns the detail string when no evidence exists', async () => {
    setup(
      [],
      [],
      [],
      [{ sessionContext: null, baseBranch: 'main', releaseChain: [], projectKind: 'standard' }],
    );
    const detail = await findMissingWorkEvidence('iss-1');
    expect(detail).toContain('no branch, commit or code handoff');
    expect(detail).toContain('sessionContext.worklog.branch');
  });

  it('returns null when evidence exists', async () => {
    setup(
      [],
      [],
      [],
      [{ sessionContext: { branch: 'ISS-1-foo' }, baseBranch: 'main', releaseChain: [] }],
    );
    expect(await findMissingWorkEvidence('iss-1')).toBeNull();
  });

  it('fails open (returns null) when a query throws', async () => {
    const { db } = await import('../db/client.js');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    const original = (db as any).select;
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = () => {
      throw new Error('connection reset');
    };
    expect(await findMissingWorkEvidence('iss-1')).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = original;
  });
});

/**
 * ISS-1072 — the same check, letting its own failure out.
 *
 * A reader that PUBLISHES this answer cannot use the fail-open one: "the query
 * raised" and "the evidence is there" are the same value to it, and a check run
 * saying a criterion is met because a SELECT threw is the silent substitution
 * this repo forbids — worse here than in the gate, because the gate's answer is
 * seen by the one agent it refused and this one goes on a pull request.
 */
describe('missingWorkEvidenceStrict', () => {
  it('answers exactly as the fail-open one does when nothing raises', async () => {
    setup(
      [],
      [],
      [],
      [{ sessionContext: { branch: 'ISS-1-foo' }, baseBranch: 'main', releaseChain: [] }],
    );
    expect(await missingWorkEvidenceStrict('iss-1')).toBeNull();

    setup([], [], [], [{ sessionContext: null, baseBranch: 'main', releaseChain: [] }]);
    const strict = await missingWorkEvidenceStrict('iss-1');
    setup([], [], [], [{ sessionContext: null, baseBranch: 'main', releaseChain: [] }]);
    const open = await findMissingWorkEvidence('iss-1');
    expect(strict).toBe(open);
  });

  it('returns null for a decompose parent, as the gate does', async () => {
    setup([{ id: 'edge-1' }]);
    expect(await missingWorkEvidenceStrict('iss-1')).toBeNull();
  });

  it('RAISES where the fail-open one answers `met`', async () => {
    const { db } = await import('../db/client.js');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    const original = (db as any).select;
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = () => {
      throw new Error('connection reset');
    };
    await expect(missingWorkEvidenceStrict('iss-1')).rejects.toThrow('connection reset');
    expect(await findMissingWorkEvidence('iss-1')).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = original;
  });
});
