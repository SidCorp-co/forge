/**
 * ISS-27 — an agent session started from the web runs as the person who started it, not as
 * whoever paired the box it lands on.
 *
 * Driven through the mounted app and a real database. The box is paired by the project's admin;
 * a member starts the session. What the session reaches Forge with is what a runner would put in
 * its MCP config: the `forgeToken` its frame carries, or — where the frame carries none — the
 * personal access token the box's holder stored on it (`runner/claude_code.rs`: `spec.credential`
 * else `mcp::config::job_credential`, which refuses the device token itself).
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
};

let adminId: string;
let memberId: string;
let projectId: string;
let projectSlug: string;
let deviceId: string;
let boxToken: string;
let holderPat: string;
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
  return { id: device.id, token };
}

beforeEach(async () => {
  await truncateAll(harness.db);
  adminId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, adminId);
  const project = await createTestProject(harness.db, adminId, { orgId: org.id });
  projectId = project.id;
  projectSlug = project.slug;
  await createTestProjectMember(harness.db, { userId: adminId, projectId, role: 'admin' });
  memberId = await person('member');
  const box = await boxPairedBy(adminId, { turnCredential: true, followUpCredential: true });
  deviceId = box.id;
  boxToken = box.token;
  holderPat = (await m.pat.mintPat({ userId: adminId, name: 'forge-runner login' })).plaintext;
  socket = openDeviceSocket(deviceId);
});

afterEach(() => socket?.close());

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

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

/** What the session reaches Forge with: its frame's token, or the holder's where it carries none. */
function sessionCredentialOf(frame: { data: unknown } | undefined): string {
  if (!frame) throw new Error('no frame reached the box');
  return (frame.data as { forgeToken?: string }).forgeToken ?? holderPat;
}

function lastFrame(event: string) {
  return [...socket.frames].reverse().find((f) => f.event === event);
}

async function start(userId: string) {
  return call('POST', '/api/agent-sessions/start', await as(userId), {
    projectSlug,
    prompt: 'tidy the backlog',
  });
}

/** One tool call through `/mcp`, the door a session's `forge` server and CLI reach Forge by. */
async function mcpTool(
  bearer: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forge-project-slug': projectSlug,
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

async function commentExists(id: string): Promise<boolean> {
  const rows = await harness.db
    .select({ id: m.schema.comments.id })
    .from(m.schema.comments)
    .where(eq(m.schema.comments.id, id));
  return rows.length === 1;
}

describe('a member starts a session on a box an admin paired', () => {
  it("runs as the member: the member's writes land, the admin's are refused", async () => {
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
    const colleaguesComment = ((await posted.json()) as { id: string }).id;

    const res = await start(memberId);
    expect(res.status).toBe(201);
    const session = (await res.json()) as { id: string; userId: string };
    expect(session.userId).toBe(memberId);
    const credential = sessionCredentialOf(lastFrame('agent:start'));

    const erase = await mcpTool(credential, 'forge_comments', {
      action: 'delete',
      documentId: colleaguesComment,
    });
    expect(erase.text).toContain('only the comment author or a project admin can delete');
    expect(erase.isError).toBe(true);
    expect(await commentExists(colleaguesComment)).toBe(true);

    const own = await mcpTool(credential, 'forge_comments', {
      action: 'create',
      data: { issue: issueId, body: 'the member’s session wrote this' },
    });
    expect(own.isError, own.text).toBe(false);
    const [authored] = await harness.db
      .select({ authorId: m.schema.comments.authorId })
      .from(m.schema.comments)
      .where(eq(m.schema.comments.body, 'the member’s session wrote this'));
    expect(authored?.authorId).toBe(memberId);

    const verified = await m.pat.verifyPat(credential);
    expect(verified?.row.userId).toBe(memberId);
    expect(verified?.row.name).toBe(`turn:${session.id}`);
    expect(verified?.row.deviceId).toBe(deviceId);
    expect(verified?.row.boundProjectId).toBe(projectId);
  });

  it('a follow-up carries a fresh token for the sender, and the previous one is dead', async () => {
    const started = (await (await start(memberId)).json()) as { id: string };
    const first = sessionCredentialOf(lastFrame('agent:start'));

    const done = await call('PATCH', `/api/agent-sessions/${started.id}`, boxToken, {
      status: 'completed',
      claudeSessionId: 'claude-1',
    });
    expect(done.status).toBe(200);
    expect(await m.pat.verifyPat(first)).toBeNull();

    const sent = await call('POST', '/api/agent-sessions/send', await as(memberId), {
      sessionId: started.id,
      message: 'and the next one',
    });
    expect(sent.status).toBe(200);
    const followUp = lastFrame('agent:send');
    const second = (followUp?.data as { forgeToken?: string } | undefined)?.forgeToken;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await m.pat.verifyPat(second as string))?.row.userId).toBe(memberId);
  });
});

describe('the token dies with the turn, whichever writer stops it', () => {
  async function liveTurn(): Promise<{ sessionId: string; token: string }> {
    const started = (await (await start(memberId)).json()) as { id: string };
    const token = sessionCredentialOf(lastFrame('agent:start'));
    expect(await m.pat.verifyPat(token)).not.toBeNull();
    return { sessionId: started.id, token };
  }

  it('on the runner reporting the turn failed', async () => {
    const { sessionId, token } = await liveTurn();
    await call('PATCH', `/api/agent-sessions/${sessionId}`, boxToken, { status: 'failed' });
    expect(await m.pat.verifyPat(token)).toBeNull();
  });

  it('on the person cancelling it', async () => {
    const { sessionId, token } = await liveTurn();
    const res = await call('POST', `/api/agent-sessions/${sessionId}/cancel`, await as(memberId));
    expect(res.status).toBe(200);
    expect(await m.pat.verifyPat(token)).toBeNull();
  });

  it('on an abort back to idle', async () => {
    const { sessionId, token } = await liveTurn();
    await call('POST', '/api/agent-sessions/abort', await as(memberId), { sessionId });
    expect(await m.pat.verifyPat(token)).toBeNull();
  });

  it('on a reap that writes the row directly', async () => {
    const { sessionId, token } = await liveTurn();
    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'cancelled_stale' WHERE id = ${sessionId}`,
    );
    expect(await m.pat.verifyPat(token)).toBeNull();
  });

  it('on the session being deleted', async () => {
    const { sessionId, token } = await liveTurn();
    const res = await call('DELETE', `/api/agent-sessions/${sessionId}`, await as(memberId));
    expect(res.status).toBe(204);
    expect(await m.pat.verifyPat(token)).toBeNull();
  });

  it('and not on a status write that keeps it live', async () => {
    const { sessionId, token } = await liveTurn();
    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'running' WHERE id = ${sessionId}`,
    );
    expect(await m.pat.verifyPat(token)).not.toBeNull();
  });
});

describe('who may not start one', () => {
  it('refuses a viewer by name, creating nothing', async () => {
    const res = await start(await person('viewer'));
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SESSION_VIEWER');
    expect(socket.frames).toHaveLength(0);
  });

  it('refuses a person with no role on the project by name', async () => {
    const res = await start(await person(null));
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SESSION_NO_ROLE');
  });

  it('refuses a viewer an empty session too', async () => {
    const res = await call('POST', '/api/agent-sessions', await as(await person('viewer')), {
      projectId,
    });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SESSION_VIEWER');
  });

  it('refuses by name where the only free box would spend its holder’s credential', async () => {
    await harness.db.execute(
      sql`UPDATE devices SET capabilities = '{"turnCredential": true}'::jsonb WHERE id = ${deviceId}`,
    );
    const res = await start(memberId);
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('RUNNER_OUTDATED');
    expect(socket.frames).toHaveLength(0);
    const rows = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM agent_sessions WHERE project_id = ${projectId}`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);
  });

  it('refuses a follow-up while a turn is live', async () => {
    const started = (await (await start(memberId)).json()) as { id: string };
    const res = await call('POST', '/api/agent-sessions/send', await as(memberId), {
      sessionId: started.id,
      message: 'again',
    });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('SESSION_RUNNING');
  });
});
