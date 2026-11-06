/**
 * ISS-1079, FB-545 (sidcorp-mail 0.16.0, 2026-11-06): release run 8250311b was cut over ISS-11, its
 * deploy was seen and its finish finished, and nothing recorded the commit production serves
 * (62a4ac7, release/0.16.0 merged into master). Seven passes judged live at that commit counted for
 * nothing: REQ-6 read 0/0. A release's verdicts reach the issues it carried only through the commit
 * it shipped (`shipped-releases.ts:shippedReleaseRuns`, `landed-build-holds.ts:laterHoldersOf`), and
 * no door could attach one afterwards. Planted on a promotion project, as sidcorp-mail is: work lands
 * on `release/stg` and production deploys `release/production`. Against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/shipped-commit.ts
 * @direct-test-of packages/core/src/release-batch/shipped-holding.ts
 * @direct-test-of packages/core/src/release-batch/landed-build-holds.ts
 * @direct-test-of packages/core/src/release-batch/finish-job.ts
 * @direct-test-of packages/core/src/release-batch/coolify-confirm.ts
 * @direct-test-of packages/core/src/release-batch/routes.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyDeploySettlement } from '../../src/release-batch/coolify-confirm.js';
import { shippedReleaseRuns } from '../../src/release-batch/shipped-releases.js';
import { api } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { agreedRequirement, requirementRead, traced } from '../helpers/landed-requirement.js';
import { landedIssue, seedLandedWorld, world } from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** ISS-11's landing on `release/stg`, and the commit release 0.16.0 shipped and production serves. */
const LANDING = '7b42608aa1d4e5f60718293a4b5c6d7e8f90a1b0';
const SHIPPED = '62a4ac7cb007502d7285874fe8e6e13337b74f94';
/** A commit on another line, which holds no landing. */
const ELSEWHERE = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
const PRODUCTION_PROBE = 'https://mail.example.test/api/version';

/** The source host's compare: SHIPPED holds LANDING; nothing else holds anything. */
vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'gitlab',
    fullName: 'sidcorp/mail',
    compare: async (base: string, head: string) =>
      base.toLowerCase() === LANDING && head.toLowerCase() === SHIPPED ? 'ahead' : 'diverged',
    readChangeRequestChecks: async () => [],
  }),
}));

/** sidcorp-mail's shape: lands on `release/stg`, promoted by merge, production probed for its commit. */
async function promotionProject(): Promise<void> {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'release/stg',
    promotions: [{ from: 'release/stg', to: 'release/production', via: 'merge' }],
    environments: {
      production: {
        tier: 'production',
        deploysFrom: 'release/production',
        deployment: { mode: 'external' },
        url: 'https://mail.example.test',
        verification: {
          runtime: [
            { type: 'http', url: PRODUCTION_PROBE, path: 'commit', identifies: 'source' },
          ],
        },
      },
    } as never,
    extra: { delivery: { verdictsRequired: true } } as never,
  });
}

/** A pass on criterion 1 of `issueId`, judged live at `commit`. */
async function passedAt(issueId: string, commit: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_agency, judge)
    SELECT id, ${issueId}, 'pass', ${`(REQ BC-1) held live at ${commit}`}, 'commit', ${commit},
           ${world.ownerId}, 'agent', 'qa'
      FROM issue_criteria WHERE issue_id = ${issueId} AND n = 1 AND retired_at IS NULL
  `);
}

/** A finish record as the job leaves it, `finished`, naming `commit` (null: the finish named none). */
function finished(commit: string | null, closed: string[]) {
  const at = new Date().toISOString();
  return {
    requestId: randomUUID(),
    state: 'finished',
    commit,
    requestedBy: { type: 'user', id: world.ownerId, agency: 'agent' },
    acceptedAt: at,
    updatedAt: at,
    version: 4,
    owner: null,
    leaseUntil: null,
    workerStarts: 1,
    closed,
    failed: [],
    refusal: null,
    verification: 'recorded',
    finishedAt: at,
  };
}

/** The delivery the run's one production deploy was reported under. */
const DELIVERY = randomUUID();

/** One deploy target the run dispatched, as the confirmation holds it. */
const hold = (status: 'pending' | 'succeeded', commit?: string) => ({
  [`target:${DELIVERY}`]: {
    bindingId: randomUUID(),
    deploymentUuid: 'deployment-1',
    targetLabel: 'production',
    status,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...(commit ? { commit } : {}),
  },
});

/** Release 0.16.0 as sidcorp-mail's stood: completed, shipped, carrying `issueId`, its commit unnamed. */
async function shippedRun(
  issueId: string,
  holds: Record<string, unknown> = {},
  { shipped = true }: { shipped?: boolean } = {},
): Promise<string> {
  const runId = randomUUID();
  const metadata = {
    source: 'release-batch',
    issueIds: [issueId],
    ...(shipped ? { rosterClosed: [issueId], finish: finished(null, [issueId]) } : {}),
    verification: 'recorded',
    __forge_deploy_confirm: holds,
  };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata, release_version,
                               release_released_at, finished_at)
    VALUES (${runId}, ${world.projectId}, 'system', ${shipped ? 'completed' : 'running'},
            ${JSON.stringify(metadata)}::jsonb, '0.16.0', ${shipped ? sql`now()` : null},
            ${shipped ? sql`now()` : null})
  `);
  return runId;
}

/** ISS-11: landed at LANDING, criterion 1 traced to BC-1 of `req`, judged live at SHIPPED, closed. */
async function judgedLive(req: string): Promise<string> {
  const issue = await landedIssue(11, LANDING, ['The webmail serves the release build']);
  await traced(req, issue, 11, { 1: 'BC-1' });
  await passedAt(issue, SHIPPED);
  await seedIssueStatus(issue, 'closed');
  return issue;
}

async function earnedOf(issueId: string): Promise<boolean | null | undefined> {
  const res = await api(world.token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const criteria = res.body.criteria as Array<{ n: number; weighing?: { earned: boolean | null } }>;
  return criteria.find((c) => c.n === 1)?.weighing?.earned;
}

async function coverageOf(req: string) {
  return (await requirementRead(req)).standing.delivery.criteriaCoverage;
}

async function shippedCommitOf(runId: string): Promise<string | null> {
  const run = (await shippedReleaseRuns(world.projectId)).find((r) => r.runId === runId);
  return run?.commit ?? null;
}

const attach = (runId: string, commit: string) =>
  api(
    world.token,
    'POST',
    `/api/projects/${world.projectId}/release-batches/${runId}/shipped-commit`,
    { commit, evidence: `GET ${PRODUCTION_PROBE} answered ${commit}` },
  );

const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await seedLandedWorld();
  await promotionProject();
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PRODUCTION_PROBE)) return Response.json({ commit: SHIPPED });
    return real(input, init);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('a release that completes on a seen deploy records its shipped commit (ISS-1079)', () => {
  it('reads FB-545 first: a finished release naming no commit counts nothing at that commit', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    await shippedRun(issue);

    expect(await earnedOf(issue)).toBe(false);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 0, judged: 0 });
  });

  it('records the commit the deploy reported once the deploy settles after the finish', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, hold('pending'));

    await applyDeploySettlement(
      {
        bindingId: randomUUID(),
        runId,
        deliveryId: DELIVERY,
        deploymentUuid: 'deployment-1',
        targetLabel: 'production',
        commit: SHIPPED,
      } as Parameters<typeof applyDeploySettlement>[0],
      'succeeded',
    );

    expect(await shippedCommitOf(runId)).toBe(SHIPPED);
    expect(await earnedOf(issue)).toBe(true);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('records the commit the deploy reported once the finish completes after the deploy', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, hold('succeeded', SHIPPED));
    // the finish job's completion, after its attempt wrote `finished`
    const { recordObservedShippedCommit } = await import(
      '../../src/release-batch/shipped-commit.js'
    );

    const recorded = await recordObservedShippedCommit(runId);

    expect(recorded).toMatchObject({ commit: SHIPPED, from: 'deploy' });
    expect(await shippedCommitOf(runId)).toBe(SHIPPED);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('says why where nothing the deploy reported names a whole commit', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, hold('succeeded'));
    const { recordObservedShippedCommit } = await import(
      '../../src/release-batch/shipped-commit.js'
    );

    const recorded = await recordObservedShippedCommit(runId);

    expect(recorded).toMatchObject({ commit: null, from: null });
    expect(recorded.said).toContain('shipped-commit');
    const [row] = [
      ...(await db.execute<{ said: string | null }>(sql`
        SELECT metadata -> 'finish' -> 'shipped' ->> 'said' AS said FROM pipeline_runs WHERE id = ${runId}`)),
    ];
    expect(row?.said, 'the finish record says why it names no commit').toContain('no deploy');
    expect(await shippedCommitOf(runId)).toBeNull();
  });
});

describe('a completed release without a shipped commit takes one through its door (ISS-1079)', () => {
  it('attaches the commit and the verdicts judged there count for the issues it carried', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue);

    const res = await attach(runId, SHIPPED);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ runId, commit: SHIPPED, from: 'attached' });
    expect(await shippedCommitOf(runId)).toBe(SHIPPED);
    expect(await earnedOf(issue)).toBe(true);
    expect(await coverageOf(req)).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('refuses a commit that does not carry the landing of an issue the release carried', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue);

    const res = await attach(runId, ELSEWHERE);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res.body)).toBe('RELEASE_SHIPPED_COMMIT_LACKS_LANDING');
    expect(JSON.stringify(res.body)).toContain('ISS-11');
    expect(JSON.stringify(res.body)).toContain(LANDING.slice(0, 12));
    expect(await shippedCommitOf(runId)).toBeNull();
  });

  it('refuses a run that already holds a shipped commit, naming it', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue);
    expect((await attach(runId, SHIPPED)).status).toBe(201);

    const again = await attach(runId, SHIPPED);

    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(codeOf(again.body)).toBe('RELEASE_SHIPPED_COMMIT_HELD');
    expect(JSON.stringify(again.body)).toContain(SHIPPED.slice(0, 12));
  });

  it('refuses a release run that has not shipped', async () => {
    const req = await agreedRequirement(['The webmail serves the release build']);
    const issue = await judgedLive(req);
    const runId = await shippedRun(issue, {}, { shipped: false });

    const res = await attach(runId, SHIPPED);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res.body)).toBe('RELEASE_SHIPPED_COMMIT_NOT_SHIPPED');
  });
});
