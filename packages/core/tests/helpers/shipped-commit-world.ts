/**
 * The world the shipped-commit witnesses (ISS-1079) share: sidcorp-mail's promotion project, release
 * 0.16.0's run in each shape it can stand in, ISS-11 judged live, and the reads of what counted.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { registerReleaseBatchFinish } from '../../src/release-batch/finish-job.js';
import { shippedReleaseRuns } from '../../src/release-batch/shipped-releases.js';
import { api } from './api.js';
import { closeWorld, startQueue, testEnv } from './ecosystem-world.js';
import { seedIssueStatus } from './factories.js';
import { requirementRead, traced } from './landed-requirement.js';
import { landedIssue, seedLandedWorld, world } from './landed-world.js';
import { seedProjectDocument } from './release-world.js';
import { LANDING, PRODUCTION_PROBE, SHIPPED } from './shipped-commit-host.js';

/** sidcorp-mail's shape: lands on `release/stg`, promoted by merge, production probed for its commit. */
export async function promotionProject(): Promise<void> {
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
          runtime: [{ type: 'http', url: PRODUCTION_PROBE, path: 'commit', identifies: 'source' }],
        },
      },
    } as never,
    extra: { delivery: { verdictsRequired: true } } as never,
  });
}

/** A pass on criterion 1 of `issueId`, judged live at `commit`. */
export async function passedAt(issueId: string, commit: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_agency, judge)
    SELECT id, ${issueId}, 'pass', ${`(REQ BC-1) held live at ${commit}`}, 'commit', ${commit},
           ${world.ownerId}, 'agent', 'qa'
      FROM issue_criteria WHERE issue_id = ${issueId} AND n = 1 AND retired_at IS NULL
  `);
}

/** Where a finished record's commit came from; absent, as a record written before ISS-1079 has it. */
export type Source = { from: 'finish' | 'deploy' | 'attached'; said: string } | undefined;

/** A finish record as the job leaves it, `finished`, naming `commit` (null: the finish named none). */
export function finished(commit: string | null, closed: string[], shipped?: Source) {
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
    ...(shipped ? { shipped } : {}),
  };
}

/** The delivery the run's one production deploy was reported under. */
export const DELIVERY = randomUUID();

/** One deploy target the run dispatched, as the confirmation holds it. */
export const hold = (status: 'pending' | 'succeeded', commit?: string) => ({
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
export async function shippedRun(
  issueId: string,
  holds: Record<string, unknown> = {},
  {
    shipped = true,
    commit = null,
    source,
    extra = {},
    version = '0.16.0',
  }: {
    shipped?: boolean;
    commit?: string | null;
    source?: Source;
    extra?: Record<string, unknown>;
    /** The version it cut; an earlier release of the same project names its own. */
    version?: string;
  } = {},
): Promise<string> {
  const runId = randomUUID();
  const metadata = {
    source: 'release-batch',
    issueIds: [issueId],
    ...(shipped ? { rosterClosed: [issueId], finish: finished(commit, [issueId], source) } : {}),
    ...extra,
    verification: 'recorded',
    __forge_deploy_confirm: holds,
  };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata, release_version,
                               release_released_at, finished_at)
    VALUES (${runId}, ${world.projectId}, 'system', ${shipped ? 'completed' : 'running'},
            ${JSON.stringify(metadata)}::jsonb, ${version}, ${shipped ? sql`now()` : null},
            ${shipped ? sql`now()` : null})
  `);
  return runId;
}

/** ISS-11: landed at LANDING, criterion 1 traced to BC-1 of `req`, judged live at SHIPPED, closed. */
export async function judgedLive(req: string): Promise<string> {
  const issue = await landedIssue(11, LANDING, ['The webmail serves the release build']);
  await traced(req, issue, 11, { 1: 'BC-1' });
  await passedAt(issue, SHIPPED);
  await seedIssueStatus(issue, 'closed');
  return issue;
}

export async function earnedOf(issueId: string): Promise<boolean | null | undefined> {
  const res = await api(world.token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const criteria = res.body.criteria as Array<{ n: number; weighing?: { earned: boolean | null } }>;
  return criteria.find((c) => c.n === 1)?.weighing?.earned;
}

export async function coverageOf(req: string) {
  return (await requirementRead(req)).standing.delivery.criteriaCoverage;
}

export async function shippedCommitOf(runId: string): Promise<string | null> {
  const run = (await shippedReleaseRuns(world.projectId)).find((r) => r.runId === runId);
  return run?.commit ?? null;
}

export const attach = (runId: string, commit: string) =>
  api(
    world.token,
    'POST',
    `/api/projects/${world.projectId}/release-batches/${runId}/shipped-commit`,
    { commit, evidence: `GET ${PRODUCTION_PROBE} answered ${commit}` },
  );

export const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

/** ISS-11 claimed by a cut release run whose deploy already settled, its finish not yet taken. */
export async function claimedByRun(
  issueId: string,
  holds: Record<string, unknown>,
): Promise<string> {
  const runId = randomUUID();
  const metadata = { source: 'release-batch', issueIds: [issueId], __forge_deploy_confirm: holds };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata, release_version)
    VALUES (${runId}, ${world.projectId}, 'system', 'running', ${JSON.stringify(metadata)}::jsonb,
            '0.16.0')
  `);
  await db.execute(sql`UPDATE issues SET release_batch_run_id = ${runId} WHERE id = ${issueId}`);
  return runId;
}

/** The run's finish record once the job leaves it terminal. */
export async function finishedRecord(runId: string): Promise<Record<string, unknown>> {
  const until = Date.now() + 20_000;
  for (;;) {
    const [row] = [
      ...(await db.execute<{ finish: Record<string, unknown> | null }>(sql`
        SELECT metadata -> 'finish' AS finish FROM pipeline_runs WHERE id = ${runId}`)),
    ];
    const state = row?.finish?.state;
    if (state === 'finished' || state === 'failed') return row?.finish ?? {};
    if (Date.now() > until) throw new Error(`the finish stayed ${String(state)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The run's finish record and what its tag is owed on, as stored. */
export async function storedOf(runId: string) {
  const [row] = [
    ...(await db.execute<{ finish: Record<string, unknown>; tag_owed: string | null }>(sql`
      SELECT metadata -> 'finish' AS finish, metadata -> 'tagOwed' ->> 'commit' AS tag_owed
        FROM pipeline_runs WHERE id = ${runId}`)),
  ];
  return { finish: row?.finish ?? {}, tagOwed: row?.tag_owed ?? null };
}

export const NAMED_BY_FINISH: Source = { from: 'finish', said: 'named by its finish' };

/** A tag owed on `commit` from the finish, as the finish door leaves it, put on the host or not yet. */
export const tagOwedOn = (commit: string, put: boolean) => ({
  tagOwed: { name: 'v0.16.0', commit, from: 'finish', at: new Date().toISOString() },
  ...(put
    ? {
        tag: {
          state: 'tagged',
          name: 'v0.16.0',
          commit,
          created: true,
          on: null,
          code: null,
          reason: null,
          at: new Date().toISOString(),
        },
      }
    : {}),
});

/** The world each shipped-commit witness runs in: the queue, the finish job and the production probe. */
export function useShippedCommitWorld(): void {
  beforeAll(async () => {
    testEnv();
    await startQueue();
    await registerReleaseBatchFinish();
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

  afterEach(() => {
    vi.restoreAllMocks();
  });
}
