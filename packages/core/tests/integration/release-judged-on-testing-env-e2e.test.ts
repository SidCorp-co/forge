/**
 * A release is ready for its owner only when its criteria hold on the project's testing environment
 * (REQ-36 r6 BC-18..BC-20). Planted from catalog-api 0.2.0 on 2026-10-27: it read 26/26 proven,
 * every pass a commit verdict at dcb7114b judged locally, while its dev environment still served
 * 2026-10-14 code; and from catalog-fe ISS-23 the same day, whose judge's `runtime: a36f27ef…` on
 * deployed dev was refused VERDICT_RUNTIME_UNOBSERVED because the project declares no production.
 *
 * Driven through the record door, the verdict door, the releases read and the release page against
 * real Postgres, on the landed world (`helpers/landed-world.ts`), whose document declares
 * `release/stg` and no production environment, here with a `dev` environment beside it.
 *
 * @direct-test-of packages/core/src/release-batch/release-facts.ts
 * @direct-test-of packages/core/src/release-batch/release-view.ts
 * @direct-test-of packages/core/src/release-page/claims.ts
 * @direct-test-of packages/core/src/issues/criteria/unobserved-runtime.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { agreedRequirement, bcOf, traced } from '../helpers/landed-requirement.js';
import {
  BRANCH,
  F4,
  judgedAll,
  landedIssue,
  ok,
  record,
  seedLandedWorld,
  world,
} from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

vi.mock('../../src/release-batch/shipped-earlier.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/shipped-earlier.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

/** catalog-api's own environment on dev: tier dev, deployed on land, no serving probe. */
const DEV = {
  dev: {
    tier: 'dev' as const,
    deploysFrom: BRANCH,
    deployment: { mode: 'external' as const },
    url: 'https://catalog-dev-api.example.test',
  },
};

/** catalog-api's document on dev, with or without naming `dev` as where its releases are judged. */
async function declare(judgedOn: string | null) {
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: DEV,
    defaultBranch: BRANCH,
    extra: {
      delivery: { verdictsRequired: true, ...(judgedOn ? { judgedOn } : {}) },
      release: { approval: { required: true }, changeRequests: false },
    },
  });
}

/** The judge's verdict on criterion `n` through the verdict route, as QA writes it. */
const judged = (issueId: string, n: number, identity: Record<string, string>) =>
  api(world.token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: n,
    verdict: 'pass',
    reason: `Ran it on dev at ${F4.slice(0, 7)}.`,
    identity,
  });

type Criterion = { n: number; proven: boolean; standing: string; unverified: string | null };
type Release = {
  version: string;
  runId: string;
  state: string;
  verified: { proven: number; total: number; level: string; judgedOn: string | null };
  waitingOn: { kind: string; act: string; rule: string };
  issueCriteria: Array<{ key: string; criteria: Criterion[] }>;
};

async function release(version: string): Promise<Release> {
  const body = await ok(
    api(world.token, 'GET', `/api/projects/${world.projectId}/releases/${version}`),
  );
  return (body.release ?? body) as Release;
}

/** One issue landed at F4 on `release/stg`, its three criteria passed at that commit, recorded. */
async function landedOnCommitVerdicts(): Promise<{ issue: string; version: string }> {
  const issue = await landedIssue(5, F4);
  await judgedAll(issue, F4);
  const res = await record([issue], F4);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { issue, version: String(res.body.version) };
}

const NOT_JUDGED_ON_DEV = `Not judged on dev: a release of this project is proven only by a pass judged on the build dev serves at ${F4.slice(0, 12)}`;

describe('a project that names dev as its testing environment (BC-18, BC-19)', () => {
  beforeEach(async () => {
    await seedLandedWorld();
    await declare('dev');
  });

  it('lands on commit verdicts, which still gate the merge, and reads not judged on dev', async () => {
    const { version } = await landedOnCommitVerdicts();
    const r = await release(version);

    expect(r.state).toBe('landed');
    expect(r.verified).toMatchObject({
      proven: 0,
      total: 3,
      level: 'some_criteria',
      judgedOn: 'dev',
    });
    const criteria = r.issueCriteria.flatMap((i) => i.criteria);
    expect(criteria.map((c) => c.proven)).toEqual([false, false, false]);
    for (const c of criteria) expect(c.unverified).toContain(NOT_JUDGED_ON_DEV);
    // the owner's review is not theirs yet: the judge owes it on dev
    expect(r.waitingOn).toMatchObject({
      kind: 'agent',
      act: `judge ${version} on dev`,
      rule: 'Not judged on dev: 0 of 3 criteria pass there',
    });
  });

  // catalog-fe ISS-23: `runtime: a36f27ef…` on deployed dev, refused VERDICT_RUNTIME_UNOBSERVED
  it('takes a runtime verdict at the served commit, uncorroborated, and the release is ready for review', async () => {
    const { issue, version } = await landedOnCommitVerdicts();

    for (const n of [1, 2, 3]) {
      const res = await judged(issue, n, { kind: 'runtime', ref: F4 });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const r = await release(version);

    expect(r.verified).toMatchObject({ proven: 3, total: 3, level: 'criteria', judgedOn: 'dev' });
    expect(r.issueCriteria.flatMap((i) => i.criteria).every((c) => c.proven)).toBe(true);
    expect(r.waitingOn).toMatchObject({
      kind: 'you',
      act: `review ${version} and promote it to production`,
    });
  });

  it('counts no runtime verdict at a build other than the one the release ships', async () => {
    const { issue, version } = await landedOnCommitVerdicts();
    const elsewhere = 'c'.repeat(40);

    for (const n of [1, 2, 3]) await ok(judged(issue, n, { kind: 'runtime', ref: elsewhere }));

    expect((await release(version)).verified).toMatchObject({ proven: 0, total: 3 });
  });

  it("lists the release page's criteria as known issues not judged on dev, then proven", async () => {
    const { issue, version } = await landedOnCommitVerdicts();
    const page = async () =>
      ok(
        api(
          world.token,
          'GET',
          `/api/projects/${world.projectId}/releases/${version}/page?view=developer`,
        ),
      );

    const before = (await page()) as {
      header: { verified: { proven: number; judgedOn: string | null } };
      knownIssues: Array<{ standing: string; reason: string | null }>;
    };
    expect(before.header.verified).toMatchObject({ proven: 0, judgedOn: 'dev' });
    expect(before.knownIssues).toHaveLength(3);
    expect(before.knownIssues[0]).toMatchObject({ standing: 'not_judged' });
    expect(before.knownIssues[0]?.reason).toContain(NOT_JUDGED_ON_DEV);

    for (const n of [1, 2, 3]) await ok(judged(issue, n, { kind: 'runtime', ref: F4 }));

    const after = (await page()) as typeof before;
    expect(after.header.verified).toMatchObject({ proven: 3, judgedOn: 'dev' });
    expect(after.knownIssues).toEqual([]);
  });

  it("keeps a requirement's coverage when the judge's newest verdict is the runtime one on dev", async () => {
    const req = await agreedRequirement();
    const { issue } = await landedOnCommitVerdicts();
    await traced(req, issue, 5);

    await ok(judged(issue, 1, { kind: 'runtime', ref: F4 }));

    const bc = await bcOf(req);
    expect(bc.issues[0]?.notCounted ?? null).toBeNull();
    expect(bc.verdict).toBe('passing');
  });

  it("counts no runtime verdict at another build in a requirement's coverage", async () => {
    const req = await agreedRequirement();
    const issue = await landedIssue(5, F4);
    await traced(req, issue, 5);
    const elsewhere = 'c'.repeat(40);

    await ok(judged(issue, 1, { kind: 'runtime', ref: elsewhere }));

    const bc = await bcOf(req);
    expect(bc.issues[0]?.notCounted).toContain(`judged at commit ${elsewhere.slice(0, 12)}`);
    expect(bc.issues[0]?.notCounted).toContain(`not at its issue's landing ${F4.slice(0, 12)}`);
  });

  it('weighs a runtime verdict on dev at the landing it names, at the record door and in coverage', async () => {
    const req = await agreedRequirement();
    const issue = await landedIssue(5, F4);
    await traced(req, issue, 5);
    for (const n of [1, 2, 3]) await ok(judged(issue, n, { kind: 'runtime', ref: F4 }));

    const res = await record([issue], F4);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const bc = await bcOf(req);
    expect(bc.issues[0]?.notCounted ?? null).toBeNull();
    expect(bc.verdict).toBe('passing');
    expect((await release(String(res.body.version))).verified).toMatchObject({
      proven: 3,
      total: 3,
    });
  });
});

describe('a project that names no testing environment (BC-20)', () => {
  beforeEach(async () => {
    await seedLandedWorld();
    await declare(null);
  });

  it('counts the commit verdicts at the release build as proven, as before', async () => {
    const { version } = await landedOnCommitVerdicts();
    const r = await release(version);

    expect(r.verified).toMatchObject({ proven: 3, total: 3, level: 'criteria', judgedOn: null });
    expect(r.waitingOn).toMatchObject({
      kind: 'you',
      act: `review ${version} and promote it to production`,
    });
  });

  it('still refuses a runtime verdict by name, as catalog-fe ISS-23 was refused', async () => {
    const issue = await landedIssue(5, F4);

    const res = await judged(issue, 1, { kind: 'runtime', ref: F4 });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusals = (
      res.body as { error?: { refusals?: Array<{ code: string; detail: string }> } }
    ).error?.refusals;
    expect(refusals?.map((r) => r.code)).toEqual(['VERDICT_RUNTIME_UNOBSERVED']);
    expect(refusals?.[0]?.detail).toContain('names no testing environment');
    expect(refusals?.[0]?.detail).toContain('`delivery.judgedOn`');
  });
});
