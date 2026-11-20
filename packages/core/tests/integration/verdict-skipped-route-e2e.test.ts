/**
 * REQ-6 BC-3 — "could not judge" through the route the web Judge posts to. The live QA of
 * dev.192/193 had no way to record it, so twelve such verdicts went in as Short and counted as
 * passing. A skipped verdict needs its reason, and never counts as a pass anywhere a count is shown:
 * the issue rail's tally, the requirement's coverage and the release criteria bar's fold. A person
 * judging again records a newer verdict, and the newest is the one counted. Through the app's own
 * routes, against real Postgres.
 *
 * ISS-1355 (adminhub-api FB-767): seven skips recorded as `runtime` at production's commit on a project
 * whose releases count commit verdicts were answered 201 and counted for nothing, so the owed-verdict
 * nudge repeated; and a skip after a pass at the same build took the pass away.
 *
 * @direct-test-of packages/core/src/issues/criteria/verdict-release-build.ts
 * @direct-test-of packages/core/src/release-batch/shipped-releases.ts
 */

import type { IssueCriteriaTally } from '@forge/contracts/issue-standing';
import { criterionStandingOf } from '@forge/contracts/verdict-identity';
import { verifiedOf } from '@forge/contracts/verified-rule';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { totalsOf } from '../../src/release-batch/release-view.js';
import { api, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  truncateAll,
} from '../helpers/factories.js';
import {
  F4,
  LATER,
  landedIssue,
  seedLandedWorld,
  verdict,
  world,
} from '../helpers/landed-world.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// the landed world's history (`helpers/landed-history.ts`): LATER holds the landing F4
vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

const LIVE = '0d91ae7c74f70295ede115463b17559e650b5207';

let projectId: string;
let ownerId: string;
let token: string;
let unplant: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  // production serves LIVE, so a verdict judged at it is one coverage can check (ISS-489 r3)
  unplant = plantLiveBuild(LIVE);
});

afterEach(() => {
  unplant?.();
});

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

/** A closed ISS-1 delivering an agreed requirement, its criterion 1 traced to BC-1. */
async function tracedClosedIssue(): Promise<{ issueId: string; req: string }> {
  const created = await onProject('POST', '/requirements', {
    title: 'Reminders',
    reason: 'planted',
    criteria: [{ body: 'A nurse sees the reminder' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const req = String(created.body.key);
  await makeAgreeReady(projectId, Number(req.slice(4)), ownerId);
  for (const [path, body] of [
    [`/requirements/${req}/revisions/1/propose`, {}],
    [`/requirements/${req}/revisions/1/accept`, { reason: 'Accepted for this test.' }],
    [`/requirements/${req}/agree`, { revision: 1, reason: 'Agreed with the owner for this test.' }],
  ] as const) {
    const r = await onProject('POST', path, body);
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  }
  const { id: issueId } = await createTestIssue(projectId, ownerId, 1, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  const linked = await onProject('POST', `/requirements/${req}/issues`, { issue: 'ISS-1' });
  expect(linked.status, JSON.stringify(linked.body)).toBeLessThan(300);
  const traced = await api(token, 'POST', `/api/issues/${issueId}/criteria/traces`, {
    codes: ['BC-1'],
  });
  expect(traced.status, JSON.stringify(traced.body)).toBe(201);
  return { issueId, req };
}

const judge = (
  issueId: string,
  verdict: string,
  reason: string | null,
  identity: Record<string, string> = { kind: 'commit', sha: LIVE },
) =>
  api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: 1,
    verdict,
    reason,
    identity,
    evidence: verdict === 'skipped' ? [] : ['reminder-1440.png'],
  });

/** A release the batch cut and finished at `commit`, carrying `issueIds`. */
async function shipped(
  version: string,
  commit: string,
  issueIds: readonly string[],
  project: string = projectId,
) {
  const at = new Date().toISOString();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    VALUES (gen_random_uuid(), ${project}, 'system', 'completed', ${at}, ${at}, ${version}, ${at},
            ${JSON.stringify({ issueIds, source: 'release-batch', finish: { state: 'finished', commit } })}::jsonb)`);
}

/** The project's releases judged on its `dev` environment (`delivery.judgedOn`, REQ-36 BC-18). */
const judgedOnDev = () =>
  seedProjectDocument(projectId, ownerId, {
    environments: {
      dev: {
        tier: 'dev',
        deploysFrom: 'main',
        deployment: { mode: 'external' },
        url: 'https://dev.example.test',
      },
    },
    extra: { delivery: { judgedOn: 'dev' } as never },
  });

const refusalOf = (body: Record<string, unknown>) =>
  (body.error as { refusals: Array<{ code: string; path: string; detail: string }> }).refusals[0];

/** Every count a person reads the criterion in: the rail's tally, the BC, and the release fold. */
async function counted(issueId: string, req: string) {
  const rail = await onProject('GET', '/issues/standing/ISS-1');
  expect(rail.status, JSON.stringify(rail.body)).toBe(200);
  const detail = await onProject('GET', `/requirements/${req}`);
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  const rows = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(rows.status, JSON.stringify(rows.body)).toBe(200);
  const criteria = rows.body.criteria as Array<{
    latest: { verdict: string; identityKind: string | null } | null;
  }>;
  const coverage = (
    detail.body as { standing: { coverage: Array<{ code: string; verdict: string }> } }
  ).standing.coverage;
  return {
    latest: criteria[0]?.latest?.verdict ?? null,
    // typed from the contract, so a renamed field breaks the typecheck rather than reading undefined
    tally: (rail.body as { standing: { criteria: IssueCriteriaTally } }).standing.criteria,
    bc: coverage.find((c) => c.code === 'BC-1')?.verdict,
    // the release fold by the verified rule, as `release-facts.ts:criteriaAt` reads it: this project
    // names no independent judge, and the person judging is not the builder
    release: totalsOf(
      criteria.map((c) => ({
        standing: criterionStandingOf(c.latest as never),
        proven: verifiedOf(
          c.latest
            ? [
                {
                  verdict: c.latest.verdict,
                  byBuilder: false,
                  authored: true,
                  recordedAt: null,
                },
              ]
            : [],
          null,
        ).proven,
      })),
    ),
  };
}

describe('a person records "could not judge"', () => {
  it('is recorded as skipped with its reason and counts as a pass nowhere', async () => {
    const { issueId, req } = await tracedClosedIssue();

    const r = await judge(issueId, 'skipped', 'The property lives in the code, not on a screen.');

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.criterion).toMatchObject({
      latest: { verdict: 'skipped', reason: 'The property lives in the code, not on a screen.' },
    });
    expect(await counted(issueId, req)).toEqual({
      latest: 'skipped',
      tally: expect.objectContaining({ met: 0, skipped: 1 }),
      bc: 'not_judged',
      release: { proven: 0, failing: 0, open: 1, unproven: 0, total: 1 },
    });
  });

  it('is refused by name without its reason, and nothing is written', async () => {
    const { issueId, req } = await tracedClosedIssue();

    const r = await judge(issueId, 'skipped', '  ');

    expect(r.status).toBe(422);
    expect(
      (r.body.error as { refusals: Array<{ code: string; path: string }> }).refusals[0],
    ).toMatchObject({ code: 'VERDICT_SKIP_REASON_REQUIRED', path: '/reason' });
    expect((await counted(issueId, req)).latest).toBeNull();
  });

  // REQ-35 decision 7b261fca: a short is no verification, so neither the requirement's coverage nor
  // the release fold counts it proven; the issue's tally reads it met, never passing
  it("a short is met on the issue's tally and proven on neither the requirement's coverage nor the release fold, and could not judge takes it away", async () => {
    const { issueId, req } = await tracedClosedIssue();
    expect((await judge(issueId, 'short', 'Met, short of its wording')).status).toBe(201);
    expect(await counted(issueId, req)).toMatchObject({
      tally: expect.objectContaining({ met: 1, skipped: 0 }),
      bc: 'not_judged',
      release: { proven: 0, open: 0, unproven: 1 },
    });

    expect((await judge(issueId, 'skipped', 'It was never on a screen to judge')).status).toBe(201);

    expect(await counted(issueId, req)).toMatchObject({
      latest: 'skipped',
      tally: expect.objectContaining({ met: 0, skipped: 1 }),
      bc: 'not_judged',
      release: { proven: 0, open: 1, unproven: 0 },
    });
  });

  it('judged again as a pass, the newest verdict is the one counted', async () => {
    const { issueId, req } = await tracedClosedIssue();
    expect((await judge(issueId, 'skipped', 'Not deployed when I looked')).status).toBe(201);

    expect((await judge(issueId, 'pass', 'Seen on the live deployment')).status).toBe(201);

    expect(await counted(issueId, req)).toMatchObject({
      latest: 'pass',
      tally: expect.objectContaining({ met: 1, skipped: 0 }),
      bc: 'passing',
      release: { proven: 1, open: 0 },
    });
  });
});

describe('a verdict at a shipped release build (ISS-1355)', () => {
  const runtime = { kind: 'runtime', ref: LIVE };
  const NO_ROUTE = 'No route: production needs a paid order nobody may place.';

  it('refuses a runtime skip a commit-judged release never counts, naming the commit, and writes nothing', async () => {
    const { issueId, req } = await tracedClosedIssue();
    await shipped('0.28.0', LIVE, [issueId]);

    const r = await judge(issueId, 'skipped', NO_ROUTE, runtime);

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const refused = refusalOf(r.body);
    expect(refused).toMatchObject({ code: 'VERDICT_IDENTITY_NOT_COUNTED', path: '/identity' });
    expect(refused?.detail).toContain(`{ kind: 'commit', sha: '${LIVE}' }`);
    expect(refused?.detail).toContain('release 0.28.0');
    expect((await counted(issueId, req)).latest).toBeNull();

    // the identity it names is taken
    expect((await judge(issueId, 'skipped', NO_ROUTE)).status).toBe(201);
  });

  it('takes the same runtime verdict where the project names its testing environment', async () => {
    const { issueId } = await tracedClosedIssue();
    await shipped('0.28.0', LIVE, [issueId]);
    await judgedOnDev();

    const r = await judge(issueId, 'skipped', NO_ROUTE, runtime);

    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('refuses a commit verdict a release judged on dev never counts, naming the runtime', async () => {
    const { issueId } = await tracedClosedIssue();
    await shipped('0.28.0', LIVE, [issueId]);
    await judgedOnDev();

    const r = await judge(issueId, 'pass', 'Seen on dev');

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusalOf(r.body)?.detail).toContain(`{ kind: 'runtime', ref: '${LIVE}' }`);
  });

  it('leaves a verdict at a landing no shipped release was built at untouched', async () => {
    const { issueId } = await tracedClosedIssue();
    await shipped('0.27.0', '1'.repeat(40), [issueId]);

    expect((await judge(issueId, 'skipped', NO_ROUTE, runtime)).status).toBe(201);
  });
});

describe('a skip after a pass at the same build (ISS-1355)', () => {
  it('is refused naming the pass, and the criterion stays proven', async () => {
    const { issueId, req } = await tracedClosedIssue();
    expect((await judge(issueId, 'pass', 'Seen on the live deployment')).status).toBe(201);

    const r = await judge(issueId, 'skipped', 'No route this time: the credential lapsed.');

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusalOf(r.body)).toMatchObject({ code: 'VERDICT_SKIP_OVER_PASS', path: '/verdict' });
    expect(await counted(issueId, req)).toMatchObject({
      latest: 'pass',
      tally: expect.objectContaining({ met: 1, skipped: 0 }),
      bc: 'passing',
      release: { proven: 1, open: 0 },
    });
  });

  it('is taken at another build, where the pass does not stand', async () => {
    const { issueId } = await tracedClosedIssue();
    expect((await judge(issueId, 'pass', 'Seen on the live deployment')).status).toBe(201);

    const elsewhere = { kind: 'commit', sha: '2'.repeat(40) };
    expect((await judge(issueId, 'skipped', 'Not deployed there', elsewhere)).status).toBe(201);
  });
});

describe('a skip at a release build after an earned landing pass (ISS-1355)', () => {
  /** Criterion 1's weighing, as the criteria read answers it. */
  const weighingOf = async (issueId: string) => {
    const rows = await api(world.token, 'GET', `/api/issues/${issueId}/criteria`);
    expect(rows.status, JSON.stringify(rows.body)).toBe(200);
    const criteria = rows.body.criteria as Array<{
      n: number;
      weighing: { earned: boolean | null; reason: string };
    }>;
    return criteria.find((c) => c.n === 1)?.weighing;
  };

  it('leaves the criterion earned at its landing', async () => {
    // verdicts owed, so the gate weighs the criteria at the build it delivers, its landing F4
    await seedLandedWorld({ verdictsRequired: true });
    const issueId = await landedIssue(5, F4);
    await verdict(issueId, 1, 'pass', F4);
    const before = await weighingOf(issueId);
    expect(before, JSON.stringify(before)).toMatchObject({ earned: true });
    await shipped('0.29.0', LATER, [issueId], world.projectId);

    const r = await api(world.token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: 1,
      verdict: 'skipped',
      reason: 'No route on the release build: the credential lapsed.',
      identity: { kind: 'commit', sha: LATER },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusalOf(r.body)).toMatchObject({ code: 'VERDICT_SKIP_OVER_PASS', path: '/verdict' });
    const after = await weighingOf(issueId);
    expect(after, `${r.status} ${JSON.stringify(after)}`).toMatchObject({ earned: true });
  });
});
