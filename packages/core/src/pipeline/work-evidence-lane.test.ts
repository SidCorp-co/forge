/**
 * ISS-1384 — the work-evidence gate reads the issue's lane: its own declaration before its
 * project's kind, and on `outside_git` the landing a mark names. `work-evidence.test.ts` holds the
 * rest of the gate; this file is the lane's half, split on size grounds.
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

const { collectWorkEvidence, hasCodeEvidence, findMissingWorkEvidence } = await import(
  './work-evidence.js'
);

function setup(...batches: unknown[][]) {
  queue.length = 0;
  queue.push(...batches);
}

describe('the refusal names the lane that decided it', () => {
  it("names the issue's own declaration, not the project's kind, where the issue declared outside git", async () => {
    setup(
      [],
      [],
      [],
      [
        {
          sessionContext: null,
          baseBranch: 'main',
          releaseChain: [],
          projectKind: 'standard',
          declaredLandingShape: 'outside_git',
        },
      ],
    );
    const detail = await findMissingWorkEvidence('iss-1');
    expect(detail).toContain('`mark_merged` carrying `data.landing`');
    expect(detail).toContain("This issue's work lands outside git (declared on the issue");
    expect(detail).not.toContain('data.commit');
    expect(detail).not.toContain('kind `website`');
  });
  it('tells a git lane how an issue whose change lands no file declares it', async () => {
    setup(
      [],
      [],
      [],
      [{ sessionContext: null, baseBranch: 'main', releaseChain: [], projectKind: 'standard' }],
    );
    expect(await findMissingWorkEvidence('iss-1')).toContain('`landingShape: outside_git`');
  });
});

describe('a landing on an outside-git lane (ISS-1384)', () => {
  const LANDING = 'coolify://staging/api — environment variables, redeployed';
  const marked = { sessionContext: null, mergedAt: new Date(), mergedLanding: LANDING };

  it.each([
    ['a website project', { projectKind: 'website' }],
    [
      'an issue declared outside git on a git project',
      { projectKind: 'standard', declaredLandingShape: 'outside_git' },
    ],
  ])('counts as evidence on %s', async (_where, lane) => {
    setup([], [], [{ ...marked, baseBranch: 'main', releaseChain: [], ...lane }]);
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence.mergedLanding).toBe(LANDING);
    expect(hasCodeEvidence(evidence)).toBe(true);
  });

  it('is no evidence on a git lane, which records a commit and never a landing', async () => {
    setup([], [], [{ ...marked, baseBranch: 'main', releaseChain: [], projectKind: 'standard' }]);
    const evidence = await collectWorkEvidence('iss-1');
    expect(evidence.mergedLanding).toBeNull();
    expect(hasCodeEvidence(evidence)).toBe(false);
  });

  it('is no evidence where merged_at is empty: a landing with no mark is no mark', async () => {
    setup(
      [],
      [],
      [{ ...marked, mergedAt: null, baseBranch: 'main', releaseChain: [], projectKind: 'website' }],
    );
    expect(hasCodeEvidence(await collectWorkEvidence('iss-1'))).toBe(false);
  });
});
