import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type MintPatInput = import('../../src/auth/pat.js').MintPatInput;
type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

type TokenKind =
  | 'whole'
  | 'legacy'
  | 'bound'
  | 'listed'
  | 'preEpoch'
  | 'box'
  | 'workspace'
  | 'agent'
  | 'turn';

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectId: string;
let orgId: string;
let issueId: string;
let tokens: Record<TokenKind, string>;
let userId: string;
let preEpochTokenId: string;
let fencedTokenId: string;
let fencedToken: string;

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

  await truncateAll(harness.db);
  const user = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  userId = user.id;
  const org = await seedOrg(harness.db, user.id);
  orgId = org.id;
  projectId = (await createTestProject(harness.db, user.id, { orgId })).id;
  await createTestProjectMember(harness.db, { projectId, userId: user.id, role: 'admin' });
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 9100, 'reach probe', 'open', ${user.id})
  `);

  const { mintPat } = await import('../../src/auth/pat.js');
  const { PAT_GRANT_EPOCH } = await import('../../src/auth/pat-permissions.js');
  const now = { grantEpoch: PAT_GRANT_EPOCH };
  const mint = async (name: string, extra: Omit<MintPatInput, 'userId' | 'name'>) =>
    (await mintPat({ userId: user.id, name, ...extra })).plaintext;

  const legacy = await mintPat({ userId: user.id, name: 'legacy', ...now });
  await harness.db.execute(
    sql`UPDATE personal_access_tokens SET permissions = NULL WHERE id = ${legacy.row.id}`,
  );

  const device = await createTestDevice(harness.db, user.id);
  const { issueDeviceCredential } = await import('../../src/devices/credential.js');
  const { issueWorkspaceCredential } = await import('../../src/devices/workspace-credential.js');
  const box = await issueDeviceCredential({
    deviceId: device.id,
    holderUserId: user.id,
    ...now,
  });
  const workspace = await issueWorkspaceCredential({
    deviceId: device.id,
    projectId,
    holderUserId: user.id,
  });

  const { createAgentAccount } = await import('../../src/orgs/agent-accounts.js');
  const agent = await createAgentAccount({
    orgId,
    handle: `reach-${randomUUID().slice(0, 6)}`,
    projectIds: [projectId],
    projectRole: 'admin',
    ...now,
  });

  const { AGENT_TURN_MENU, mintTurnCredential, resolveTurnAuthority } = await import(
    '../../src/auth/turn-credential.js'
  );
  const authority = await resolveTurnAuthority({ userId: user.id, projectId, viaTokenId: null });
  if (!authority.ok) throw new Error(authority.refusal.message);
  const turn = await mintTurnCredential({
    authority: authority.authority,
    menu: AGENT_TURN_MENU,
    name: `turn:${randomUUID()}`,
    ttlMs: 60_000,
  });

  const preEpoch = await mintPat({ userId: user.id, name: 'pre-epoch' });
  preEpochTokenId = preEpoch.row.id;
  const fenced = await mintPat({
    userId: user.id,
    name: 'fenced-person',
    projectIds: [projectId],
    ...now,
  });
  fencedTokenId = fenced.row.id;
  fencedToken = fenced.plaintext;

  tokens = {
    whole: await mint('whole', { permissions: ['*'], ...now }),
    legacy: legacy.plaintext,
    bound: await mint('bound', { permissions: ['*'], boundProjectId: projectId, ...now }),
    listed: await mint('listed', { permissions: ['*'], projectIds: [projectId], ...now }),
    preEpoch: preEpoch.plaintext,
    box,
    workspace,
    agent: agent.plaintext,
    turn: turn.token,
  };

  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
  ({ app } = await import('../../src/index.js'));
}, 180_000);

afterAll(async () => {
  await harness?.cleanup();
});

async function call(bearer: string, name: string, args: Record<string, unknown>) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
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

async function projectSlugged(slug: string): Promise<boolean> {
  const rows = await harness.db.execute(sql`SELECT 1 FROM projects WHERE slug = ${slug}`);
  return rows.length > 0;
}

const createProject = async (kind: TokenKind) => {
  const slug = `reach-${kind.toLowerCase()}-${randomUUID().slice(0, 6)}`;
  const out = await call(tokens[kind], 'forge_projects.create', { slug, name: slug, orgId });
  return { ...out, created: await projectSlugged(slug) };
};

const ACCOUNT_REFUSAL =
  /FORBIDDEN: PAT_ACCOUNT_ROUTE: forge_projects\.create, creating a project, reaches beyond the projects this token is fenced to/;

describe('a project-fenced token on an MCP tool whose work belongs to no project', () => {
  for (const kind of ['bound', 'listed'] as const) {
    it(`refuses a ${kind} token creating a project, by name, and creates none`, async () => {
      const out = await createProject(kind);
      expect(out.isError, out.text).toBe(true);
      expect(out.text).toMatch(ACCOUNT_REFUSAL);
      expect(out.created).toBe(false);
    });
  }

  it('refuses the org tools and an org guide write, as REST refuses /api/orgs', async () => {
    for (const [name, args] of [
      ['forge_orgs.list', {}],
      ['forge_orgs.members', { orgId }],
      [
        'forge_guide',
        { action: 'upsert', provider: 'sentry', title: 't', summary: 's', body: 'b', projectId },
      ],
    ] as const) {
      const out = await call(tokens.bound, name, args);
      expect(out.isError, `${name}: ${out.text}`).toBe(true);
      expect(out.text).toContain('PAT_ACCOUNT_ROUTE');
    }
  });

  it('still lets the fenced token read its own project and the public guide corpus', async () => {
    const issue = await call(tokens.bound, 'forge_issues', { action: 'get', documentId: issueId });
    expect(issue.isError, issue.text).toBe(false);
    expect(issue.text).toContain('reach probe');
    const guide = await call(tokens.bound, 'forge_guide', { action: 'list' });
    expect(guide.isError, guide.text).toBe(false);
  });
});

describe('a whole-reach token on the same tool', () => {
  for (const kind of ['whole', 'legacy'] as const) {
    it(`lets a ${kind} token create a project`, async () => {
      const out = await createProject(kind);
      expect(out.isError, out.text).toBe(false);
      expect(out.created).toBe(true);
    });
  }
});

describe('a token minted before its grant joined the menu', () => {
  it('is refused on MCP by name, as on REST', async () => {
    const out = await call(tokens.preEpoch, 'forge_runners', { action: 'list' });
    expect(out.isError, out.text).toBe(true);
    expect(out.text).toMatch(
      /FORBIDDEN: PAT_GRANT_PREDATES_ROUTE: forge_runners action 'list' is served at \/api\/runners, and \/api\/runners joined 'runners' at grant epoch 2, after this token was minted \(epoch 1\)/,
    );

    const rest = await app.request(`/api/runners?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${tokens.preEpoch}` },
    });
    expect(rest.status).toBe(403);
    expect(await rest.text()).toContain('PAT_GRANT_PREDATES_ROUTE');
  });

  const rest = async (path: string) => {
    const res = await app.request(path, {
      headers: { authorization: `Bearer ${tokens.preEpoch}` },
    });
    return { status: res.status, text: await res.text() };
  };

  it('is refused the agent-session tools, by the code REST refuses /api/agent-sessions', async () => {
    for (const [name, args, path] of [
      ['forge_agent_sessions.list', { projectId }, `/api/agent-sessions?projectId=${projectId}`],
      [
        'forge_agent_sessions.get',
        { sessionId: randomUUID() },
        `/api/agent-sessions/${randomUUID()}`,
      ],
    ] as const) {
      const out = await call(tokens.preEpoch, name, args);
      expect(out.isError, `${name}: ${out.text}`).toBe(true);
      expect(out.text).toContain(
        `PAT_GRANT_PREDATES_ROUTE: ${name} is served at /api/agent-sessions`,
      );
      const answer = await rest(path);
      expect(answer.status, answer.text).toBe(403);
      expect(answer.text).toContain('PAT_GRANT_PREDATES_ROUTE');
    }
  });

  it('is refused the pipeline analytics tools REST serves under /api/pipeline', async () => {
    for (const [name, path] of [
      [
        'forge_metrics.project_step_durations',
        `/api/pipeline/step-durations?projectId=${projectId}`,
      ],
      ['forge_metrics.project_retry_rescues', `/api/pipeline/retry-rescues?projectId=${projectId}`],
    ] as const) {
      const out = await call(tokens.preEpoch, name, { projectId });
      expect(out.isError, `${name}: ${out.text}`).toBe(true);
      expect(out.text).toContain(`PAT_GRANT_PREDATES_ROUTE: ${name} is served at /api/pipeline,`);
      const answer = await rest(path);
      expect(answer.status, answer.text).toBe(403);
      expect(answer.text).toContain('PAT_GRANT_PREDATES_ROUTE');
    }
    const failures = await call(tokens.preEpoch, 'forge_metrics.session_failures', { projectId });
    expect(failures.text).toContain('PAT_GRANT_PREDATES_ROUTE');
  });

  it('keeps the pipeline reads whose REST route it was minted with', async () => {
    const jobs = await call(tokens.preEpoch, 'forge_jobs.list', { projectId });
    expect(jobs.isError, jobs.text).toBe(false);
  });

  it('is refused every nested twin of a later surface on REST, and the timeseries tool on /mcp, by the surface it serves (ISS-105)', async () => {
    const usage = await call(tokens.preEpoch, 'forge_metrics.project_timeseries', {
      projectId,
      metric: 'cost',
    });
    expect(usage.isError, usage.text).toBe(true);
    expect(usage.text).toContain(
      'PAT_GRANT_PREDATES_ROUTE: forge_metrics.project_timeseries is served at /api/projects/:id/metrics/timeseries, and /api/projects/:id/metrics/timeseries serves the rows of /api/usage-records',
    );
    for (const [path, surface] of [
      [`/api/projects/${projectId}/agent-sessions`, '/api/agent-sessions'],
      [`/api/projects/${projectId}/agent-sessions/${randomUUID()}`, '/api/agent-sessions'],
      [`/api/projects/${projectId}/run-sessions`, '/api/agent-sessions'],
      [`/api/projects/${projectId}/metrics/session-failures`, '/api/agent-sessions'],
      [`/api/projects/${projectId}/metrics/step-durations`, '/api/pipeline'],
      [`/api/projects/${projectId}/metrics/retry-rescues`, '/api/pipeline'],
      [`/api/projects/${projectId}/metrics/interventions`, '/api/pipeline'],
      [`/api/projects/${projectId}/analytics/cost-summary`, '/api/pipeline'],
      [`/api/projects/${projectId}/metrics/timeseries?metric=cost`, '/api/usage-records'],
      [`/api/projects/${projectId}/runners`, '/api/runners'],
      [`/api/issues/${issueId}/cost-summary`, '/api/usage-records'],
    ] as const) {
      const answer = await rest(path);
      expect(answer.status, `${path}: ${answer.text}`).toBe(403);
      expect(answer.text).toContain('PAT_GRANT_PREDATES_ROUTE');
      expect(answer.text).toContain(`"surface":"${surface}"`);
    }
  });

  it('lets a token minted at the surface epoch read the same nested routes and the timeseries tool', async () => {
    for (const path of [
      `/api/projects/${projectId}/agent-sessions`,
      `/api/projects/${projectId}/metrics/timeseries?metric=cost`,
    ]) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${tokens.whole}` } });
      expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
    }
    const usage = await call(tokens.whole, 'forge_metrics.project_timeseries', {
      projectId,
      metric: 'cost',
    });
    expect(usage.isError, usage.text).toBe(false);
  });

  it('keeps runner load at its mount epoch on REST, the amnesty forge-plugin 3.36.542 holds', async () => {
    const load = await rest(`/api/projects/${projectId}/pm/runner-load`);
    expect(load.status, load.text).toBe(200);
  });

  it('keeps every tool whose grant it was minted with', async () => {
    const out = await call(tokens.preEpoch, 'forge_issues', { action: 'get', documentId: issueId });
    expect(out.isError, out.text).toBe(false);
  });

  it('lets a token minted now reach the same tool', async () => {
    const out = await call(tokens.whole, 'forge_runners', { action: 'list' });
    expect(out.isError, out.text).toBe(false);
  });
});

describe('the credentials core mints for itself', () => {
  for (const kind of ['workspace', 'agent', 'turn'] as const) {
    it(`a ${kind} token still reads and writes its project`, async () => {
      const read = await call(tokens[kind], 'forge_issues', { action: 'get', documentId: issueId });
      expect(read.isError, read.text).toBe(false);
      const title = `${kind} wrote this`;
      const write = await call(tokens[kind], 'forge_comments', {
        action: 'create',
        data: { issue: issueId, body: title },
      });
      expect(write.isError, write.text).toBe(false);
    });

    it(`a ${kind} token, fenced to its project, is refused creating one`, async () => {
      const out = await createProject(kind);
      expect(out.isError, out.text).toBe(true);
      expect(out.text).toContain('PAT_ACCOUNT_ROUTE');
      expect(out.created).toBe(false);
    });
  }

  it("a box token, fenced to no project, still reads the server's public snapshot", async () => {
    const out = await call(tokens.box, 'forge_health', {});
    expect(out.isError, out.text).toBe(false);
  });

  it('a box token is refused the org tools on MCP, as on REST', async () => {
    const out = await call(tokens.box, 'forge_orgs.list', {});
    expect(out.isError, out.text).toBe(true);
    expect(out.text).toContain('PAT_ACCOUNT_ROUTE');
    const rest = await app.request('/api/orgs', {
      headers: { authorization: `Bearer ${tokens.box}` },
    });
    expect(rest.status).toBe(403);
    expect(await rest.text()).toContain('PAT_ACCOUNT_ROUTE');
  });
});

describe('a chat turn, through the same check as /mcp', () => {
  async function chatAs(viaTokenId: string | null) {
    const { CHAT_TURN_MENU, mintTurnCredential, resolveTurnAuthority } = await import(
      '../../src/auth/turn-credential.js'
    );
    const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
    const { buildProjectToolset } = await import('../../src/assistant/tools/registry.js');
    const authority = await resolveTurnAuthority({ userId, projectId, viaTokenId });
    if (!authority.ok) throw new Error(authority.refusal.message);
    const credential = await mintTurnCredential({
      authority: authority.authority,
      menu: CHAT_TURN_MENU,
      name: `turn:${randomUUID()}`,
      ttlMs: 60_000,
    });
    const ctx = buildChatToolContext({
      credential,
      projectSlug: 'reach',
      turn: { conversationId: null, speakerUserId: userId, handleUserId: null },
    });
    return buildProjectToolset(ctx);
  }
  const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
    r.content.map((b) => b.text ?? '').join('');

  it('refuses a person who reached Forge with an epoch-1 token a tool whose route joined later', async () => {
    const set = await chatAs(preEpochTokenId);
    const out = await set.execute(
      'forge_metrics_project_step_durations',
      JSON.stringify({ projectId }),
    );
    expect(out.isError, textOf(out)).toBe(true);
    expect(textOf(out)).toContain('PAT_GRANT_PREDATES_ROUTE');
    const usage = await set.execute(
      'forge_metrics_project_timeseries',
      JSON.stringify({ projectId, metric: 'cost' }),
    );
    expect(textOf(usage)).toContain('serves the rows of /api/usage-records');
    const kept = await set.execute(
      'forge_project_pipeline_runs',
      JSON.stringify({ action: 'list', projectId }),
    );
    expect(kept.isError, textOf(kept)).toBeFalsy();
  });

  it('refuses account work to a person whose own token is fenced to projects, as REST refuses it', async () => {
    const set = await chatAs(fencedTokenId);
    const out = await set.execute('forge_preferences', JSON.stringify({ answerStyle: 'concise' }));
    expect(out.isError, textOf(out)).toBe(true);
    expect(textOf(out)).toContain('PAT_ACCOUNT_ROUTE');
    const rows = await harness.db.execute(
      sql`SELECT 1 FROM user_preferences WHERE user_id = ${userId} AND answer_style = 'concise'`,
    );
    expect(rows.length).toBe(0);
    const rest = await app.request('/api/auth/preferences', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${fencedToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ answerStyle: 'concise' }),
    });
    expect(rest.status).toBe(403);
    expect(await rest.text()).toContain('PAT_ACCOUNT_ROUTE');
  });

  it('lets a person signed in with a session set their own preferences from the room', async () => {
    const set = await chatAs(null);
    const out = await set.execute('forge_preferences', JSON.stringify({ answerStyle: 'detailed' }));
    expect(out.isError, textOf(out)).toBeFalsy();
  });
});
