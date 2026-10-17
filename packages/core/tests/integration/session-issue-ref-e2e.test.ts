/**
 * ISS-1228 — the sessions list names every issue a session holds by its key and title. Round 9: a
 * step session's chip read "Issue" for a session the Pipeline page showed on ISS-2. Round 10: a run
 * session the Pipeline page showed on its leased issues named none on the list, and one whose run's
 * ledger entry reported ISS-3 named none either. Read through the route the web reads, and the
 * Pipeline page's read, against a live database.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let ownerId: string;
let projectId: string;
let deviceId: string;
let jwt: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
  deviceId = (await createTestDevice(harness.db, ownerId)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(ownerId);
});

async function issue(project: string, seq: number, title: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${project}::uuid, ${seq}, ${title}, 'in_progress', ${ownerId}::uuid)
  `);
  return id;
}

async function stepSession(metadata: Record<string, unknown>): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}::uuid, 'system', 'running')
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title, metadata)
    VALUES (${id}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, 'pipeline', 'running', 'forge-code: x',
            ${JSON.stringify(metadata)}::jsonb)
  `);
  return id;
}

async function runSession(): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}::uuid, 'system', 'running')
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title)
    VALUES (${id}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, 'run_session', 'running', 'run: grp-1')
  `);
  return id;
}

async function lease(sessionId: string, seq: number): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO issue_leases (project_id, issue_key, session_id, device_id, run_id)
    SELECT ${projectId}::uuid, ${`ISS-${seq}`}, s.id, ${deviceId}::uuid, s.pipeline_run_id
      FROM agent_sessions s WHERE s.id = ${sessionId}::uuid
  `);
}

/** The run's own report of the issues it holds: `[seq, returned]` each, as the box's snapshot sends them. */
async function ledger(
  sessionId: string,
  runId: string,
  issues: Array<[number, boolean]>,
  filedUnder = projectId,
): Promise<void> {
  const reported = issues.map(([seq, leaseReturned]) => ({
    issueKey: `ISS-${seq}`,
    leaseReturned,
  }));
  await harness.db.execute(sql`
    INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id,
                                   incarnation, work, blocker_kind, waiting_on, issues, observed_at)
    VALUES (${deviceId}::uuid, ${runId}, ${filedUnder}::uuid, ${sessionId}::uuid, '/w', 'boot-1', 'live',
            'blocked', 'human', 'a decision on the schema', ${JSON.stringify(reported)}::jsonb, now())
  `);
}

async function prefix(): Promise<string | null> {
  const [project] = (await harness.db.execute(sql`
    SELECT issue_prefix FROM projects WHERE id = ${projectId}::uuid
  `)) as unknown as Array<{ issue_prefix: string | null }>;
  return project?.issue_prefix ?? null;
}

async function listed(): Promise<Map<string, unknown>> {
  const res = await fetch(`${server.baseUrl}/api/agent-sessions?projectId=${projectId}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ id: string; issues: unknown }> };
  return new Map(body.items.map((i) => [i.id, i.issues]));
}

describe("the sessions list names a session's issues (ISS-1228)", () => {
  it('gives a step session the key and title of the issue its job works', async () => {
    const issueId = await issue(projectId, 2, 'Rename the export column');
    const step = await stepSession({ jobType: 'drive', issueId });
    const { formatIssueRef } = await import('../../src/lib/issue-ref.js');
    expect((await listed()).get(step)).toEqual([
      {
        id: issueId,
        displayId: formatIssueRef(await prefix(), 2),
        title: 'Rename the export column',
        boxReturned: false,
      },
    ]);
  });

  it('gives a run session every issue it leases, in issue order', async () => {
    const four = await issue(projectId, 4, 'Four');
    const three = await issue(projectId, 3, 'Three');
    const run = await runSession();
    await lease(run, 4);
    await lease(run, 3);
    const { formatIssueRef } = await import('../../src/lib/issue-ref.js');
    const p = await prefix();
    expect((await listed()).get(run)).toEqual([
      { id: three, displayId: formatIssueRef(p, 3), title: 'Three', boxReturned: false },
      { id: four, displayId: formatIssueRef(p, 4), title: 'Four', boxReturned: false },
    ]);
  });

  it('names an issue a step session both leases and works once', async () => {
    const issueId = await issue(projectId, 5, 'Five');
    const step = await stepSession({ jobType: 'drive', issueId });
    await lease(step, 5);
    expect(((await listed()).get(step) as unknown[]).length).toBe(1);
  });

  it('names no issue for a session that records none', async () => {
    const step = await stepSession({ jobType: 'release_batch' });
    expect((await listed()).get(step)).toEqual([]);
  });

  it('names no issue another project holds, nor one for an id that matches no issue', async () => {
    const elsewhere = (await createTestProject(harness.db, ownerId)).id;
    const foreign = await stepSession({ issueId: await issue(elsewhere, 9, 'Not yours') });
    const junk = await stepSession({ issueId: 'not-a-uuid' });
    const rows = await listed();
    expect(rows.get(foreign)).toEqual([]);
    expect(rows.get(junk)).toEqual([]);
  });

  // ISS-1228 round 10: "run: quiet india" named no issue on the list while its Needs you row and
  // the runs tab showed it waiting on ISS-3 — the run's ledger entry named it, and no lease did.
  // Round 12: an issue the run returned and core let go is no longer the session's (judge-31 saw
  // r6 read "On ISS-2 ISS-3" after ISS-2 was returned).
  it('gives a run session the issues its ledger entry holds, once each, and none it returned', async () => {
    const three = await issue(projectId, 3, 'Three');
    await issue(projectId, 6, 'Six');
    const run = await runSession();
    await ledger(run, 'run-india', [
      [3, false],
      [6, true],
    ]);
    await ledger(run, 'run-india-again', [[3, false]]);
    const { formatIssueRef } = await import('../../src/lib/issue-ref.js');
    const p = await prefix();
    expect((await listed()).get(run)).toEqual([
      { id: three, displayId: formatIssueRef(p, 3), title: 'Three', boxReturned: false },
    ]);

    const { readSessionsAndHolds } = await import('../../src/pipeline/sessions-and-holds.js');
    const pipeline = await readSessionsAndHolds(projectId, new Date());
    expect(pipeline.sessions.find((s) => s.id === run)?.issues.map((i) => i.issueId)).toEqual([
      three,
    ]);
    expect(pipeline.holds.map((h) => [h.issueId, h.holders.map((x) => x.by)])).toEqual([
      [three, ['session']],
    ]);
  });

  // Round 12: core still held ISS-3 while r6's box called it returned. The hold stands, and every
  // read the screens take says the box returned it.
  it('keeps an issue core still leases though the run reports it returned, and says the box returned it', async () => {
    const two = await issue(projectId, 2, 'Two');
    const three = await issue(projectId, 3, 'Three');
    const run = await runSession();
    await lease(run, 3);
    await ledger(run, 'run-r6', [
      [2, true],
      [3, true],
    ]);
    const { formatIssueRef } = await import('../../src/lib/issue-ref.js');
    const p = await prefix();
    expect((await listed()).get(run)).toEqual([
      { id: three, displayId: formatIssueRef(p, 3), title: 'Three', boxReturned: true },
    ]);

    const { readSessionsAndHolds } = await import('../../src/pipeline/sessions-and-holds.js');
    const pipeline = await readSessionsAndHolds(projectId, new Date());
    expect(pipeline.sessions.find((s) => s.id === run)?.issues).toEqual([
      { issueId: three, displayId: formatIssueRef(p, 3), title: 'Three', boxReturned: true },
    ]);
    expect(pipeline.holds.map((h) => [h.issueId, h.holders])).toEqual([
      [three, [expect.objectContaining({ by: 'session', sessionId: run, boxReturned: true })]],
    ]);
    expect(pipeline.holds.some((h) => h.issueId === two)).toBe(false);

    // Through the route the web reads, under the suite's response-conformance gate, which refuses a
    // key the route's reference does not declare: judge-31 found `report.since` undeclared.
    const res = await fetch(`${server.baseUrl}/api/projects/${projectId}/sessions-and-holds`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const body = (await res.json()) as {
      sessions: Array<{ id: string; report: { since: string } | null }>;
    };
    expect([res.status, body.sessions.find((s) => s.id === run)?.report?.since]).toEqual([
      200,
      expect.any(String),
    ]);
  });

  it('says a leased issue is not returned where one of its ledger entries still holds it', async () => {
    await issue(projectId, 3, 'Three');
    const run = await runSession();
    await lease(run, 3);
    await ledger(run, 'run-a', [[3, true]]);
    await ledger(run, 'run-b', [[3, false]]);
    expect(((await listed()).get(run) as Array<{ boxReturned: boolean }>)[0]?.boxReturned).toBe(
      false,
    );
  });

  it('names an issue a lease and the ledger both name once, and none the ledger names in another project', async () => {
    await issue(projectId, 3, 'Three');
    const elsewhere = (await createTestProject(harness.db, ownerId)).id;
    await issue(elsewhere, 7, 'Not yours');
    const run = await runSession();
    await lease(run, 3);
    await ledger(run, 'run-1', [
      [3, false],
      [7, false],
    ]);
    expect(((await listed()).get(run) as Array<{ title: string }>).map((i) => i.title)).toEqual([
      'Three',
    ]);
  });

  it('names no issue from a ledger entry filed under another project than its session', async () => {
    await issue(projectId, 3, 'Three');
    const elsewhere = (await createTestProject(harness.db, ownerId)).id;
    await issue(elsewhere, 3, 'Their three');
    const run = await runSession();
    await ledger(run, 'run-astray', [[3, false]], elsewhere);
    expect((await listed()).get(run)).toEqual([]);
    const { readSessionsAndHolds } = await import('../../src/pipeline/sessions-and-holds.js');
    const pipeline = await readSessionsAndHolds(projectId, new Date());
    expect(pipeline.sessions.find((s) => s.id === run)?.issues).toEqual([]);
    expect(pipeline.holds).toEqual([]);
  });
});
