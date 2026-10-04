/**
 * ISS-30 — a session a schedule starts runs as the schedule's owner (a manual run: as the person
 * who pressed run), not as whoever paired the box it lands on.
 *
 * Driven through the mounted app, the schedule ticker and a real database. The box is paired by
 * the project's admin; the schedule belongs to a member. What the session reaches Forge with is
 * what a runner puts in its MCP config: the `forgeToken` its frame carries, or — where it carries
 * none — the personal access token the box's holder stored on it (`runner/claude_code.rs`).
 */

import { eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  type OpenDeviceSocket,
  openDeviceSocket,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let m: {
  jwt: typeof import('../../src/auth/jwt.js');
  pat: typeof import('../../src/auth/pat.js');
  credential: typeof import('../../src/devices/credential.js');
  schema: typeof import('../../src/db/schema.js');
  routes: typeof import('../../src/schedules/routes.js');
  failover: typeof import('../../src/schedules/failover.js');
};

let adminId: string;
let projectId: string;
let deviceId: string;
let boxToken: string;
let holderPat: string;
let sockets: OpenDeviceSocket[];
let socket: OpenDeviceSocket;

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
  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
  app = (await import('../../src/index.js')).app as unknown as Hono<AppVars>;
  m = {
    jwt: await import('../../src/auth/jwt.js'),
    pat: await import('../../src/auth/pat.js'),
    credential: await import('../../src/devices/credential.js'),
    schema: await import('../../src/db/schema.js'),
    routes: await import('../../src/schedules/routes.js'),
    failover: await import('../../src/schedules/failover.js'),
  };
}, 180_000);

afterAll(async () => {
  await harness?.cleanup?.();
});

async function person(role: 'admin' | 'member' | 'viewer' | null): Promise<string> {
  const id = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  if (role) await createTestProjectMember(harness.db, { userId: id, projectId, role });
  return id;
}

async function setRole(userId: string, role: 'admin' | 'member' | 'viewer' | null) {
  await harness.db.execute(
    sql`DELETE FROM project_members WHERE user_id = ${userId} AND project_id = ${projectId}`,
  );
  if (role) await createTestProjectMember(harness.db, { userId, projectId, role });
}

/** A box paired by `holder`, bound to the project, live, declaring what its runner carries. */
async function boxPairedBy(holder: string, capabilities: Record<string, boolean>) {
  const device = await createTestDevice(harness.db, holder);
  await bindTestRunner(harness.db, { projectId, deviceId: device.id });
  await harness.db.execute(sql`UPDATE runners SET last_seen_at = now()`);
  await harness.db.execute(
    sql`UPDATE devices SET capabilities = ${JSON.stringify(capabilities)}::jsonb WHERE id = ${device.id}`,
  );
  const token = await m.credential.issueDeviceCredential({
    deviceId: device.id,
    holderUserId: holder,
  });
  const opened = openDeviceSocket(device.id);
  sockets.push(opened);
  return { id: device.id, token, socket: opened };
}

beforeEach(async () => {
  await truncateAll(harness.db);
  sockets = [];
  adminId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, adminId);
  const project = await createTestProject(harness.db, adminId, { orgId: org.id });
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId: adminId, projectId, role: 'admin' });
  const box = await boxPairedBy(adminId, { turnCredential: true, followUpCredential: true });
  deviceId = box.id;
  boxToken = box.token;
  socket = box.socket;
  holderPat = (await m.pat.mintPat({ userId: adminId, name: 'forge-runner login' })).plaintext;
});

afterEach(() => {
  for (const s of sockets) s.close();
});

async function as(userId: string): Promise<string> {
  return m.jwt.signUserToken(userId);
}

function call(method: string, path: string, bearer: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sessionCredentialOf(frame: { data: unknown } | undefined): string {
  if (!frame) throw new Error('no frame reached the box');
  return (frame.data as { forgeToken?: string }).forgeToken ?? holderPat;
}

function lastStart(on: OpenDeviceSocket = socket) {
  return [...on.frames].reverse().find((f) => f.event === 'agent:start');
}

/**
 * A schedule owned by `owner`. Creating one takes an admin, so a member's schedule is one an
 * admin created and then stopped being admin over: the owner is promoted for the create and set
 * to `ownerRole` after it.
 */
async function scheduleOwnedBy(
  owner: string,
  ownerRole: 'admin' | 'member' | 'viewer' | null,
): Promise<string> {
  await setRole(owner, 'admin');
  const res = await call('POST', '/api/schedules', await as(owner), {
    projectId,
    name: 'nightly tidy',
    cron: '0 3 * * *',
    prompt: 'tidy the backlog',
  });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await setRole(owner, ownerRole);
  return id;
}

/** Fire the ticker for `scheduleId` as cron would. */
async function tick(scheduleId: string): Promise<void> {
  const now = new Date();
  await harness.db
    .update(m.schema.schedules)
    .set({ nextRunAt: new Date(now.getTime() - 60_000) })
    .where(eq(m.schema.schedules.id, scheduleId));
  await m.routes.runScheduleTickOnce(now);
}

async function scheduleRow(scheduleId: string) {
  const [row] = await harness.db
    .select()
    .from(m.schema.schedules)
    .where(eq(m.schema.schedules.id, scheduleId));
  if (!row) throw new Error(`schedule ${scheduleId} is gone`);
  return row;
}

async function sessionRow(sessionId: string) {
  const [row] = await harness.db
    .select()
    .from(m.schema.agentSessions)
    .where(eq(m.schema.agentSessions.id, sessionId));
  if (!row) throw new Error(`session ${sessionId} is gone`);
  return row;
}

/** One tool call through `/mcp`, the door a session's `forge` server and CLI reach Forge by. */
async function mcpTool(
  bearer: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const [project] = await harness.db
    .select({ slug: m.schema.projects.slug })
    .from(m.schema.projects)
    .where(eq(m.schema.projects.id, projectId));
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forge-project-slug': project?.slug ?? '',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const out = (await res.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  return {
    isError: out.result.isError ?? false,
    text: out.result.content.map((c) => c.text).join('\n'),
  };
}

async function colleaguesComment(): Promise<{ issueId: string; commentId: string }> {
  const colleague = await person('member');
  const filed = await call('POST', `/api/projects/${projectId}/issues`, await as(colleague), {
    title: 'an issue a colleague filed',
  });
  expect(filed.status).toBe(201);
  const issueId = ((await filed.json()) as { id: string }).id;
  const posted = await call('POST', `/api/issues/${issueId}/comments`, await as(colleague), {
    body: 'a colleague wrote this',
  });
  expect(posted.status).toBe(201);
  return { issueId, commentId: ((await posted.json()) as { id: string }).id };
}

async function commentExists(id: string): Promise<boolean> {
  const rows = await harness.db
    .select({ id: m.schema.comments.id })
    .from(m.schema.comments)
    .where(eq(m.schema.comments.id, id));
  return rows.length === 1;
}

/** What a refused run leaves where a schedule's failures are read: its last run, failed, coded. */
async function expectRefusedRun(scheduleId: string, code: string): Promise<void> {
  const schedule = await scheduleRow(scheduleId);
  expect(schedule.lastStatus).toBe('failed');
  expect(schedule.lastSessionId).not.toBeNull();
  const session = await sessionRow(schedule.lastSessionId as string);
  expect(session.status).toBe('failed');
  expect(session.failureReason).toBe('session_authority_refused');
  expect(session.failureDetail).toMatch(new RegExp(`^${code}: `));
  const read = await call(
    'GET',
    `/api/projects/${projectId}/automation/schedules/${scheduleId}`,
    await as(adminId),
  );
  const listed = ((await read.json()) as { fires: Array<Record<string, unknown>> }).fires;
  expect(listed[0]).toMatchObject({ status: 'failed', refusal: code });
  expect(String(listed[0]?.error)).toMatch(new RegExp(`^session_authority_refused: ${code}: `));
}

describe("a member's schedule on a box an admin paired", () => {
  it("runs as the member: the colleague's comment survives, the member's own write lands", async () => {
    const { issueId, commentId } = await colleaguesComment();
    const owner = await person('member');
    const scheduleId = await scheduleOwnedBy(owner, 'member');

    await tick(scheduleId);
    const credential = sessionCredentialOf(lastStart());

    const erase = await mcpTool(credential, 'forge_comments', {
      action: 'delete',
      documentId: commentId,
    });
    expect(erase.text).toContain('only the comment author or a project admin can delete');
    expect(erase.isError).toBe(true);
    expect(await commentExists(commentId)).toBe(true);

    const own = await mcpTool(credential, 'forge_comments', {
      action: 'create',
      data: { issue: issueId, body: 'the scheduled session wrote this' },
    });
    expect(own.isError, own.text).toBe(false);
    const [authored] = await harness.db
      .select({ authorId: m.schema.comments.authorId })
      .from(m.schema.comments)
      .where(eq(m.schema.comments.body, 'the scheduled session wrote this'));
    expect(authored?.authorId).toBe(owner);

    const schedule = await scheduleRow(scheduleId);
    const session = await sessionRow(schedule.lastSessionId as string);
    expect(session.userId).toBe(owner);
    const verified = await m.pat.verifyPat(credential);
    expect(verified?.row.userId).toBe(owner);
    expect(verified?.row.name).toBe(`turn:${session.id}`);
    expect(verified?.row.deviceId).toBe(deviceId);
    expect(verified?.row.boundProjectId).toBe(projectId);
  });

  it('a run a member presses runs as that member, whoever owns the schedule', async () => {
    const { commentId } = await colleaguesComment();
    const scheduleId = await scheduleOwnedBy(adminId, 'admin');
    const presser = await person('member');

    const res = await call('POST', `/api/schedules/${scheduleId}/run`, await as(presser));
    expect(res.status).toBe(202);
    const credential = sessionCredentialOf(lastStart());

    expect((await m.pat.verifyPat(credential))?.row.userId).toBe(presser);
    const erase = await mcpTool(credential, 'forge_comments', {
      action: 'delete',
      documentId: commentId,
    });
    expect(erase.isError).toBe(true);
    expect(await commentExists(commentId)).toBe(true);
  });

  it("an admin's schedule on a box a member holds is refused, never handed an admin's token", async () => {
    const holder = await person('member');
    await harness.db.execute(sql`DELETE FROM runners WHERE device_id = ${deviceId}`);
    const memberBox = await boxPairedBy(holder, { turnCredential: true, followUpCredential: true });
    const scheduleId = await scheduleOwnedBy(adminId, 'admin');

    await tick(scheduleId);

    expect(memberBox.socket.frames).toHaveLength(0);
    await expectRefusedRun(scheduleId, 'TURN_DEVICE_OUTRANKED');
  });
});

describe('a schedule whose owner may no longer be acted as is refused by name', () => {
  it('an owner who lost their role', async () => {
    const scheduleId = await scheduleOwnedBy(await person(null), null);
    await tick(scheduleId);
    expect(socket.frames).toHaveLength(0);
    await expectRefusedRun(scheduleId, 'SESSION_NO_ROLE');
  });

  it('an owner who is now a viewer', async () => {
    const scheduleId = await scheduleOwnedBy(await person(null), 'viewer');
    await tick(scheduleId);
    expect(socket.frames).toHaveLength(0);
    await expectRefusedRun(scheduleId, 'SESSION_VIEWER');
  });

  it('an owner whose account is gone', async () => {
    const owner = await person(null);
    const scheduleId = await scheduleOwnedBy(owner, null);
    await harness.db.execute(sql`DELETE FROM users WHERE id = ${owner}`);
    expect((await scheduleRow(scheduleId)).ownerId).toBeNull();

    await tick(scheduleId);
    expect(socket.frames).toHaveLength(0);
    await expectRefusedRun(scheduleId, 'SCHEDULE_OWNER_GONE');
  });

  it('a box whose runner cannot carry the token, rather than spend its holder’s', async () => {
    await harness.db.execute(sql`UPDATE devices SET capabilities = '{}'::jsonb`);
    const scheduleId = await scheduleOwnedBy(await person(null), 'member');
    await tick(scheduleId);
    expect(socket.frames).toHaveLength(0);
    await expectRefusedRun(scheduleId, 'RUNNER_OUTDATED');
  });

  it('a box that carries a first turn’s token is enough: a schedule sends no follow-up', async () => {
    await harness.db.execute(
      sql`UPDATE devices SET capabilities = '{"turnCredential": true}'::jsonb`,
    );
    const owner = await person(null);
    const scheduleId = await scheduleOwnedBy(owner, 'member');
    await tick(scheduleId);
    expect((await m.pat.verifyPat(sessionCredentialOf(lastStart())))?.row.userId).toBe(owner);
  });

  it('a manual run is refused to its presser by the same code, and recorded', async () => {
    await harness.db.execute(sql`UPDATE devices SET capabilities = '{}'::jsonb`);
    const scheduleId = await scheduleOwnedBy(adminId, 'admin');
    const res = await call('POST', `/api/schedules/${scheduleId}/run`, await as(adminId));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('RUNNER_OUTDATED');
    await expectRefusedRun(scheduleId, 'RUNNER_OUTDATED');
  });
});

describe('failover carries the owner to the next box', () => {
  async function failedOnFirstBox(owner: string) {
    const scheduleId = await scheduleOwnedBy(owner, 'member');
    await tick(scheduleId);
    const first = sessionCredentialOf(lastStart());
    const sessionId = (await scheduleRow(scheduleId)).lastSessionId as string;
    const failed = await call('PATCH', `/api/agent-sessions/${sessionId}`, boxToken, {
      status: 'failed',
    });
    expect(failed.status).toBe(200);
    expect(await m.pat.verifyPat(first)).toBeNull();
    return { scheduleId, sessionId };
  }

  it('re-dispatches under a fresh token for the owner, tied to the new box', async () => {
    const owner = await person('member');
    const { sessionId } = await failedOnFirstBox(owner);
    const second = await boxPairedBy(adminId, { turnCredential: true });

    const result = await m.failover.redispatchScheduleSessionOnFailover(sessionId);
    expect(result).toMatchObject({ ok: true, status: 'redispatched', deviceId: second.id });
    const token = sessionCredentialOf(lastStart(second.socket));
    const verified = await m.pat.verifyPat(token);
    expect(verified?.row.userId).toBe(owner);
    expect(verified?.row.deviceId).toBe(second.id);
    expect(verified?.row.name).toBe(`turn:${result.ok ? result.sessionId : ''}`);
  });

  it('does not re-dispatch an owner who lost their role since, and says why', async () => {
    const owner = await person('member');
    const { sessionId } = await failedOnFirstBox(owner);
    const second = await boxPairedBy(adminId, { turnCredential: true });
    await setRole(owner, null);

    const result = await m.failover.redispatchScheduleSessionOnFailover(sessionId, {
      failureClass: 'usage/session limit',
    });
    expect(result).toMatchObject({
      ok: false,
      status: 'authority-refused',
      code: 'SESSION_NO_ROLE',
    });
    expect(second.socket.frames).toHaveLength(0);
    expect((await sessionRow(sessionId)).failureDetail).toBe(
      'usage/session limit → no failover (SESSION_NO_ROLE: the run may no longer act as the person it ran as)',
    );
  });

  it('does not hand the owner’s token to a box that cannot carry it', async () => {
    const owner = await person('member');
    const { sessionId } = await failedOnFirstBox(owner);
    const second = await boxPairedBy(adminId, {});
    const result = await m.failover.redispatchScheduleSessionOnFailover(sessionId);
    expect(result).toMatchObject({
      ok: false,
      status: 'authority-refused',
      code: 'RUNNER_OUTDATED',
    });
    expect(second.socket.frames).toHaveLength(0);
  });
});

describe("a scheduled session's token dies with it (migration 0324)", () => {
  async function liveScheduledTurn(): Promise<{ sessionId: string; token: string }> {
    const scheduleId = await scheduleOwnedBy(await person(null), 'member');
    await tick(scheduleId);
    const token = sessionCredentialOf(lastStart());
    expect(token).not.toBe(holderPat);
    expect(await m.pat.verifyPat(token)).not.toBeNull();
    return { sessionId: (await scheduleRow(scheduleId)).lastSessionId as string, token };
  }

  it('on the runner reporting it completed', async () => {
    const { sessionId, token } = await liveScheduledTurn();
    await call('PATCH', `/api/agent-sessions/${sessionId}`, boxToken, { status: 'completed' });
    expect(await m.pat.verifyPat(token)).toBeNull();
  });

  it('on a reap that writes the row directly', async () => {
    const { sessionId, token } = await liveScheduledTurn();
    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'cancelled_stale' WHERE id = ${sessionId}`,
    );
    expect(await m.pat.verifyPat(token)).toBeNull();
  });

  it('on the session being deleted', async () => {
    const { sessionId, token } = await liveScheduledTurn();
    await harness.db.execute(sql`DELETE FROM agent_sessions WHERE id = ${sessionId}`);
    expect(await m.pat.verifyPat(token)).toBeNull();
  });

  it('and not while it runs', async () => {
    const { sessionId, token } = await liveScheduledTurn();
    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'running' WHERE id = ${sessionId}`,
    );
    expect(await m.pat.verifyPat(token)).not.toBeNull();
  });
});
