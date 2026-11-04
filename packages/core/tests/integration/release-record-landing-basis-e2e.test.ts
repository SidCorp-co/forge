/**
 * ISS-957 (FB-493, agenfold, 2026-11-04) — on a project whose production names no commit it serves
 * (no source probe: its releases are its agent's record by version, ISS-900), the automatic release
 * weighed every waiting issue on the release its record says is live. ISS-127, ISS-128 and ISS-142
 * landed after 0.121.0, which cannot hold them, so draft 0.123.0 asked for verdicts on 0.121.0 nobody
 * could honestly write, and held the release that would ship them for ever.
 *
 * Planted as agenfold stands: production deploys on land with no source probe, 0.121.0 recorded
 * shipped carrying an earlier issue, and an issue landed after it at `awaiting_release`. The release
 * weighs it at its landing; a criterion its design classes `observable`, which only the running
 * product shows, holds no release and is owed on the release that carries it once that ships.
 * Against real Postgres, through the app's routes where a route exists; nothing reads production.
 *
 * @direct-test-of packages/core/src/release-batch/criteria-basis.ts
 * @direct-test-of packages/core/src/release-batch/criteria-hold.ts
 * @direct-test-of packages/core/src/release-batch/criteria-weighing.ts
 * @direct-test-of packages/core/src/release-batch/landed-weighing.ts
 * @direct-test-of packages/core/src/release-batch/landed-build.ts
 * @direct-test-of packages/core/src/release-batch/released-line.ts
 * @direct-test-of packages/core/src/release-batch/hold.ts
 * @direct-test-of packages/core/src/release-batch/blocker-sentences.ts
 * @direct-test-of packages/core/src/release-batch/release-gates.ts
 * @direct-test-of packages/core/src/issues/criteria-standing.ts
 * @direct-test-of packages/core/src/requirements/standing-identity.ts
 * @direct-test-of packages/core/src/requirements/standing-coverage.ts
 * @direct-test-of packages/core/src/requirements/standing-facts.ts
 * @direct-test-of packages/contracts/src/released-line.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import type { ReleaseBlocker, ReleaseWarning } from '../../src/release-batch/blocker-sentences.js';
import { criteriaBasisOf, landingCriteriaReports } from '../../src/release-batch/criteria-basis.js';
import { criteriaHold } from '../../src/release-batch/criteria-hold.js';
import { landingCriteriaHold } from '../../src/release-batch/hold.js';
import { api } from '../helpers/api.js';
import { agreedRequirement, traced } from '../helpers/landed-requirement.js';
import { C1, F4, landedIssue, ok, seedLandedWorld, world } from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const reads = vi.hoisted(() => ({ n: 0 }));

// a read that reaches for production is the defect the owner's rule forbids: each read counts
vi.mock('../../src/release-batch/verify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/verify.js')>()),
  readLiveState: async () => {
    reads.n += 1;
    throw new Error('a criteria read asked production (readLiveState)');
  },
}));

const BRANCH = 'release/stg';
const CLIP = 'https://agenfold.example.test/clips/iss-957.webm';
const short = (sha: string) => sha.slice(0, 12);
const SERVING = {
  kind: 'undeclared',
  missing: 'production declares no source probe',
  route: 'declare one',
} as const;

/**
 * agenfold's document: production on `release/stg` with no source probe. `external` is how its agent
 * records a release by hand (`release-records`); `onLand` is the automatic release that drafts the
 * next one, which is what holds work.
 */
async function agenfold(deployment: 'external' | 'onLand'): Promise<void> {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: BRANCH,
    environments: {
      production: {
        tier: 'production',
        deploysFrom: BRANCH,
        deployment:
          deployment === 'external'
            ? { mode: 'external', target: 'agenfold-deploy' }
            : { binding: randomUUID(), trigger: 'on-land' },
      },
    } as never,
    extra: { delivery: { verdictsRequired: true } } as never,
  });
}

/** Records `version` shipped carrying `issueIds`, as agenfold's agent does, and arms the sweep. */
async function shipped(issueIds: string[], version: string): Promise<void> {
  await agenfold('external');
  const res = await api(world.token, 'POST', `/api/projects/${world.projectId}/release-records`, {
    issueIds,
    version,
    account: `agenfold-deploy shipped ${version}; /healthz reports ${version}.`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await agenfold('onLand');
}

const judge = (issueId: string, criterion: number, identity: Record<string, unknown>) =>
  api(world.token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion,
    verdict: 'pass',
    reason: 'Judged as the identity names.',
    identity,
    evidence: [CLIP],
    withoutClip: 'The planted run has no recorder; the clip cited is a placeholder.',
  });

/**
 * QA's pass on criterion `n`, at a commit or on a release, written as the door stores it: an
 * observable pass through the door also owes a kept probe, which is not what these tests are about.
 */
async function stored(issueId: string, n: number, at: { commit: string } | { release: string }) {
  const [criterion] = (await db.execute(sql`
    SELECT id FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
  `)) as unknown as Array<{ id: string }>;
  const kind = 'commit' in at ? 'commit' : 'release';
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    release_version, author_user_id, author_agency, judge)
    VALUES (${criterion?.id}, ${issueId}, 'pass', 'judged as the identity names', ${kind},
            ${'commit' in at ? at.commit : null}, ${'release' in at ? at.release : null},
            ${world.ownerId}, 'agent', 'qa')
  `);
}

/** Gives criterion `n` of `issueId` its class, as a recorded design holds it. */
async function designed(issueId: string, lines: Array<[number, string]>): Promise<void> {
  await db.execute(sql`
    INSERT INTO issue_designs (issue_id, project_id, revision, modules, contracts, recorded_by)
    VALUES (${issueId}, ${world.projectId}, 1, '{}'::uuid[], '{}'::text[], ${world.ownerId})
    ON CONFLICT (issue_id) DO NOTHING
  `);
  for (const [n, criterionClass] of lines) {
    await db.execute(sql`
      INSERT INTO issue_design_criteria (criterion_id, issue_id, criterion_class, pattern, proof)
      SELECT id, issue_id, ${criterionClass}, NULL, 'the probe that proves it'
        FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
    `);
  }
}

/** The automatic release's hold over `waiting`, as the release read and the sweep's gate run it. */
async function hold(waiting: string[]) {
  const out: ReleaseBlocker[] = [];
  const warnings: ReleaseWarning[] = [];
  await criteriaHold(world.projectId, waiting, out, warnings, SERVING);
  return { out, warnings };
}

type Weighing = { earned: boolean | null; reason: string; weighedOn: Record<string, unknown> };

async function weighed(issueId: string): Promise<Map<number, Weighing>> {
  const body = await ok(api(world.token, 'GET', `/api/issues/${issueId}/criteria`));
  const criteria = body.criteria as Array<{ n: number; weighing: Weighing }>;
  return new Map(criteria.map((c) => [c.n, c.weighing]));
}

/** 0.121.0 shipped carrying ISS-1 (landed at C1); ISS-2 landed after it at F4 and waits. */
async function landedAfterLive(): Promise<{ earlier: string; later: string }> {
  const earlier = await landedIssue(1, C1);
  await shipped([earlier], '0.121.0');
  const later = await landedIssue(2, F4);
  return { earlier, later };
}

beforeEach(async () => {
  await seedLandedWorld();
  reads.n = 0;
});

describe('an issue landed after the live release is weighed at its landing (ISS-957)', () => {
  it('reads the project as a landing basis, for the release record, not a promotion', async () => {
    await landedAfterLive();
    expect(await criteriaBasisOf(world.projectId)).toEqual({
      kind: 'landing',
      why: 'release-record',
      landsOn: BRANCH,
      deploysFrom: BRANCH,
    });
  });

  it('holds it on its landing commit, never on the live release that predates it', async () => {
    const { later } = await landedAfterLive();
    const { out } = await hold([later]);
    const held = out.find((b) => b.code === 'RELEASE_CRITERIA_UNEARNED');
    expect(held, JSON.stringify(out)).toBeDefined();
    expect(held?.details?.held).toEqual([
      expect.objectContaining({ displayId: 'ISS-2', criteria: [1, 2, 3], landing: F4 }),
    ]);
    expect(held?.message).toContain(`at its landing commit \`${short(F4)}\``);
    expect(held?.message).not.toContain('0.121.0');
    expect(held?.details).not.toHaveProperty('release');

    // the sweep's own hold on the row says the same, and names the reason
    const basis = await criteriaBasisOf(world.projectId);
    if (basis.kind !== 'landing') throw new Error('not weighed at the landing');
    const [report] = await landingCriteriaReports(world.projectId, [later]);
    const words = landingCriteriaHold(report as NonNullable<typeof report>, basis, 'agent');
    expect(words.reason).toContain(`judged at its landing commit \`${short(F4)}\``);
    expect(words.reason).toContain('names no commit it serves');
    expect(words.reason).not.toContain('promotion');
    expect(words.reason).not.toContain('0.121.0');
    for (const [, w] of await weighed(later)) expect(w.reason).not.toContain('0.121.0');
    expect(reads.n).toBe(0);
  });

  it('is cleared by a commit pass at its landing, which the verdict door accepts', async () => {
    const { later } = await landedAfterLive();
    for (const n of [1, 2, 3]) {
      const res = await judge(later, n, { kind: 'commit', sha: F4 });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const { out } = await hold([later]);
    expect(out.filter((b) => b.code === 'RELEASE_CRITERIA_UNEARNED')).toEqual([]);
    for (const [n, w] of await weighed(later)) {
      expect(w, `criterion ${n}`).toMatchObject({ earned: true, weighedOn: { basis: 'landing' } });
    }
  });

  it('never counts a pass on a live release whose record does not hold the issue', async () => {
    const { later } = await landedAfterLive();
    // the false verdict the old hold asked for: the door takes it, the weighing does not count it
    const res = await judge(later, 1, { kind: 'release', version: '0.121.0' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [report] = await landingCriteriaReports(world.projectId, [later]);
    expect(report?.unearned.find((c) => c.criterion === 1)?.why).toContain(
      'whose record does not hold this issue',
    );
  });

  it('still counts a release verdict on a shipped release whose record holds the issue', async () => {
    const { earlier } = await landedAfterLive();
    for (const n of [1, 2, 3]) {
      const res = await judge(earlier, n, { kind: 'release', version: '0.121.0' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const [report] = await landingCriteriaReports(world.projectId, [earlier]);
    expect(report?.unearned).toEqual([]);
    expect(report?.counted.map((c) => c.release)).toEqual(['0.121.0', '0.121.0', '0.121.0']);
  });

  it("counts a landing pass in its requirement's coverage, on the same basis", async () => {
    const req = await agreedRequirement(['A member opens the workspace', 'A workspace lists']);
    const { later } = await landedAfterLive();
    await traced(req, later, 2, { 1: 'BC-1', 2: 'BC-2' });
    for (const n of [1, 2]) await ok(judge(later, n, { kind: 'commit', sha: F4 }));
    const body = await ok(
      api(world.token, 'GET', `/api/projects/${world.projectId}/requirements/${req}`),
    );
    const standing = body.standing as {
      delivery: { criteriaCoverage: Record<string, number> };
      coverage: Array<{ issues: Array<{ notCounted: string | null }> }>;
    };
    expect(standing.delivery.criteriaCoverage).toMatchObject({ criteria: 2, passing: 2 });
    for (const bc of standing.coverage) expect(bc.issues[0]?.notCounted).toBeNull();
    expect(reads.n).toBe(0);
  });
});

describe('a live-only criterion holds no release, and is owed on it once it ships (ISS-957 part 6)', () => {
  it('lets an issue whose every criterion is observable ship unjudged, naming them', async () => {
    const { later } = await landedAfterLive();
    await designed(later, [
      [1, 'observable'],
      [2, 'observable'],
      [3, 'observable'],
    ]);
    const { out, warnings } = await hold([later]);
    expect(out.filter((b) => b.code === 'RELEASE_CRITERIA_UNEARNED')).toEqual([]);
    const after = warnings.find((w) => w.code === 'RELEASE_CRITERIA_AFTER_RELEASE');
    expect(after?.details?.held).toEqual([
      expect.objectContaining({ displayId: 'ISS-2', criteria: [1, 2, 3] }),
    ]);
    expect(after?.message).toContain('Judged after this release');
    const [report] = await landingCriteriaReports(world.projectId, [later]);
    expect(report?.unearned).toEqual([]);
    expect(report?.afterRelease.map((c) => c.criterion)).toEqual([1, 2, 3]);
  });

  it('reads them owed on the release that shipped the issue, and counts a pass there', async () => {
    const req = await agreedRequirement(['A member opens the workspace']);
    const { later } = await landedAfterLive();
    await designed(later, [
      [1, 'observable'],
      [2, 'observable'],
      [3, 'observable'],
    ]);
    await traced(req, later, 2, { 1: 'BC-1' });
    // a pass at the landing on stub data is no live check of it
    await stored(later, 2, { commit: F4 });
    await shipped([later], '0.123.0');

    const [report] = await landingCriteriaReports(world.projectId, [later]);
    expect(report?.afterRelease).toEqual([]);
    expect(report?.unearned.map((c) => c.criterion)).toEqual([1, 2, 3]);
    for (const c of report?.unearned ?? []) {
      expect(c.why).toContain("judge it on release 0.123.0, naming `{ kind: 'release', version: '0.123.0' }`");
    }
    expect((await weighed(later)).get(1)?.reason).toContain('judge it on release 0.123.0');

    // the requirement's judge is asked for the issue on that release
    const body = await ok(
      api(world.token, 'GET', `/api/projects/${world.projectId}/requirements/${req}`),
    );
    const standing = body.standing as {
      waitingOn: { says: { act: { key: string; vars?: Record<string, unknown> } } } | null;
    };
    expect(standing.waitingOn?.says.act).toEqual({
      key: 'standing.act.judgeOnReleaseOn',
      vars: { codes: 'BC-1', keys: 'ISS-2', version: '0.123.0' },
    });

    await stored(later, 1, { release: '0.123.0' });
    const [after] = await landingCriteriaReports(world.projectId, [later]);
    expect(after?.counted).toEqual([
      expect.objectContaining({ criterion: 1, release: '0.123.0' }),
    ]);
    expect(reads.n).toBe(0);
  });

  it('holds a mixed issue on its other criteria alone, at the landing commit', async () => {
    const { later } = await landedAfterLive();
    // criterion 3 has no recorded class, so it is never assumed live-only
    await designed(later, [
      [1, 'observable'],
      [2, 'server_side'],
    ]);
    const { out, warnings } = await hold([later]);
    const held = out.find((b) => b.code === 'RELEASE_CRITERIA_UNEARNED');
    expect(held?.details?.held).toEqual([
      expect.objectContaining({ displayId: 'ISS-2', criteria: [2, 3], landing: F4 }),
    ]);
    const after = warnings.find((w) => w.code === 'RELEASE_CRITERIA_AFTER_RELEASE');
    expect(after?.details?.held).toEqual([expect.objectContaining({ criteria: [1] })]);
    const [report] = await landingCriteriaReports(world.projectId, [later]);
    const basis = await criteriaBasisOf(world.projectId);
    if (basis.kind !== 'landing') throw new Error('not weighed at the landing');
    const words = landingCriteriaHold(report as NonNullable<typeof report>, basis, 'agent');
    expect(words.criteria).toEqual([2, 3]);
    expect(words.reason).toContain('Not held: criterion 1');
  });
});
