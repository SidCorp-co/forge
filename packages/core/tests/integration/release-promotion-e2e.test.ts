/**
 * REQ-63 BC-9..12, the promotion release (adminhub-api, 2026-10-29): production is deployed outside
 * Forge from `release/production`, and one promotion crosses into it from `release/stg`, where the
 * issue merge requests land. A release is that promotion's merge request: the target resolves, the
 * release shows the request and the roster issues its head carries, a merge done on GitLab is seen
 * in the projection, and the operator's record of the deploy closes the roster. Against real
 * Postgres, the host planted at the source-host resolver.
 *
 * @direct-test-of packages/core/src/release-batch/promotion-release.ts
 * @direct-test-of packages/core/src/release-batch/promotion-standing.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const planted = vi.hoisted(() => ({ carried: new Set<string>() }));

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'gitlab',
    fullName: 'acme/adminhub-api',
    // a commit is in another where the planted history says so: `${base}>${head}`
    compare: async (base: string, head: string) =>
      base === head ? 'identical' : planted.carried.has(`${base}>${head}`) ? 'ahead' : 'diverged',
  }),
}));

const STG = 'release/stg';
const PROD = 'release/production';
const HEAD = 'a1'.repeat(20);
const MERGE = 'b2'.repeat(20);
const DEPLOYED = 'c3'.repeat(20);
const LANDED = ['d4'.repeat(20), 'e5'.repeat(20)];
const NOTE = { section: 'Added', title: 'Site writes', userFacing: 'A site writes through.' };

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };
const rows = async <T>(q: ReturnType<typeof sql>) => [...(await db.execute(q))] as T[];
const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(world.token, method, `/api/projects/${world.projectId}${path}`, body);
const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

async function seed(environment: Record<string, unknown>) {
  await truncateAll();
  planted.carried.clear();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: { production: environment as never },
    promotions: [{ from: STG, to: PROD, via: 'merge' } as never],
    defaultBranch: STG,
    source: {
      type: 'git',
      git: {
        repository: 'gitlab.com/acme/adminhub-api',
        defaultBranch: STG,
        branches: [STG, PROD],
      },
    },
    extra: { delivery: { verdictsRequired: false } } as never,
  });
  const connectionId = randomUUID();
  world.bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${world.ownerId}, 'gitlab', true)`);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${world.bindingId}, ${connectionId}, ${world.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ repository: 'acme/adminhub-api' })}::jsonb)`);
}

const EXTERNAL = {
  tier: 'production',
  deploysFrom: PROD,
  deployment: { mode: 'external' },
  url: 'https://adminhub-api.example.test',
};

/** Two issues whose merge requests already merged into release/stg, waiting at the release gate. */
async function landedIssues(): Promise<string[]> {
  const ids: string[] = [];
  for (const [n, sha] of LANDED.entries()) {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes,
                          merged_at, merged_commit_sha, merged_target)
      VALUES (${id}, ${world.projectId}, ${n + 1}, ${`issue ${n + 1}`}, 'in_progress', ${world.ownerId},
              ${JSON.stringify(NOTE)}::jsonb, now() - interval '1 hour', ${sha}, ${STG})`);
    await seedIssueStatus(id, 'awaiting_release');
    ids.push(id);
  }
  return ids;
}

/** The promotion merge request as GitLab's hook writes it into the projection. */
async function promotionRequest(number: number, head: string) {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'open',
      pull_request: {
        number,
        title: 'Promote release/stg to production',
        body: null,
        html_url: `https://gitlab.com/acme/adminhub-api/-/merge_requests/${number}`,
        state: 'open',
        head: { ref: STG, sha: head },
        base: { ref: PROD, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/adminhub-api' },
    },
  );
}

/** GitLab's merge of the request, done by the owner on GitLab, as the projection reads it. */
const mergedOnHost = (number: number) =>
  db.execute(sql`
    UPDATE repo_pull_requests SET state = 'merged', merge_commit_sha = ${MERGE}, merged_at = now()
     WHERE project_id = ${world.projectId} AND number = ${number}`);

const record = (issueIds: string[], commit = DEPLOYED) =>
  call('POST', '/release-records', {
    issueIds,
    commit,
    account: 'Deployed release/production through forge-ops (k8s rollout adminhub-api).',
  });

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  await seed(EXTERNAL);
});

describe('BC-9: an external production with one declared promotion is a release target', () => {
  it('cuts the release as the promotion request, never RELEASE_TARGET_UNDECLARED', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    for (const sha of LANDED) planted.carried.add(`${sha}>${HEAD}`);
    const roster = await call('GET', '/release-batches/roster');
    expect(JSON.stringify(roster.body)).not.toContain('RELEASE_TARGET_UNDECLARED');
    const cut = await call('POST', '/release-batches', { issueIds: ids });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    expect(cut.body).toMatchObject({
      jobId: null,
      verification: 'deployment',
      changeRequests: [{ number: 5053, label: '!5053', headSha: HEAD }],
    });
  });

  it('refuses the cut by name where no promotion request carries the roster', async () => {
    const ids = await landedIssues();
    const none = await call('POST', '/release-batches', { issueIds: ids });
    expect(codeOf(none.body), JSON.stringify(none.body)).toBe('RELEASE_PROMOTION_MISSING');
    await promotionRequest(5053, HEAD);
    planted.carried.add(`${LANDED[0]}>${HEAD}`);
    const short = await call('POST', '/release-batches', { issueIds: ids });
    expect(codeOf(short.body)).toBe('RELEASE_PROMOTION_MISSING');
    expect(JSON.stringify(short.body)).toContain('`release/stg` into `release/production`');
  });
});

describe('BC-10..12: the release shows its promotion, sees it merged on GitLab, and closes on the record', () => {
  it('shows the request, refuses the record until it merged, and closes the roster on it', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    for (const sha of LANDED) planted.carried.add(`${sha}>${HEAD}`);
    const cut = await call('POST', '/release-batches', { issueIds: ids });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    const version = String(cut.body.version);

    const read = await call('GET', `/releases/${version}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect((read.body.release as { promotion: unknown }).promotion).toEqual({
      label: '!5053',
      number: 5053,
      title: 'Promote release/stg to production',
      url: 'https://gitlab.com/acme/adminhub-api/-/merge_requests/5053',
      state: 'open',
      from: STG,
      to: PROD,
      headSha: HEAD,
      mergeCommitSha: null,
      carries: ['ISS-1', 'ISS-2'],
      notCarried: [],
    });

    // Forge merges the promotion only on the owner's go: named through a roster issue, it is refused before approval
    const early = await api(world.token, 'POST', `/api/issues/${ids[0]}/merge-pull-request`, {
      pullRequest: 5053,
    });
    expect(codeOf(early.body), JSON.stringify(early.body)).toBe('RELEASE_MERGE_NOT_APPROVED');

    const unmerged = await record(ids);
    expect(codeOf(unmerged.body), JSON.stringify(unmerged.body)).toBe('RELEASE_PROMOTION_UNMERGED');

    await mergedOnHost(5053);
    const seen = await call('GET', `/releases/${version}`);
    expect(
      (seen.body.release as { promotion: { state: string; mergeCommitSha: string } }).promotion,
    ).toMatchObject({
      state: 'merged',
      mergeCommitSha: MERGE,
    });

    const partial = await record([ids[0] as string]);
    expect(codeOf(partial.body)).toBe('RELEASE_PROMOTION_ROSTER');
    // production serving a commit that does not hold the merge is not this release
    const stray = await record(ids);
    expect(codeOf(stray.body), JSON.stringify(stray.body)).toBe('RELEASE_NOT_VERIFIED');

    planted.carried.add(`${MERGE}>${DEPLOYED}`);
    const closed = await record(ids);
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    expect(closed.body).toMatchObject({ version, verification: 'deployment', failed: [] });
    const statuses = await rows<{ status: string }>(
      sql`SELECT status FROM issues WHERE project_id = ${world.projectId} ORDER BY iss_seq`,
    );
    expect(statuses.map((s) => s.status)).toEqual(['closed', 'closed']);
    const [run] = await rows<{ status: string; released: Date | null }>(
      sql`SELECT status, release_released_at AS released FROM pipeline_runs WHERE id = ${String(cut.body.runId)}`,
    );
    expect(run?.status).toBe('completed');
    expect(run?.released).not.toBeNull();
  });
});
