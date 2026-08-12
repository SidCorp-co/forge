/**
 * `collectWorkEvidence` / `hasCodeEvidence` / `isDecomposeParent` /
 * `findMissingWorkEvidence` — ISS-786 child B: DB-side evidence that code
 * exists for an issue (no server-side git checkout is available).
 */

import { describe, expect, it, vi } from 'vitest';

// cm:why queued by call order: `isDecomposeParent`'s edge read (via `findMissingWorkEvidence`), then
//   `collectWorkEvidence`'s 3 parallel reads in source order — jobs, handoffs, issue.sessionContext
const queue: unknown[][] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => queue.shift() ?? [],
        }),
      }),
    }),
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { collectWorkEvidence, hasCodeEvidence, isDecomposeParent, findMissingWorkEvidence } =
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

describe('isDecomposeParent', () => {
  it('true when an outgoing decomposes edge exists', async () => {
    setup([{ id: 'edge-1' }]);
    expect(await isDecomposeParent('iss-1')).toBe(true);
  });

  it('false when no decomposes edge exists', async () => {
    setup([]);
    expect(await isDecomposeParent('iss-1')).toBe(false);
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
