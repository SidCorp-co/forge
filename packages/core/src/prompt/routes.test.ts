import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// Drizzle-style mock: select().from().where().limit() with each call shifting
// off the front of a per-test queue. Different selects are distinguished by
// queue order — tests stack the expected sequence per request.
const limitResults: unknown[][] = [];
const limit = vi.fn(() => Promise.resolve(limitResults.shift() ?? []));
const where = vi.fn(() => ({ limit }));
// loadProjectAccess (lib/authz) runs select().from().leftJoin().leftJoin()
// .where().limit() — route the join chain back into the same where/limit FIFO.
const leftJoin = vi.fn((): Record<string, unknown> => ({ leftJoin, where }));
const from = vi.fn(() => ({ where, leftJoin }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from })) },
}));

const { promptRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono();
  app.use('*', requestId());
  app.route('/api/prompts', promptRoutes);
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ISSUE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date();

async function authHeader(): Promise<string> {
  const token = await signUserToken(USER_ID);
  return `Bearer ${token}`;
}

// Queue the 2 selects done in the auth + project-access path.
// 1) assertEmailVerified — users-by-id → [{ emailVerifiedAt }]
// 2) loadProjectAccess   — joined row  → [{ orgId, memberRole, orgRole }]
function queueAuth(opts?: { asMember?: boolean }) {
  limitResults.push([{ emailVerifiedAt: NOW }]);
  limitResults.push([
    opts?.asMember
      ? { orgId: 'org-1', memberRole: 'admin', orgRole: null }
      : { orgId: 'org-1', memberRole: null, orgRole: 'owner' },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  limit.mockClear();
  limitResults.length = 0;
});

describe('POST /api/prompts/preview', () => {
  it('returns systemPrompt + userPrompt for a state with no issue', async () => {
    queueAuth();
    // buildPipelinePreambleStructured loads project branches
    limitResults.push([{ baseBranch: 'main', productionBranch: 'release' }]);

    const app = buildApp();
    const res = await app.request('/api/prompts/preview', {
      method: 'POST',
      headers: {
        Authorization: await authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId: PROJECT_ID, state: 'code' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.systemPrompt).toContain('Pipeline Rules');
    expect(data.systemPrompt).toContain('baseBranch: main');
    expect(data.userPrompt).toContain('/forge-code preview-no-issue');
    expect(data.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pipeline-rules' }),
        expect.objectContaining({ id: 'tool-reference' }),
        expect.objectContaining({ id: 'project-config' }),
      ]),
    );
    expect(data.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('replace mode overrides the static prefix entirely', async () => {
    queueAuth();
    limitResults.push([{ baseBranch: 'main', productionBranch: 'release' }]);

    const app = buildApp();
    const res = await app.request('/api/prompts/preview', {
      method: 'POST',
      headers: {
        Authorization: await authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        state: 'code',
        overrides: {
          systemPrompt: { mode: 'replace', extras: 'ONLY THIS RULE.' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.systemPrompt).toBe('ONLY THIS RULE.');
    expect(data.systemPrompt).not.toContain('Pipeline Rules');
    expect((data.resolvedFlags as Record<string, unknown>).systemPromptMode).toBe('replace');
  });

  it('append mode adds extras after the static prefix', async () => {
    queueAuth();
    limitResults.push([{ baseBranch: 'main', productionBranch: 'release' }]);

    const app = buildApp();
    const res = await app.request('/api/prompts/preview', {
      method: 'POST',
      headers: {
        Authorization: await authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        state: 'code',
        overrides: {
          systemPrompt: { mode: 'append', extras: 'Custom rule.' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.systemPrompt).toContain('Pipeline Rules');
    expect(data.systemPrompt).toContain('Custom rule.');
  });

  it('403 when user is not a project member or owner', async () => {
    limitResults.push([{ emailVerifiedAt: NOW }]);
    limitResults.push([{ orgId: 'org-1', memberRole: null, orgRole: null }]); // no access

    const app = buildApp();
    const res = await app.request('/api/prompts/preview', {
      method: 'POST',
      headers: {
        Authorization: await authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId: PROJECT_ID, state: 'code' }),
    });
    expect(res.status).toBe(403);
  });

  it('400 on invalid body (unknown state)', async () => {
    // assertEmailVerified runs before zValidator; the validator failure path
    // still needs the email-verified select to succeed.
    limitResults.push([{ emailVerifiedAt: NOW }]);
    const app = buildApp();
    const res = await app.request('/api/prompts/preview', {
      method: 'POST',
      headers: {
        Authorization: await authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId: PROJECT_ID, state: 'not-a-state' }),
    });
    expect(res.status).toBe(400);
  });

  it('404 when issueId is provided but does not exist', async () => {
    queueAuth();
    // One projects read on the step path: loadProjectFactInputs supplies both
    // the Project Config branches and the facts block.
    limitResults.push([{ baseBranch: 'main', productionBranch: 'release' }]);
    limitResults.push([]); // loadIssueSnapshot — no row

    const app = buildApp();
    const res = await app.request('/api/prompts/preview', {
      method: 'POST',
      headers: {
        Authorization: await authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId: PROJECT_ID, state: 'code', issueId: ISSUE_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('includes issueSnapshot in userPrompt when issueId provided + issue exists', async () => {
    queueAuth();
    // One projects read on the step path (loadProjectFactInputs), then the issue.
    limitResults.push([{ baseBranch: 'main', productionBranch: 'release' }]);
    limitResults.push([
      {
        title: 'Rate-limit /api/agents',
        status: 'approved',
        priority: 'high',
        complexity: 'm',
        description: 'Throttle the agents endpoint.',
        plan: '1. Middleware\n2. Tests',
        acceptanceCriteria: '- [ ] 429 returned',
        sessionContext: null,
      },
    ]);

    const app = buildApp();
    const res = await app.request('/api/prompts/preview', {
      method: 'POST',
      headers: {
        Authorization: await authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId: PROJECT_ID, state: 'code', issueId: ISSUE_ID }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    // Thin-prompt default (fetch-via-tool): the snapshot carries the title +
    // a forge_step_start pointer, NOT the inlined description/plan/AC.
    expect(data.userPrompt).toContain('## Issue');
    expect(data.userPrompt).toContain('Rate-limit /api/agents');
    expect(data.userPrompt).toContain('forge_step_start');
    expect(data.userPrompt).not.toContain('Throttle the agents endpoint');
  });
});
