/**
 * ISS-900 part 3 (agenfold, 2026-11-02, on d51e3ff5d) — a release's criteria count and verified level
 * read a criterion judged on a release. agenfold's owner rule `release-is-the-agents-record` rules out
 * commit fields: production reports only a version, and every release is its agent's record by
 * version. REQ-11's issue verdicts on release 0.76.0 counted for the requirement (7/7), yet
 * `GET …/releases/0.76.0` and `…/releases/0.78.0` read criteria 0/0, verified level `none`: neither
 * roster carries REQ-11's issues, which an earlier release shipped, and a release counted only the
 * criteria of the issues it carries.
 *
 * Planted as agenfold stands: ISS-1, tracing REQ-11, shipped in 0.75.0; 0.76.0 and 0.78.0 carry only
 * issues with no criteria; ISS-1 judged on 0.76.0. A criterion judged on 0.76.0 belongs to 0.76.0 and
 * is carried by the live 0.78.0, as the release record says; 0.75.0, which shipped before it was
 * judged and carries no later release, does not count it. Through the app's own routes, against real
 * Postgres; nothing reads production.
 *
 * @direct-test-of packages/core/src/release-batch/judged-on-release.ts
 * @direct-test-of packages/core/src/release-batch/release-facts.ts
 * @direct-test-of packages/core/src/release-batch/release-read-views.ts
 * @direct-test-of packages/core/src/release-batch/released-line.ts
 * @direct-test-of packages/contracts/src/released-line.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { agreedRequirement, traced } from '../helpers/landed-requirement.js';
import { F4, landedIssue, ok, seedLandedWorld, world } from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const reads = vi.hoisted(() => ({ n: 0 }));

// a release read that reaches for production is the defect the owner's rule forbids: each read counts
vi.mock('../../src/release-batch/verify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/verify.js')>()),
  readLiveState: async () => {
    reads.n += 1;
    throw new Error('a release read asked production (readLiveState)');
  },
}));

const ACCOUNT = 'agenfold-deploy shipped this tag to production; /healthz reports it.';

/** agenfold's document: production deployed outside Forge, reporting a version and no commit. */
async function agenfold(): Promise<void> {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'release/stg',
    environments: {
      production: {
        tier: 'production',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external', target: 'agenfold-deploy' },
      },
    } as never,
    extra: { delivery: { verdictsRequired: false } } as never,
  });
}

const recordRelease = (issueIds: string[], version: string) =>
  ok(
    api(world.token, 'POST', `/api/projects/${world.projectId}/release-records`, {
      issueIds,
      version,
      account: ACCOUNT,
    }),
  );

type Verified = { level: string; proven: number; total: number };
type ReleaseRead = {
  criteria: { proven: number; total: number };
  verified: Verified;
  issueCriteria: Array<{ key: string; criteria: Array<{ identity: string | null }> }>;
};

const releaseOf = async (version: string) =>
  (await ok(api(world.token, 'GET', `/api/projects/${world.projectId}/releases/${version}`)))
    .release as unknown as ReleaseRead;

beforeEach(async () => {
  await seedLandedWorld();
  reads.n = 0;
});

describe('a release reads a criterion judged on a release it is or carries (ISS-900)', () => {
  it('counts ISS-1 judged on 0.76.0 on 0.76.0 and on the live 0.78.0, though 0.75.0 shipped it', async () => {
    await agenfold();
    const req = await agreedRequirement([
      'A member opens the workspace',
      'A workspace lists its folds',
    ]);
    const iss1 = await landedIssue(1, F4, [
      'A member opens the workspace',
      'A workspace lists its folds',
    ]);
    await traced(req, iss1, 1, { 1: 'BC-1', 2: 'BC-2' });
    await recordRelease([iss1], '0.75.0');
    await recordRelease([await landedIssue(2, F4, [])], '0.76.0');
    for (const n of [1, 2]) {
      await ok(
        api(world.token, 'POST', `/api/issues/${iss1}/verdicts`, {
          criterion: n,
          verdict: 'pass',
          reason: 'Opened the workspace on production 0.76.0.',
          identity: { kind: 'release', version: '0.76.0' },
          evidence: ['https://agenfold.example.test/clips/req-11.webm'],
        }),
      );
    }
    await recordRelease([await landedIssue(3, F4, [])], '0.78.0');

    for (const version of ['0.76.0', '0.78.0']) {
      const release = await releaseOf(version);
      expect(release.criteria, version).toMatchObject({ proven: 2, total: 2 });
      expect(release.verified, version).toMatchObject({ level: 'criteria', proven: 2, total: 2 });
      const iss = release.issueCriteria.find((i) => i.key === 'ISS-1');
      expect(
        iss?.criteria.map((c) => c.identity),
        version,
      ).toEqual(['release 0.76.0', 'release 0.76.0']);
    }

    // 0.75.0 shipped ISS-1 before it was judged, and carries no later release: not proven there
    const earlier = await releaseOf('0.75.0');
    expect(earlier.criteria).toMatchObject({ proven: 0, total: 2 });
    expect(earlier.verified.level).toBe('some_criteria');
    expect(reads.n).toBe(0);
  });
});
