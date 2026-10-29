/**
 * REQ-63 r7 BC-13..14 (forge-core-61, 2026-10-29): a release tags the commit its version names
 * `v<version>` before anything is deployed from it. On a promotion release that is the promotion's
 * merge commit, the moment Forge records it merged: through Forge's own merge (the settle the merge
 * route calls), already merged when the release is cut, or merged on the host and recorded by the
 * master through that same route. The host's report alone writes nothing (ISS-774, owner 2026-10-29);
 * it leaves the record owed to the master. The build the operator then deploys reads its version with
 * no redeploy. A release run's cut commit is the head it reports for its range, before its finish. A
 * release that ends without shipping keeps its tag, and its next attempt takes a new version. Against
 * real Postgres and the started outbox, the source host planted at the resolver: it holds tags by
 * name and counts every write it took.
 *
 * @direct-test-of packages/core/src/release-batch/release-tag.ts
 * @direct-test-of packages/core/src/release-batch/release-tag-record.ts
 * @direct-test-of packages/core/src/release-batch/change-request-settle.ts
 * @direct-test-of packages/core/src/release-batch/promotion-release.ts
 * @direct-test-of packages/core/src/release-batch/shipped-range.ts
 * @direct-test-of packages/core/src/release-batch/merges-owed.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { emitEvent } from '../../src/outbox/index.js';
import { settleChangeRequestRelease } from '../../src/release-batch/index.js';
import { releaseMergesOwed } from '../../src/release-batch/merges-owed.js';
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

const planted = vi.hoisted(() => ({
  tags: new Map<string, string>(),
  writes: [] as Array<{ name: string; sha: string }>,
  takenOn: null as string | null,
}));

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'gitlab',
    bindingId: 'b-adminhub',
    fullName: 'acme/adminhub-api',
    host: 'gitlab.com',
    async tagCommit({ name, sha }: { name: string; sha: string }) {
      const on = planted.tags.get(name) ?? planted.takenOn ?? undefined;
      if (on !== undefined) return { kind: on === sha ? 'present' : 'conflict', name, sha: on };
      planted.tags.set(name, sha);
      planted.writes.push({ name, sha });
      return { kind: 'created', name, sha };
    },
  }),
}));

const STG = 'release/stg';
const PROD = 'release/production';
const HEAD = 'a1'.repeat(20);
const MERGE = 'b2'.repeat(20);
const DEPLOYED = 'c3'.repeat(20);
const LANDED = ['d4'.repeat(20), 'e5'.repeat(20)];
const PREVIOUS = 'f6'.repeat(20);
const CUT = '17'.repeat(20);
const RECUT = '28'.repeat(20);
const NOTE = { section: 'Added', title: 'Site writes', userFacing: 'A site writes through.' };

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };
const rows = async <T>(q: ReturnType<typeof sql>) => [...(await db.execute(q))] as T[];
const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(world.token, method, `/api/projects/${world.projectId}${path}`, body);

async function seed(environments: Record<string, unknown>, promotions: unknown[]) {
  await truncateAll();
  planted.tags.clear();
  planted.writes.length = 0;
  planted.takenOn = null;
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: environments as never,
    promotions: promotions as never,
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
const promotionWorld = () =>
  seed({ production: EXTERNAL }, [{ from: STG, to: PROD, via: 'merge' }]);

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
async function promotionRequest(number: number) {
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
        head: { ref: STG, sha: HEAD },
        base: { ref: PROD, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/adminhub-api' },
    },
  );
}

/** GitLab's merge of the request, as the projection reads it. */
const mergedInProjection = (number: number) =>
  db.execute(sql`
    UPDATE repo_pull_requests SET state = 'merged', merge_commit_sha = ${MERGE}, merged_at = now()
     WHERE project_id = ${world.projectId} AND number = ${number}`);

/** The host's report of that merge, as its hook tells the outbox: ISS-774 gave it no consumer. */
const hostReportsMerge = () =>
  emitEvent(db, 'source.merged', {
    projectId: world.projectId,
    headRef: STG,
    baseRef: PROD,
    commitSha: MERGE,
    mergedAt: new Date().toISOString(),
    head: null,
  });

const recordDeploy = (issueIds: string[]) =>
  call('POST', '/release-records', {
    issueIds,
    commit: DEPLOYED,
    account: 'Deployed release/production through forge-ops (k8s rollout adminhub-api).',
  });

/** The agent's cut: the roster it states, and the promotion request it names (ISS-762). */
async function cut(ids: string[], request?: number): Promise<{ runId: string; version: string }> {
  const res = await call('POST', '/release-batches', {
    issueIds: ids,
    ...(request === undefined ? {} : { promotion: { request } }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await settleOutbox();
  return { runId: String(res.body.runId), version: String(res.body.version) };
}

async function tagOnPage(version: string): Promise<Record<string, unknown> | null> {
  const res = await call('GET', `/releases/${version}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.release as { tag: Record<string, unknown> | null }).tag;
}

/** The owner's go on the release's pending approval, as the release page's decision sends it. */
async function accept(runId: string) {
  const [pending] = await rows<{ id: string }>(
    sql`SELECT id FROM release_approvals WHERE run_id = ${runId} AND decision IS NULL`,
  );
  const res = await call('POST', `/release-batches/${runId}/approvals/${pending?.id}/decision`, {
    decision: 'approve',
    reason: 'the owner read the promotion and accepts it',
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** What `merge-pull-request` calls once Forge merged, or recorded merged, a release step. */
const settle = (runId: string) =>
  settleChangeRequestRelease(runId, { type: 'user', id: world.ownerId, agency: 'agent' });

const deployRecords = (runId: string) =>
  rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM release_attempts WHERE run_id = ${runId}`,
  ).then((r) => r[0]?.n ?? 0);

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

describe('a promotion release tags the promotion merge the moment Forge sees it merged (REQ-63 BC-13)', () => {
  it('a merge on the host tags nothing by itself; the master is owed its record, and that record tags the merge commit before any deploy', async () => {
    await promotionWorld();
    const ids = await landedIssues();
    await promotionRequest(5053);
    const { runId, version } = await cut(ids, 5053);
    await accept(runId);

    // still open: nothing to tag yet, and the page says none
    expect(planted.writes).toEqual([]);
    expect(await tagOnPage(version)).toBeNull();
    expect(await releaseMergesOwed(world.projectId)).toMatchObject([
      { runId, next: { number: 5053 }, merged: 0, total: 1 },
    ]);

    // merged on GitLab: the hook's report writes nothing (ISS-774), and the record stays owed
    await mergedInProjection(5053);
    await hostReportsMerge();
    await settleOutbox();
    expect(planted.writes).toEqual([]);
    expect(await tagOnPage(version)).toBeNull();
    expect(await releaseMergesOwed(world.projectId)).toMatchObject([
      { runId, next: { number: 5053 }, merged: 1, total: 1 },
    ]);

    // the master records it through the merge route, whose settle owes the tag on the merge
    expect(await settle(runId)).toEqual({ settled: false, pending: 'record' });
    await settleOutbox();

    expect(planted.writes).toEqual([{ name: `v${version}`, sha: MERGE }]);
    expect(await deployRecords(runId)).toBe(0);
    expect(await releaseMergesOwed(world.projectId)).toEqual([]);
    expect(await tagOnPage(version)).toMatchObject({
      state: 'tagged',
      name: `v${version}`,
      commit: MERGE,
      created: true,
      code: null,
    });

    // the operator deploys from that merge and records it: the tag was already there
    const closed = await recordDeploy(ids);
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    await settleOutbox();
    expect(planted.writes).toEqual([{ name: `v${version}`, sha: MERGE }]);
    expect(await tagOnPage(version)).toMatchObject({ state: 'tagged', commit: MERGE });
  });

  it("a merge through Forge tags it on the release's own settle, before any deploy is recorded", async () => {
    await promotionWorld();
    const ids = await landedIssues();
    await promotionRequest(5054);
    const { runId, version } = await cut(ids, 5054);

    // Forge's merge of the release step went through, and the route settles the release
    await mergedInProjection(5054);
    expect(await settle(runId)).toEqual({ settled: false, pending: 'record' });
    await settleOutbox();

    expect(planted.writes).toEqual([{ name: `v${version}`, sha: MERGE }]);
    expect(await deployRecords(runId)).toBe(0);
  });

  it('a promotion already merged when the release is cut is tagged at the cut', async () => {
    await promotionWorld();
    const ids = await landedIssues();
    await promotionRequest(5055);
    await mergedInProjection(5055);
    const { runId, version } = await cut(ids, 5055);

    expect(planted.writes).toEqual([{ name: `v${version}`, sha: MERGE }]);
    expect(await deployRecords(runId)).toBe(0);
    const [run] = await rows<{ owed: { from: string; commit: string } }>(
      sql`SELECT metadata -> 'tagOwed' AS owed FROM pipeline_runs WHERE id = ${runId}`,
    );
    expect(run?.owed).toMatchObject({ from: 'promotion', commit: MERGE });
  });

  it('a same-name tag already on another commit is refused RELEASE_TAG_CONFLICT naming it, and never moved (BC-14)', async () => {
    await promotionWorld();
    const ids = await landedIssues();
    await promotionRequest(5056);
    planted.takenOn = DEPLOYED;
    const { runId, version } = await cut(ids, 5056);
    await mergedInProjection(5056);
    await settle(runId);
    await settleOutbox();

    const tag = await tagOnPage(version);
    expect(tag).toMatchObject({
      state: 'refused',
      commit: MERGE,
      on: DEPLOYED,
      code: 'RELEASE_TAG_CONFLICT',
    });
    expect(String(tag?.reason)).toContain(DEPLOYED);
    expect(planted.writes).toEqual([]);
  });
});

describe('a release that ends without shipping keeps its tag (REQ-63 BC-14)', () => {
  it('an aborted promotion release keeps v<version> on the host and on its page, and the next cut takes a new version', async () => {
    await promotionWorld();
    const ids = await landedIssues();
    await promotionRequest(5057);
    await mergedInProjection(5057);
    const first = await cut(ids, 5057);
    expect(planted.writes).toEqual([{ name: `v${first.version}`, sha: MERGE }]);

    const aborted = await call('POST', `/release-batches/${first.runId}/abort`, {
      reason: 'the operator stopped the deploy',
      carried: [],
    });
    expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);
    await settleOutbox();

    // nothing deleted it: the host and the release still hold it
    expect(planted.tags.get(`v${first.version}`)).toBe(MERGE);
    expect(await tagOnPage(first.version)).toMatchObject({ state: 'tagged', commit: MERGE });

    const second = await cut(ids, 5057);
    expect(second.version).not.toBe(first.version);
    expect(planted.writes).toEqual([
      { name: `v${first.version}`, sha: MERGE },
      { name: `v${second.version}`, sha: MERGE },
    ]);
  });
});

describe("a release run's cut commit is tagged when it reports its range, before its finish (REQ-63 BC-13)", () => {
  async function runningRelease(): Promise<string> {
    await seed({}, []);
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
      VALUES (gen_random_uuid(), ${world.projectId}, 'system', 'completed', now() - interval '2 days', '0.0.9', now() - interval '2 days',
              ${JSON.stringify({ source: 'release-batch', finish: { requestId: 'r', state: 'finished', commit: PREVIOUS, version: 1 } })}::jsonb)`);
    const runId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
      VALUES (${runId}, ${world.projectId}, 'system', 'running', now(), '0.1.0',
              ${JSON.stringify({ source: 'release-batch', issueIds: [] })}::jsonb)`);
    return runId;
  }

  const report = (runId: string, head: string) =>
    call('POST', `/release-batches/${runId}/range`, {
      base: PREVIOUS,
      head,
      changes: [],
      files: [],
    });

  it('tags the reported head v<version> while the run is still running, and a second report never re-aims it', async () => {
    const runId = await runningRelease();
    const res = await report(runId, CUT);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await settleOutbox();

    expect(planted.writes).toEqual([{ name: 'v0.1.0', sha: CUT }]);
    const [run] = await rows<{ status: string; released: Date | null }>(
      sql`SELECT status, release_released_at AS released FROM pipeline_runs WHERE id = ${runId}`,
    );
    expect(run).toMatchObject({ status: 'running', released: null });
    expect(await tagOnPage('0.1.0')).toMatchObject({ state: 'tagged', commit: CUT, created: true });

    const again = await report(runId, RECUT);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    await settleOutbox();
    expect(planted.writes).toEqual([{ name: 'v0.1.0', sha: CUT }]);
  });
});
