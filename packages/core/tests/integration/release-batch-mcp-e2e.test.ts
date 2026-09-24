/**
 * A release run records its batch on the credential its pane already holds (ISS-1211).
 *
 * The pane of a `release_batch` job holds one Forge credential: the per-(device × project)
 * workspace PAT `issueWorkspaceCredential` mints into the provisioned checkout's `.mcp.json`.
 * Every case below authenticates `/mcp` with exactly that token — minted by the same function —
 * and nothing else, which is what a box holding only what its daemon holds can present.
 */

import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

interface ToolAnswer {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | undefined;
}

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectId: string;
let ownerId: string;
let workspaceToken: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  await registerIntegrationsForTest();
  ({ app } = await import('../../src/index.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

async function workspaceCredentialFor(project: string): Promise<string> {
  const { issueWorkspaceCredential } = await import('../../src/devices/workspace-credential.js');
  const device = await createTestDevice(harness.db, ownerId, { status: 'online' });
  return issueWorkspaceCredential({
    deviceId: device.id,
    projectId: project,
    holderUserId: ownerId,
  });
}

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await fx.declareProduction();
  await fx.seedReleaseRunner();
  workspaceToken = await workspaceCredentialFor(projectId);
});

async function rpc(token: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function call(token: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const out = await rpc(token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'forge_release_batch', arguments: { projectId, ...args } },
  });
  const result = out.result as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
  };
  return {
    isError: result.isError === true,
    text: result.content.map((c) => c.text).join('\n'),
    structured: result.structuredContent,
  };
}

/**
 * A batch whose run has announced no method, as a job pane first finds it. Cut through the
 * fixture so its probe moves to the pushed build, then the announcement it makes is taken back.
 */
async function unannouncedBatch(issueIds: string[]): Promise<string> {
  const { runId } = await fx.claim(issueIds);
  await harness.db.execute(
    sql`UPDATE pipeline_runs SET metadata = metadata - 'method' WHERE id = ${runId}`,
  );
  return runId;
}

/**
 * `finish` takes the attempt and answers; the job does the work. Here the job runs inline, and the
 * verdict is read back the way a release run reads it: the tool's own `state` action.
 */
async function workDone(runId: string): Promise<{
  state: string;
  closed: string[] | null;
  failed: unknown[] | null;
}> {
  const { runReleaseBatchFinish } = await import('../../src/release-batch/finish-job.js');
  await runReleaseBatchFinish(runId);
  const state = await call(workspaceToken, { action: 'state', runId });
  expect(state.isError, state.text).toBe(false);
  return state.structured?.finish as {
    state: string;
    closed: string[] | null;
    failed: unknown[] | null;
  };
}

describe('forge_release_batch over /mcp on the workspace credential', () => {
  it('is listed by the running server', async () => {
    const out = await rpc(workspaceToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (out.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('forge_release_batch');
  });

  it('finishes a batch, closing every issue it claimed', async () => {
    const a = await fx.insertIssue();
    const b = await fx.insertIssue();
    const { runId } = await fx.claim([a, b]);

    const answer = await call(workspaceToken, { action: 'finish', runId });

    expect(answer.isError, answer.text).toBe(false);
    expect(answer.structured).toMatchObject({ runId, finish: { state: 'accepted' } });
    const verdict = await workDone(runId);
    expect(verdict.state).toBe('finished');
    expect((verdict.closed ?? []).sort()).toEqual([a, b].sort());
    expect(verdict.failed).toEqual([]);
    for (const id of [a, b]) expect((await fx.stored(id)).status).toBe('closed');
  });

  it('aborts a batch, releasing every claim and closing nothing', async () => {
    const a = await fx.insertIssue();
    const { runId } = await fx.claim([a]);
    expect((await fx.stored(a)).status).toBe('releasing');

    const answer = await call(workspaceToken, { action: 'abort', runId, reason: 'deploy failed' });

    expect(answer.isError, answer.text).toBe(false);
    expect(answer.structured).toMatchObject({ aborted: true, releasedIds: [a] });
    const after = await fx.stored(a);
    expect(after.status).toBe('awaiting_release');
    expect(after.claim).toBeNull();
  });

  it('reads the batch context the REST route serves', async () => {
    const { loadReleaseBatchContext } = await import('../../src/release-batch/service.js');
    const a = await fx.insertIssue();
    const { runId } = await fx.claim([a]);

    const answer = await call(workspaceToken, { action: 'get', runId });

    expect(answer.isError, answer.text).toBe(false);
    expect(answer.structured).toEqual(
      JSON.parse(JSON.stringify(await loadReleaseBatchContext(runId))),
    );
  });

  it('reads the run state the REST route serves', async () => {
    const a = await fx.insertIssue();
    const { runId } = await fx.claim([a]);

    const answer = await call(workspaceToken, { action: 'state', runId });

    expect(answer.isError, answer.text).toBe(false);
    expect(answer.structured).toMatchObject({
      runId,
      projectId,
      method: { skill: 'release-flow' },
    });
  });

  it('refuses finish on a run that announced no method, naming action=method as the way out', async () => {
    const a = await fx.insertIssue();
    const runId = await unannouncedBatch([a]);

    const answer = await call(workspaceToken, { action: 'finish', runId });

    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(
      /RELEASE_METHOD_NOT_ANNOUNCED: .*forge_release_batch action=method/,
    );
    expect((await fx.stored(a)).status).toBe('releasing');
  });

  it('records the announcement finish reads, and finish then closes', async () => {
    const { readRunMethod } = await import('../../src/release-batch/method.js');
    const a = await fx.insertIssue();
    const runId = await unannouncedBatch([a]);

    const announced = await call(workspaceToken, {
      action: 'method',
      runId,
      skill: 'release-flow',
      loaded: true,
    });
    expect(announced.isError, announced.text).toBe(false);
    expect(await readRunMethod(runId)).toMatchObject({ skill: 'release-flow', loaded: true });

    const finished = await call(workspaceToken, { action: 'finish', runId });
    expect(finished.isError, finished.text).toBe(false);
    expect((await workDone(runId)).closed).toEqual([a]);
  });

  it('refuses finish with RELEASE_NOT_VERIFIED and the live reading when the probes disagree', async () => {
    const a = await fx.insertIssue();
    const { runId } = await fx.claim([a]);

    const answer = await call(workspaceToken, {
      action: 'finish',
      runId,
      commit: 'a-commit-the-probe-is-not-serving',
    });

    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/^Error: RELEASE_NOT_VERIFIED: /);
    expect(answer.text).toContain('"live"');
    expect((await fx.stored(a)).status).toBe('releasing');
  });

  it('refuses a token without the write scope at get, before returning anything', async () => {
    const { mintPat } = await import('../../src/auth/pat.js');
    const readOnly = (
      await mintPat({
        userId: ownerId,
        name: 'read-only',
        scopes: ['read'],
        projectIds: [projectId],
      })
    ).plaintext;
    const a = await fx.insertIssue();
    const { runId } = await fx.claim([a]);

    const answer = await call(readOnly, { action: 'get', runId });

    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/RELEASE_CREDENTIAL_CANNOT_RECORD: .*could not finish or abort/);
    expect(answer.text).not.toContain(runId);
  });
});

describe('refuses on every action', () => {
  const actions = [
    { action: 'get' },
    { action: 'state' },
    { action: 'method', skill: 'release-flow', loaded: true },
    { action: 'finish' },
    { action: 'abort', reason: 'probe' },
  ];

  it('a token fenced to a different project, as not found', async () => {
    const other = (await createTestProject(harness.db, ownerId)).id;
    const fenced = await workspaceCredentialFor(other);
    const a = await fx.insertIssue();
    const { runId } = await fx.claim([a]);

    for (const args of actions) {
      const answer = await call(fenced, { ...args, runId });
      expect(answer.isError, args.action).toBe(true);
      expect(answer.text, args.action).toMatch(/not found or not accessible/);
    }
    expect((await fx.stored(a)).status).toBe('releasing');
  });

  it('a caller whose role on the project is viewer', async () => {
    const { mintPat } = await import('../../src/auth/pat.js');
    const viewer = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, { projectId, userId: viewer.id, role: 'viewer' });
    const token = (await mintPat({ userId: viewer.id, name: 'viewer', projectIds: [projectId] }))
      .plaintext;
    const a = await fx.insertIssue();
    const { runId } = await fx.claim([a]);

    for (const args of actions) {
      const answer = await call(token, { ...args, runId });
      expect(answer.isError, args.action).toBe(true);
      expect(answer.text, args.action).toMatch(/requires project member access/);
    }
    expect((await fx.stored(a)).status).toBe('releasing');
  });

  it('a runId that is not a release-batch run of this project, as not found', async () => {
    const other = (await createTestProject(harness.db, ownerId)).id;
    const foreign = '66666666-6666-4666-8666-666666666666';
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
      VALUES (${foreign}, ${other}, 'system', 'running', '{"source":"release-batch"}'::jsonb)
    `);
    const unknown = '55555555-5555-4555-8555-555555555555';
    for (const runId of [unknown, foreign]) {
      for (const args of actions) {
        const answer = await call(workspaceToken, { ...args, runId });
        expect(answer.isError, `${args.action} ${runId}`).toBe(true);
        expect(answer.text, `${args.action} ${runId}`).toMatch(
          /release batch not found in this project/,
        );
      }
    }
    expect(await fx.runStatus(foreign)).toBe('running');
  });
});
