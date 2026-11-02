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
 * @direct-test-of packages/core/src/release-page/facts.ts
 * @direct-test-of packages/core/src/release-batch/judged-before-reopen.ts
 * @direct-test-of packages/core/src/release-page/claims.ts
 * @direct-test-of packages/contracts/src/release-page.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reopenOnFail } from '../../src/issues/fail-reopen.js';
import { api } from '../helpers/api.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { agreedRequirement, traced } from '../helpers/landed-requirement.js';
import { F4, landedIssue, ok, seedLandedWorld, statusOf, world } from '../helpers/landed-world.js';
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
  criteria: { proven: number; failing?: number; total: number };
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

  it("claims on a release's page each criterion judged on that release, though it names no build", async () => {
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
    for (const n of [1, 2]) {
      await ok(
        api(world.token, 'POST', `/api/issues/${iss1}/verdicts`, {
          criterion: n,
          verdict: 'pass',
          reason: 'Opened the workspace on production 0.75.0.',
          identity: { kind: 'release', version: '0.75.0' },
          evidence: ['https://agenfold.example.test/clips/req-11.webm'],
        }),
      );
    }
    const page = (await ok(
      api(world.token, 'GET', `/api/projects/${world.projectId}/releases/0.75.0/page`),
    )) as unknown as {
      header: { verified: { proven: number; total: number } };
      requirements: Array<{ business: { proven: Array<{ code: string }> } }>;
    };
    expect(page.header.verified).toMatchObject({ proven: 2, total: 2 });
    expect(page.requirements[0]?.business.proven.map((p) => p.code)).toEqual(['BC-1', 'BC-2']);
    expect(reads.n).toBe(0);
  });

  // agenfold ISS-59 on 3d747ff16: its passes judged on 0.77.0 are carried by 0.78.0; a fail judged on
  // 0.78.0 reopened it, and its fix awaits a later release. The reopen voids the fail for the fix's
  // round, so 0.78.0 read 19/19, failing 0, though criterion 1 failed on it.
  it('reads a fail judged on a release as failing there and on every release until one ships the fix', async () => {
    await agenfold();
    const req = await agreedRequirement(['A fold opens', 'A fold saves']);
    const iss59 = await landedIssue(59, F4, ['A fold opens', 'A fold saves']);
    await traced(req, iss59, 59, { 1: 'BC-1', 2: 'BC-2' });
    await recordRelease([iss59], '0.77.0');
    const judge = (n: number, verdict: 'pass' | 'fail', version: string) =>
      ok(
        api(world.token, 'POST', `/api/issues/${iss59}/verdicts`, {
          criterion: n,
          verdict,
          reason: `${verdict === 'pass' ? 'Held' : 'Broke'} on production ${version}.`,
          identity: { kind: 'release', version },
          evidence: ['https://agenfold.example.test/clips/iss-59.webm'],
        }),
      );
    for (const n of [1, 2]) await judge(n, 'pass', '0.77.0');
    await recordRelease([await landedIssue(60, F4, [])], '0.78.0');
    const failed = await judge(1, 'fail', '0.78.0');
    // the fail-reopen consumer, as `verdict.recorded` runs it
    await reopenOnFail({
      criterion: 1,
      requirement: null,
      reason: 'Broke on production 0.78.0.',
      authorUserId: world.ownerId,
      authorDeviceId: null,
      agency: 'agent',
      issueId: iss59,
      verdictId: String((failed.verdict as { id?: string } | undefined)?.id ?? failed.id),
    });
    expect(await statusOf(iss59)).toBe('reopen');

    const live = await releaseOf('0.78.0');
    expect(live.criteria).toMatchObject({ proven: 1, failing: 1, total: 2 });
    expect(live.verified.level).toBe('some_criteria');
    const iss = live.issueCriteria.find((i) => i.key === 'ISS-59');
    expect(iss?.criteria.map((c) => c.identity)).toEqual(['release 0.78.0', 'release 0.77.0']);
    // 0.77.0 shipped before the fail and does not carry 0.78.0: it reads what was judged on it
    expect((await releaseOf('0.77.0')).criteria).toMatchObject({ proven: 2, total: 2 });
    // a later release without the fix still serves the failing criterion
    await recordRelease([await landedIssue(61, F4, [])], '0.79.0');
    expect((await releaseOf('0.79.0')).criteria).toMatchObject({ proven: 1, failing: 1, total: 2 });

    // the release that ships the fix judges it anew: the void holds there
    await seedIssueStatus(iss59, 'awaiting_release');
    await recordRelease([iss59], '0.80.0');
    const fixed = await releaseOf('0.80.0');
    const round = fixed.issueCriteria.find((i) => i.key === 'ISS-59');
    expect(round?.criteria.map((c) => c.identity)).toEqual([null, 'release 0.77.0']);
    expect(reads.n).toBe(0);
  });
});
