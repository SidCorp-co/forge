/**
 * ISS-928: a release that shipped never ends `failed` because one issue's close was refused.
 * adminhub-api 0.9.0 (run 46a3abe4, 2026-11-03): approved, promotion !5136 merged, production
 * deployed and recorded; the record closed 12 of 13 issues, ISS-160 was refused for an open question,
 * and the run ended `failed`. Nothing then closed ISS-160 short of the repair door: release-records
 * was refused RELEASE_PROMOTION_MISSING and a new cut naming !5136 RELEASE_PROMOTION_REQUEST_UNKNOWN.
 * Planted here through the app's own doors against real Postgres: the release reads shipped, the
 * refused issue waits at `awaiting_release` as the release's residue with its refusal, and once the
 * question is answered a release-record of it against that release closes it, no repair called.
 *
 * @direct-test-of packages/core/src/release-batch/recorded.ts
 * @direct-test-of packages/core/src/release-batch/promotion-release.ts
 * @direct-test-of packages/core/src/release-batch/residue.ts
 * @direct-test-of packages/core/src/release-batch/finish.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { askQuestion } from '../../src/questions/index.js';
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

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'gitlab',
    fullName: 'acme/adminhub-api',
    compare: async () => 'diverged',
    readChangeRequestChecks: async () => [],
  }),
}));

const STG = 'release/stg';
const PROD = 'release/production';
const HEAD = 'a1'.repeat(20);
const MERGE = 'b4bbce6f'.repeat(5);
const NOTE = { section: 'Added', title: 'Site writes', userFacing: 'A site writes through.' };

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };
const rows = async <T>(q: ReturnType<typeof sql>) => [...(await db.execute(q))] as T[];
const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(world.token, method, `/api/projects/${world.projectId}${path}`, body);
const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

async function seed() {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: {
      production: {
        tier: 'production',
        deploysFrom: PROD,
        deployment: { mode: 'external' },
        url: 'https://adminhub-api.example.test',
      } as never,
    },
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

/** `n` issues whose merge requests merged into release/stg, waiting at the release gate. */
async function landedIssues(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes,
                          merged_at, merged_commit_sha, merged_target)
      VALUES (${id}, ${world.projectId}, ${i}, ${`issue ${i}`}, 'in_progress', ${world.ownerId},
              ${JSON.stringify(NOTE)}::jsonb, now() - interval '1 hour', ${`${i}`.padStart(40, 'd')}, ${STG})`);
    await seedIssueStatus(id, 'awaiting_release');
    ids.push(id);
  }
  return ids;
}

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

const mergedOnHost = (number: number) =>
  db.execute(sql`
    UPDATE repo_pull_requests SET state = 'merged', merge_commit_sha = ${MERGE}, merged_at = now()
     WHERE project_id = ${world.projectId} AND number = ${number}`);

const record = (issueIds: string[], version: string) =>
  call('POST', '/release-records', {
    issueIds,
    version,
    commit: MERGE,
    account: 'Deployed release/production to both sites (b4bbce6f) and read each serving it.',
  });

async function approve(runId: string) {
  const [pending] = await rows<{ id: string }>(sql`
    SELECT id FROM release_approvals WHERE run_id = ${runId} AND decision IS NULL`);
  const res = await call('POST', `/release-batches/${runId}/approvals/${pending?.id}/decision`, {
    decision: 'approve',
    reason: 'the owner read the promotion and accepts it',
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** An open question on the issue, as 486e60ef stood on adminhub-api ISS-160: `closed` refuses it. */
async function ask(issueId: string): Promise<string> {
  const id = randomUUID();
  await askQuestion({
    id,
    projectId: world.projectId,
    issueId,
    prompt: 'Does the site writer keep the old column?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the column rule', recommended: 'Keep it one release.' },
  });
  return id;
}

async function runRow(runId: string) {
  const [run] = await rows<{
    status: string;
    released: Date | null;
    metadata: Record<string, unknown>;
  }>(
    sql`SELECT status, release_released_at AS released, metadata FROM pipeline_runs WHERE id = ${runId}`,
  );
  return run;
}

async function statusOf(issueId: string): Promise<string | undefined> {
  const [row] = await rows<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  );
  return row?.status;
}

/** 46a3abe4's sequence up to its record: cut on !5136, approved, merged, deploy recorded. */
async function shippedWithOneRefused() {
  const ids = await landedIssues(13);
  const held = ids[12] as string;
  const questionId = await ask(held);
  await promotionRequest(5136);
  const cut = await call('POST', '/release-batches', {
    issueIds: ids,
    promotion: { request: 5136 },
  });
  expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  const runId = String(cut.body.runId);
  const version = String(cut.body.version);
  await approve(runId);
  await mergedOnHost(5136);
  const recorded = await record(ids, version);
  return { ids, held, questionId, runId, version, recorded };
}

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  await seed();
});

describe('adminhub-api 0.9.0: approved, merged, deployed, 12 of 13 closed, one held by a question', () => {
  it('(a) reads shipped, not failed: the run completed with its ship stamped', async () => {
    const { runId, version, recorded, held } = await shippedWithOneRefused();
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect((recorded.body.closed as string[]).length).toBe(12);
    expect(recorded.body.failed).toEqual([
      { id: held, reason: expect.stringContaining('question') },
    ]);
    const run = await runRow(runId);
    expect(run?.status).toBe('completed');
    expect(run?.released).not.toBeNull();
    expect(run?.metadata.failure).toBeUndefined();
    const page = await call('GET', `/releases/${version}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect((page.body.release as { state: string }).state).toBe('shipped');
  });

  it('(b) leaves the 13th at awaiting_release, named as the residue with the refusal that held it', async () => {
    const { runId, held, questionId, ids } = await shippedWithOneRefused();
    expect(await statusOf(held)).toBe('awaiting_release');
    for (const id of ids.slice(0, 12)) expect(await statusOf(id)).toBe('closed');
    const run = await runRow(runId);
    expect(run?.metadata.rosterUnclosed).toEqual([held]);
    const [hold] = await rows<{ code: string; reason: string; waiting_for: string }>(sql`
      SELECT code, reason, waiting_for FROM release_holds WHERE issue_id = ${held} AND cleared_at IS NULL`);
    expect(hold?.code).toBe('RELEASE_UNCLOSED_QUESTION');
    expect(hold?.reason).toContain('question');
    // and it names the record that closes it into this release once that lifts
    expect(hold?.reason).toContain('release-records');
    expect(hold?.waiting_for).toContain(questionId);
    // the run's own read names the residue, and no failure
    const state = await call('GET', `/release-batches/${runId}/state`);
    expect(state.status, JSON.stringify(state.body)).toBe(200);
    expect(state.body).toMatchObject({ runStatus: 'completed', failure: null, residue: [held] });
  });

  it('(c) closes the 13th into that release by a release-record once the question is answered, no repair', async () => {
    const { runId, held, questionId, version } = await shippedWithOneRefused();
    // still held: the same record is refused by the same question, and the release stays shipped
    const early = await record([held], version);
    expect(early.status, JSON.stringify(early.body)).toBe(201);
    expect(early.body.failed).toEqual([{ id: held, reason: expect.stringContaining('question') }]);
    expect(await statusOf(held)).toBe('awaiting_release');

    const answered = await api(world.token, 'POST', `/api/questions/${questionId}/answer`, {
      round: 1,
      text: 'Keep the old column for one release.',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(300);

    const closed = await record([held], version);
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    expect(closed.body).toMatchObject({ runId, version, closed: [held], failed: [] });
    expect(await statusOf(held)).toBe('closed');
    const run = await runRow(runId);
    expect(run?.metadata.rosterClosed).toContain(held);
    expect(run?.metadata.repair).toBeUndefined();
    expect(run?.status).toBe('completed');
    const [shippedIn] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pipeline_runs WHERE project_id = ${world.projectId}`);
    expect(shippedIn?.n, 'no second run was opened to close it').toBe(1);
  });

  it('refuses a residue record naming an issue the release does not hold, by name', async () => {
    const { version, ids } = await shippedWithOneRefused();
    const stray = await record([ids[0] as string], version);
    expect(codeOf(stray.body), JSON.stringify(stray.body)).toBe('RELEASE_RESIDUE_NOT_HELD');
  });
});

describe('(e) a promotion release that fails before its promotion merges', () => {
  it('reads failed, naming its code', async () => {
    const ids = await landedIssues(2);
    await promotionRequest(5137);
    const cut = await call('POST', '/release-batches', {
      issueIds: ids,
      promotion: { request: 5137 },
    });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    const runId = String(cut.body.runId);
    // the deploy can be recorded only once merged; a close before then ends the run unshipped
    const unmerged = await record(ids, String(cut.body.version));
    expect(codeOf(unmerged.body)).toBe('RELEASE_PROMOTION_UNMERGED');
    const { closeRunIfOneShot } = await import('../../src/pipeline/index.js');
    await closeRunIfOneShot(runId, 'completed');
    const run = await runRow(runId);
    expect(run?.status).toBe('failed');
    expect(run?.released).toBeNull();
    expect(run?.metadata.failure).toMatchObject({
      code: 'release_not_shipped',
      detail: expect.any(String),
    });
    // and the run's own read says why, where it once showed `failed` and nothing more
    const state = await call('GET', `/release-batches/${runId}/state`);
    expect(state.body).toMatchObject({
      runStatus: 'failed',
      failure: { code: 'release_not_shipped', detail: expect.any(String) },
      residue: [],
    });
  });
});

describe('a promotion merged and deployed whose whole roster is refused its close', () => {
  it('still reads shipped: the bytes are on production, and the roster waits as its residue', async () => {
    const ids = await landedIssues(1);
    await ask(ids[0] as string);
    await promotionRequest(5138);
    const cut = await call('POST', '/release-batches', {
      issueIds: ids,
      promotion: { request: 5138 },
    });
    const runId = String(cut.body.runId);
    await approve(runId);
    await mergedOnHost(5138);
    const recorded = await record(ids, String(cut.body.version));
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    const run = await runRow(runId);
    expect(run?.status).toBe('completed');
    expect(run?.released).not.toBeNull();
    expect(run?.metadata.failure).toBeUndefined();
    expect(run?.metadata.rosterUnclosed).toEqual(ids);
    expect(await statusOf(ids[0] as string)).toBe('awaiting_release');
  });
});
