/**
 * ISS-900 (FB-479, agenfold, 2026-11-02) — a requirement on a project whose production names no
 * commit it serves counts a verdict on the release version its agent recorded. agenfold's owner rule
 * `release-is-the-agents-record` says Forge never checks or matches a commit: a release is an explicit
 * version in the record, the tag and what the app reports. So its `/healthz` reports only `version`,
 * its production declares no source probe, and coverage, which placed a verdict only under the commit
 * a source probe read, counted nothing: REQ-11 BC-1..7, judged pass on production 0.76.0, read
 * `{ judged: 0, passing: 0 }`, and the steward kept asking the master to judge them again.
 *
 * Planted here as agenfold stands: production deployed outside Forge with no source probe, a release
 * recorded by its agent at 0.76.0 closing the issue that traces the criteria, and the requirement's
 * criteria judged at the requirement on release 0.76.0. Through the app's own routes, against real
 * Postgres; nothing reads production.
 *
 * @direct-test-of packages/core/src/release-batch/released-line.ts
 * @direct-test-of packages/core/src/requirements/standing-coverage.ts
 * @direct-test-of packages/core/src/requirements/standing-facts.ts
 * @direct-test-of packages/core/src/requirements/standing-identity.ts
 * @direct-test-of packages/core/src/requirements/standing-proof.ts
 * @direct-test-of packages/core/src/requirements/standing-shipped.ts
 * @direct-test-of packages/core/src/requirements/verdict-rules.ts
 * @direct-test-of packages/core/src/requirements/verdicts.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { bindTestRunner, createTestDevice } from '../helpers/factories.js';
import { agreedRequirement, traced } from '../helpers/landed-requirement.js';
import {
  BRANCH,
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

// a coverage read that reaches for production is the defect the owner's rule forbids: each read counts
vi.mock('../../src/release-batch/verify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/verify.js')>()),
  readLiveState: async () => {
    reads.n += 1;
    throw new Error('a requirement coverage read asked production (readLiveState)');
  },
}));

const ACCOUNT = 'agenfold-deploy shipped tag v0.76.0 to production; /healthz reports 0.76.0.';
const CLIP = 'https://agenfold.example.test/clips/req-11.webm';
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
    defaultBranch: BRANCH,
    environments: {
      production: {
        tier: 'production',
        deploysFrom: BRANCH,
        deployment: { mode: 'external', target: 'agenfold-deploy' },
        ...(probe ? { verification: { runtime: [PROBE] } } : {}),
      },
    } as never,
    extra: { delivery: { verdictsRequired: false } } as never,
  });
}

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(world.token, method, `/api/projects/${world.projectId}${path}`, body);

const recordRelease = async (issueIds: string[], version: string) => {
  const res = await onProject('POST', '/release-records', {
    issueIds,
    version,
    account: ACCOUNT,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.failed).toEqual([]);
};

const judge = (req: string, criterion: string, identity: Record<string, unknown>) =>
  onProject('POST', `/requirements/${req}/verdicts`, {
    criterion,
    verdict: 'pass',
    identity,
    evidence: [CLIP],
  });

type Said = { key: string; vars?: Record<string, unknown> };
type ReleaseRead = {
  standing: {
    delivery: { criteriaCoverage: Record<string, number> };
    coverage: Array<{
      code: string;
      verdict: string;
      why: string | null;
      verdicts: Array<{ identity: string | null; notCounted: string | null; inLiveBuild: unknown }>;
      counts: { source: string; identity: string } | null;
    }>;
    waitingOn: { says: { who: Said; act: Said; rule: Said } } | null;
  };
};

const readOf = async (req: string) =>
  (await ok(onProject('GET', `/requirements/${req}`))) as unknown as ReleaseRead;

/** agenfold's REQ-11 at its first release: ISS-1 traces BC-1..3 and shipped in 0.76.0. */
async function shippedAt076(): Promise<string> {
  const req = await agreedRequirement(BCS);
  const issue = await landedIssue(1, F4);
  await traced(req, issue, 1, { 1: 'BC-1', 2: 'BC-2', 3: 'BC-3' });
  // the issue's own passes, at the commit it landed as: agenfold's judge recorded these too
  await judgedAll(issue, F4);
  await recordRelease([issue], 'v0.76.0');
  expect(await statusOf(issue)).toBe('closed');
  return req;
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

describe('a project whose production names no commit counts verdicts on the release version (ISS-900)', () => {
  it('counts every criterion judged at the requirement on release 0.76.0, and asks for no judgement', async () => {
    await agenfold();
    const req = await shippedAt076();
    for (const bc of ['BC-1', 'BC-2', 'BC-3']) {
      const res = await judge(req, bc, { kind: 'release', version: 'v0.76.0' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    const read = await readOf(req);
    expect(read.standing.delivery.criteriaCoverage).toEqual({ criteria: 3, passing: 3, judged: 3 });
    for (const bc of read.standing.coverage) {
      expect(bc.verdict, bc.code).toBe('passing');
      expect(bc.counts).toMatchObject({ source: 'requirement', identity: 'release 0.76.0' });
      expect(bc.verdicts[0]).toMatchObject({ identity: 'release 0.76.0', notCounted: null });
    }
    // nothing re-asks: no turn names a judgement
    expect(JSON.stringify(read.standing)).not.toContain('standing.act.judge');
    expect(reads.n).toBe(0);
  });

  it('asks once for the release judgement on the issue that can carry it, never for one that cannot count', async () => {
    await agenfold();
    const req = await shippedAt076();
    // what agenfold could send before: a commit, which nothing on this project places
    const res = await judge(req, 'BC-1', { kind: 'commit', sha: F4 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const read = await readOf(req);
    expect(read.standing.delivery.criteriaCoverage).toEqual({ criteria: 3, passing: 0, judged: 0 });
    const [bc1] = read.standing.coverage;
    expect(bc1?.verdicts[0]?.notCounted).toContain('judge it on release 0.76.0');
    // ISS-1 traces every BC and carries a verdict on a release (ISS-900 part 2): the judge judges there
    expect(read.standing.waitingOn?.says.act).toEqual({
      key: 'standing.act.judgeOnReleaseOn',
      vars: { codes: 'BC-1, BC-2, BC-3', keys: 'ISS-1', version: '0.76.0' },
    });
    expect(JSON.stringify(read.standing)).not.toContain('standing.act.judgeOn"');
    expect(reads.n).toBe(0);
  });

  it('keeps counting 0.76.0 under a later release, and not under one recorded later at a lower version', async () => {
    await agenfold();
    const req = await shippedAt076();
    await ok(judge(req, 'BC-1', { kind: 'release', version: '0.76.0' }));

    await recordRelease([await landedIssue(2, F4)], '0.77.0');
    let [bc1] = (await readOf(req)).standing.coverage;
    expect(bc1?.verdict).toBe('passing');
    expect(bc1?.verdicts[0]?.identity).toBe('release 0.76.0, carried by live release 0.77.0');

    // a hotfix line recorded after it at a lower version: nothing says it carries 0.76.0
    await recordRelease([await landedIssue(3, F4)], '0.75.1');
    [bc1] = (await readOf(req)).standing.coverage;
    expect(bc1?.verdict).toBe('not_live');
    expect(bc1?.verdicts[0]?.inLiveBuild).toBe(false);
    expect(bc1?.verdicts[0]?.notCounted).toContain('release 0.75.1');
  });

  it('refuses a release no record on this project shipped, by name', async () => {
    await agenfold();
    const req = await shippedAt076();
    const res = await judge(req, 'BC-1', { kind: 'release', version: '0.80.0' });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(refusalsOf(res.body)).toEqual([
      expect.objectContaining({
        code: 'REQUIREMENT_VERDICT_RELEASE_UNKNOWN',
        path: '/identity/version',
        detail: expect.stringContaining('0.76.0'),
      }),
    ]);
    const shape = await judge(req, 'BC-1', { kind: 'release', version: 'latest' });
    expect(refusalsOf(shape.body)[0]?.code).toBe('REQUIREMENT_VERDICT_RELEASE_SHAPE');
  });

  it('with no release recorded, stops asking for a judgement and says why once', async () => {
    await agenfold();
    // a runner is bound, so the wait on the master reads as the master's (FB-77)
    await bindTestRunner(world.projectId, await createTestDevice(world.ownerId));
    // a capability that shipped before Forge recorded any release: no issue, nothing recorded
    const req = await agreedRequirement(BCS.slice(0, 1));
    const refused = await judge(req, 'BC-1', { kind: 'release', version: '0.76.0' });
    expect(refusalsOf(refused.body)[0]?.code).toBe('REQUIREMENT_VERDICT_RELEASE_UNKNOWN');
    await ok(judge(req, 'BC-1', { kind: 'commit', sha: F4 }));

    const read = await readOf(req);
    expect(read.standing.coverage[0]?.verdict).toBe('not_judged');
    expect(read.standing.waitingOn?.says.who.key).toBe('standing.who.master');
    expect(read.standing.waitingOn?.says.act.key).toBe('standing.act.recordRelease');
    expect(JSON.stringify(read.standing.waitingOn?.says.rule)).toContain(
      'requirements.rule.noReleaseRecorded',
    );
    expect(JSON.stringify(read.standing)).not.toContain('standing.act.judge');
  });
});

describe('a project whose production reads the commit it serves keeps weighing by commit (ISS-900)', () => {
  it('counts a commit the live build holds, and refuses a release identity by name', async () => {
    await agenfold(true);
    unplant = plantLiveBuild(F4);
    const req = await agreedRequirement(BCS.slice(0, 1));
    const refused = await judge(req, 'BC-1', { kind: 'release', version: '0.76.0' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refusalsOf(refused.body)[0]).toMatchObject({
      code: 'REQUIREMENT_VERDICT_RELEASE_UNUSED',
      path: '/identity/kind',
    });

    await ok(judge(req, 'BC-1', { kind: 'commit', sha: F4 }));
    const [bc1] = (await readOf(req)).standing.coverage;
    expect(bc1?.verdict).toBe('passing');
    expect(bc1?.verdicts[0]).toMatchObject({
      identity: `commit ${F4.slice(0, 12)}`,
      notCounted: null,
    });
  });
});
