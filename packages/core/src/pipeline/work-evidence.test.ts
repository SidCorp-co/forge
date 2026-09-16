/**
 * `collectWorkEvidence` / `hasCodeEvidence` / `hasChildIssues` /
 * `findMissingWorkEvidence` — ISS-786 child B: DB-side evidence that code
 * exists for an issue (no server-side git checkout is available).
 */

import { describe, expect, it, vi } from 'vitest';

// cm:why queued by call order: `hasChildIssues`'s edge read (via `findMissingWorkEvidence`), then
//   `collectWorkEvidence`'s 3 parallel reads in source order — jobs, handoffs, issue.sessionContext
const queue: unknown[][] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => {
      const tail = { where: () => ({ limit: async () => queue.shift() ?? [] }) };
      // cm:guard the chain must answer `innerJoin` as well as `where` — the issue read joins `projects` for the base/production branch, and a mock that only models `from().where()` fails every case in this file with a TypeError instead of the assertion it was written for.
      return { from: () => ({ ...tail, innerJoin: () => tail }) };
    },
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { collectWorkEvidence, hasCodeEvidence, hasChildIssues, findMissingWorkEvidence } =
  await import('./work-evidence.js');

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
      [{ sessionContext: { branch: 'ISS-1-foo' } }],
    );
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence).toEqual({
      implementationJobCount: 1,
      handoffCommitSha: 'abc123',
      handoffFilesModified: 1,
      branch: 'ISS-1-foo',
    });
  });

  it('the project base branch is NOT evidence — it names where work lands, not that any happened', async () => {
    setup([], [], [{ sessionContext: { branch: 'main' }, baseBranch: 'main', liveBranch: 'main' }]);
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
      [{ sessionContext: { branch: 'ISS-9-x' }, baseBranch: 'main', liveBranch: 'master' }],
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
      [{ sessionContext: null }],
    );
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence.implementationJobCount).toBe(1);
    expect(hasCodeEvidence(evidence)).toBe(false);
  });

  it('returns no evidence when nothing is recorded', async () => {
    setup([], [], [{ sessionContext: null }]);
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence).toEqual({
      implementationJobCount: 0,
      handoffCommitSha: null,
      handoffFilesModified: 0,
      branch: null,
    });
  });

  // cm:guard the spelling `forge claim --pushed` actually writes. A run driven by hand holds no `code`/`fix`/`drive` job and no step handoff, so its worklog branch is the ONLY evidence it has; read from `sessionContext.branch` alone the gate answers "no branch, commit or code handoff is recorded" about an issue whose branch it is holding. Measured on ISS-1003 2026-09-14, where `forge record merged` refused its own landed change. Delete the worklog spelling and this goes red.
  it('reads the branch a hand-driven run records, at sessionContext.worklog.branch', async () => {
    setup([], [], [{ sessionContext: { worklog: { branch: 'ISS-1003', head: 'abc1234' } } }]);
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence.branch).toBe('ISS-1003');
    expect(hasCodeEvidence(evidence)).toBe(true);
  });

  // cm:guard the base/production exclusion applies to the worklog spelling too, or the widening above hands the gate back exactly the claim ISS-786 built it to refuse.
  it('refuses the base branch in the worklog just as it does at the top level', async () => {
    setup(
      [],
      [],
      [
        {
          sessionContext: { worklog: { branch: 'main' } },
          baseBranch: 'main',
          liveBranch: 'release',
        },
      ],
    );
    expect((await collectWorkEvidence('iss-1')).branch).toBeNull();
  });

  it('ignores a blank sessionContext.branch string', async () => {
    setup([], [], [{ sessionContext: { branch: '' } }]);
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
      }),
    ).toBe(false);
  });
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
    setup([], [], [], [{ sessionContext: null }]);
    const detail = await findMissingWorkEvidence('iss-1');
    expect(detail).toContain('no branch, commit or code handoff');
    // cm:guard the remedy must name every field the reader accepts. It named `sessionContext.branch` alone while `collectWorkEvidence` also read the worklog, which sends a hand-driven run to change the field it had already filled — the refusal disagreeing with the check behind it.
    expect(detail).toContain('sessionContext.worklog.branch');
  });

  it('returns null when evidence exists', async () => {
    setup([], [], [], [{ sessionContext: { branch: 'ISS-1-foo' } }]);
    expect(await findMissingWorkEvidence('iss-1')).toBeNull();
  });

  // cm:guard a broken evidence check must never freeze a legitimate advance
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
