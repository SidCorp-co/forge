/**
 * ISS-900 part 2 (FB-479, agenfold, 2026-11-02) — an issue criterion judged on the release its agent
 * recorded counts, on the issue and for its requirement. agenfold's owner rule
 * `release-is-the-agents-record` rules out commit fields: production reports only a version and
 * declares no source probe. Part 1 let a verdict at the requirement name the release; the issue's own
 * door held `runtime` to 40-64 hex and knew no release, so ISS-1's verdicts at the commit it landed as
 * never counted, and the standing sent the judge from the issue to the requirement.
 *
 * Planted as agenfold stands: production deployed outside Forge with no source probe, a release
 * recorded by its agent at 0.76.0 closing the issue that traces REQ-11's criteria, and those criteria
 * judged on the issue on release 0.76.0. Through the app's own routes, against real Postgres; nothing
 * reads production.
 *
 * @direct-test-of packages/contracts/src/released-line.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-input.ts
 * @direct-test-of packages/core/src/issues/criteria-verdicts.ts
 * @direct-test-of packages/core/src/issues/verdict-standing.ts
 * @direct-test-of packages/core/src/issues/runtime-standing.ts
 * @direct-test-of packages/core/src/issues/released-line-reads.ts
 * @direct-test-of packages/core/src/requirements/standing-identity.ts
 * @direct-test-of packages/core/src/requirements/standing-facts.ts
 * @direct-test-of packages/core/src/requirements/standing-proof.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { agreedRequirement, traced } from '../helpers/landed-requirement.js';
import {
  F4,
  judgedAll,
  landedIssue,
  ok,
  refusalsOf,
  seedLandedWorld,
  statusOf,
  world,
} from '../helpers/landed-world.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const reads = vi.hoisted(() => ({ n: 0 }));

// a read that reaches for production is the defect the owner's rule forbids: each read counts
vi.mock('../../src/release-batch/verify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/verify.js')>()),
  readLiveState: async () => {
    reads.n += 1;
    throw new Error('an issue verdict read asked production (readLiveState)');
  },
}));

const ACCOUNT = 'agenfold-deploy shipped tag v0.76.0 to production; /healthz reports 0.76.0.';
const CLIP = 'https://agenfold.example.test/clips/iss-1.webm';
const PROBE = {
  type: 'http',
  url: 'https://agenfold.example.test/healthz',
  path: 'commit',
  identifies: 'source',
} as const;

const BCS = [
  'A member opens the workspace',
  'A workspace lists its folds',
  'An empty workspace says so',
];

/** agenfold's document: production deployed outside Forge, reporting a version and no commit. */
async function agenfold(probe = false): Promise<void> {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'release/stg',
    environments: {
      production: {
        tier: 'production',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external', target: 'agenfold-deploy' },
        ...(probe ? { verification: { runtime: [PROBE] } } : {}),
      },
    } as never,
    extra: { delivery: { verdictsRequired: true } } as never,
  });
}

const recordRelease = async (issueIds: string[], version: string) => {
  const res = await api(world.token, 'POST', `/api/projects/${world.projectId}/release-records`, {
    issueIds,
    version,
    account: ACCOUNT,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

const judge = (issueId: string, criterion: number, identity: Record<string, unknown>) =>
  api(world.token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion,
    verdict: 'pass',
    reason: 'Opened the workspace on production 0.76.0.',
    identity,
    evidence: [CLIP],
  });

type Weighing = { earned: boolean | null; standing: string | null; reason: string };

/** Each live criterion's `weighing`, by its number, as the issue's criteria read answers it. */
async function weighed(issueId: string): Promise<Map<number, Weighing>> {
  const body = await ok(api(world.token, 'GET', `/api/issues/${issueId}/criteria`));
  const criteria = body.criteria as Array<{ n: number; weighing?: Weighing }>;
  return new Map(criteria.map((c) => [c.n, c.weighing as Weighing]));
}

type Said = { key: string; vars?: Record<string, unknown> };
type CoverageRead = {
  standing: {
    delivery: { criteriaCoverage: Record<string, number> };
    coverage: Array<{
      code: string;
      verdict: string;
      issues: Array<{ identity: string | null; notCounted: string | null }>;
      counts: { source: string; identity: string } | null;
    }>;
    waitingOn: { says: { who: Said; act: Said; rule: Said } } | null;
  };
};

const coverageOf = async (req: string) =>
  (await ok(
    api(world.token, 'GET', `/api/projects/${world.projectId}/requirements/${req}`),
  )) as unknown as CoverageRead;

/** agenfold's REQ-11 at its first release: ISS-1 traces BC-1..3, landed at F4, shipped in 0.76.0. */
async function shippedAt076(): Promise<{ req: string; issue: string }> {
  const req = await agreedRequirement(BCS);
  const issue = await landedIssue(1, F4);
  await traced(req, issue, 1, { 1: 'BC-1', 2: 'BC-2', 3: 'BC-3' });
  await recordRelease([issue], 'v0.76.0');
  expect(await statusOf(issue)).toBe('closed');
  return { req, issue };
}

let unplant: (() => void) | null = null;

beforeEach(async () => {
  await seedLandedWorld();
  reads.n = 0;
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

describe('an issue criterion judged on a release counts where production names no commit (ISS-900)', () => {
  it('counts each criterion judged pass on release 0.76.0 on the issue and in the requirement', async () => {
    await agenfold();
    const { req, issue } = await shippedAt076();
    for (const n of [1, 2, 3]) {
      const res = await judge(issue, n, { kind: 'release', version: 'v0.76.0' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    const criteria = await ok(api(world.token, 'GET', `/api/issues/${issue}/criteria`));
    const rows = criteria.criteria as Array<{ latest: Record<string, unknown> }>;
    expect(rows[0]?.latest).toMatchObject({ identityKind: 'release', releaseVersion: '0.76.0' });

    // the issue's weighing, as the release hold weighs it
    const read = await weighed(issue);
    for (const n of [1, 2, 3]) {
      expect(read.get(n), `criterion ${n}`).toMatchObject({ earned: true, standing: 'stands' });
      expect(read.get(n)?.reason).toContain('release 0.76.0');
    }

    // the requirement's coverage counts the issue's verdicts
    const { standing } = await coverageOf(req);
    expect(standing.delivery.criteriaCoverage).toEqual({ criteria: 3, passing: 3, judged: 3 });
    for (const bc of standing.coverage) {
      expect(bc.verdict, bc.code).toBe('passing');
      expect(bc.counts).toMatchObject({ source: 'issue', identity: 'release 0.76.0' });
      expect(bc.issues[0]).toMatchObject({ identity: 'release 0.76.0', notCounted: null });
    }
    expect(JSON.stringify(standing)).not.toContain('standing.act.judge');
    expect(reads.n).toBe(0);
  });

  it('sends the judge to the issue on the live release, never to the requirement, where the issue can carry it', async () => {
    await agenfold();
    const { req, issue } = await shippedAt076();
    // what agenfold could send before: its passes at the commit it landed as, which nothing places
    await judgedAll(issue, F4);

    const read = await weighed(issue);
    expect(read.get(1)?.earned).not.toBe(true);
    const { standing } = await coverageOf(req);
    expect(standing.delivery.criteriaCoverage).toMatchObject({ passing: 0 });
    expect(standing.coverage[0]?.issues[0]?.notCounted).toContain(
      "{ kind: 'release', version: '0.76.0' }` on the issue",
    );
    expect(standing.waitingOn?.says.act).toEqual({
      key: 'standing.act.judgeOnReleaseOn',
      vars: { codes: 'BC-1, BC-2, BC-3', keys: 'ISS-1', version: '0.76.0' },
    });
    expect(JSON.stringify(standing)).not.toContain('at the requirement');
    expect(reads.n).toBe(0);
  });

  it('refuses a malformed version and one no record on this project shipped, by name', async () => {
    await agenfold();
    const { issue } = await shippedAt076();
    const shape = await judge(issue, 1, { kind: 'release', version: 'latest' });
    expect(shape.status, JSON.stringify(shape.body)).toBe(422);
    expect(refusalsOf(shape.body)[0]).toMatchObject({
      code: 'VERDICT_RELEASE_SHAPE',
      path: '/identity/version',
    });
    const unknown = await judge(issue, 1, { kind: 'release', version: '0.80.0' });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(422);
    expect(refusalsOf(unknown.body)[0]).toMatchObject({
      code: 'VERDICT_RELEASE_UNKNOWN',
      path: '/identity/version',
      detail: expect.stringContaining('0.76.0'),
    });
  });
});

describe('a project whose production reads the commit it serves refuses a release identity (ISS-900)', () => {
  it('refuses it by name, where a commit is what a verdict names', async () => {
    await agenfold(true);
    unplant = plantLiveBuild(F4);
    const issue = await landedIssue(1, F4);
    const res = await judge(issue, 1, { kind: 'release', version: '0.76.0' });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(refusalsOf(res.body)[0]).toMatchObject({
      code: 'VERDICT_RELEASE_UNUSED',
      path: '/identity/kind',
    });
  });
});
