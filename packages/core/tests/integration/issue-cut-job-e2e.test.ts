/**
 * ISS-1228 — what an issue's end does to the jobs still working it, read through the doors a mover
 * really has. Round 21 (judge-67, criterion 216): a job its issue's end cuts short ends cancelled,
 * naming why. Round 22 (judge-71, criteria 217 and 231): the same agent account dropping an issue
 * ended its job done over REST and cancelled over MCP, because the MCP door wrote the token's row id
 * as a box; and a job the cut ended done was still sent a cancel. Every actor here is built by the
 * auth path a real caller goes through — a person's session, an agent account's token, and a box's
 * checkout credential, each over REST and over MCP — never handed to the kernel as a shape.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectId: string;
let ownerId: string;
let boxA: string;
let boxB: string;
let seq = 0;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_PAT_READ_MAX = '100000';
  process.env.RATE_LIMIT_PAT_WRITE_MAX = '100000';
  ({ app } = (await import('../../src/index.js')) as unknown as { app: Hono<AppVars> });
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  seq = 0;
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  const { pairDevice } = await import('../helpers/pair-device.js');
  boxA = (await pairDevice({ ownerId, name: 'box-a', platform: 'linux' })).device.id;
  boxB = (await pairDevice({ ownerId, name: 'box-b', platform: 'linux' })).device.id;
});

type Door = 'rest' | 'mcp';

/** A person's session: what the web sends. */
async function personCredential(): Promise<string> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return signUserToken(ownerId);
}

/** An agent account of the project's org, holding a token of its own and naming no box. */
async function agentCredential(): Promise<string> {
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  await createTestProjectMember(harness.db, { userId: agent.id, projectId, role: 'member' });
  const { mintPat } = await import('../../src/auth/pat.js');
  return (await mintPat({ userId: agent.id, name: 'an agent account', scopes: ['read', 'write'] }))
    .plaintext;
}

/** The credential a box's checkout carries in its `.mcp.json`, as the box's provisioning mints it. */
async function checkoutCredential(deviceId: string): Promise<string> {
  const { issueWorkspaceCredential } = await import('../../src/devices/workspace-credential.js');
  return issueWorkspaceCredential({ deviceId, projectId, holderUserId: ownerId });
}

interface Worked {
  issueId: string;
  runId: string;
  jobs: Record<'a' | 'b', { jobId: string; sessionId: string }>;
}

/** An issue in progress whose run has a job working on each box, each with its live session: one issue
 *  holds one live job of a type, so box B's is a custom step beside box A's drive. */
async function workedIssue(): Promise<Worked> {
  seq += 1;
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, ${seq}, 'Scratch cut-off target', 'in_progress', ${ownerId})
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
    VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running')
  `);
  const on = async (deviceId: string, type: 'drive' | 'custom') => {
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, started_at,
                                  last_heartbeat_at)
      VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'running', now(), now())
    `);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, device_id, agent_session_id, created_by,
                        type, status, dispatched_at, acked_at, payload)
      VALUES (${jobId}, ${projectId}, ${runId}, ${issueId}, ${deviceId}, ${sessionId}, ${ownerId},
              ${type}, 'running', now(), now(), '{}'::jsonb)
    `);
    return { jobId, sessionId };
  };
  return { issueId, runId, jobs: { a: await on(boxA, 'drive'), b: await on(boxB, 'custom') } };
}

/** Drop the issue through one door with one credential, and require that the door took it. */
async function drop(door: Door, credential: string, issueId: string): Promise<void> {
  const reason = 'Not wanted any more.';
  if (door === 'rest') {
    const res = await app.request(`/api/issues/${issueId}/transition`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toStatus: 'dropped', reason }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return;
  }
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'forge_issues',
        arguments: {
          action: 'transition',
          documentId: issueId,
          data: { status: 'dropped', reason },
        },
      },
    }),
  });
  expect(res.status).toBe(200);
  const out = (await res.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(out.result.isError ?? false, out.result.content.map((c) => c.text).join('\n')).toBe(false);
}

/** What the record says of a job and its session, and whether core asked its box to cancel it. */
async function jobOf(ids: { jobId: string; sessionId: string }) {
  const [job] = await harness.db.execute<{
    status: string;
    failure_reason: string | null;
    cancel_asked: boolean;
  }>(
    sql`SELECT status, failure_reason, kill_requested_at IS NOT NULL AS cancel_asked FROM jobs WHERE id = ${ids.jobId}`,
  );
  const [session] = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM agent_sessions WHERE id = ${ids.sessionId}`,
  );
  return { ...job, session: session?.status };
}

async function runStatus(runId: string): Promise<string | undefined> {
  const [run] = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`,
  );
  return run?.status;
}

const CUT = {
  status: 'cancelled',
  failure_reason: 'issue_dropped',
  cancel_asked: true,
  session: 'cancelled',
};
const OWN_ACT = { status: 'done', failure_reason: null, cancel_asked: false, session: 'completed' };

describe('a job its issue’s end cut off reads cut off (criterion 216)', () => {
  it('ends every job a person’s drop cut short as cancelled for that, asks each box to stop, and stops the run', async () => {
    const worked = await workedIssue();
    await drop('rest', await personCredential(), worked.issueId);

    expect(await jobOf(worked.jobs.a)).toEqual(CUT);
    expect(await jobOf(worked.jobs.b)).toEqual(CUT);
    expect(await runStatus(worked.runId)).toBe('cancelled');

    const res = await app.request(`/api/pipeline-runs/${worked.runId}`, {
      headers: { authorization: `Bearer ${await personCredential()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      attempts: Array<{ status: string; failureReason: string | null }>;
    };
    expect(body.status).toBe('cancelled');
    expect(body.attempts[0]).toMatchObject({ status: 'cancelled', failureReason: 'issue_dropped' });
  });
});

describe('the mover’s own jobs end done, whichever door it used (criteria 217, 231)', () => {
  for (const door of ['rest', 'mcp'] as const) {
    it(`ends every job done when an agent account that names no box drops the issue over ${door}, and asks no box to cancel`, async () => {
      const worked = await workedIssue();
      await drop(door, await agentCredential(), worked.issueId);

      expect(await jobOf(worked.jobs.a)).toEqual(OWN_ACT);
      expect(await jobOf(worked.jobs.b)).toEqual(OWN_ACT);
      expect(await runStatus(worked.runId)).toBe('cancelled');
    });

    it(`ends the job of the box whose checkout dropped the issue over ${door} done, and cuts the other box’s`, async () => {
      const worked = await workedIssue();
      await drop(door, await checkoutCredential(boxA), worked.issueId);

      expect(await jobOf(worked.jobs.a)).toEqual(OWN_ACT);
      expect(await jobOf(worked.jobs.b)).toEqual(CUT);
      expect(await runStatus(worked.runId)).toBe('cancelled');
    });
  }
});

describe('a close the deploy gate held back (criterion 222)', () => {
  it('cuts, when the close finishes, the jobs it would have cut at once', async () => {
    const worked = await workedIssue();
    const hold = {
      bindingId: 'b-1',
      deploymentUuid: 'd-1',
      targetLabel: 'web',
      status: 'pending',
      deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    };
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET metadata = jsonb_build_object('__forge_deploy_confirm', jsonb_build_object('target:d-1', ${JSON.stringify(hold)}::jsonb))
       WHERE id = ${worked.runId}
    `);
    const { closeOpenRunForIssue, closeRun } = await import('../../src/pipeline/runs.js');
    const held = await closeOpenRunForIssue(worked.issueId, 'completed', {
      cause: 'issue_closed',
      spares: 'none',
    });
    expect(held).toBe('deferred');
    expect((await jobOf(worked.jobs.a)).status).toBe('running');

    // What the deploy's confirmation does once its last target succeeds (integrations/coolify/confirm.ts).
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET metadata = jsonb_set(metadata, '{__forge_deploy_confirm,target:d-1,status}', '"succeeded"')
       WHERE id = ${worked.runId}
    `);
    expect(await closeRun(worked.runId, 'completed')).toBe('settled');

    expect(await runStatus(worked.runId)).toBe('completed');
    const closed = {
      status: 'cancelled',
      failure_reason: 'issue_closed',
      cancel_asked: true,
      session: 'cancelled',
    };
    expect(await jobOf(worked.jobs.a)).toEqual(closed);
    expect(await jobOf(worked.jobs.b)).toEqual(closed);
  });
});
