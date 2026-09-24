/**
 * ISS-1247 — `forge_sentry` over the real `/mcp` door, against a real binding.
 *
 * The reproduction the issue asked for: a project with a Sentry binding and an issue in Sentry
 * answers with it; the same call after the binding is gone answers a refusal that names the
 * missing binding and carries no `issues` key at all. A green that cannot tell those two apart
 * would be the defect this tool exists to remove.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectId: string;
let ownerId: string;
let token: string;
let bindingId: string;

const AUTH_TOKEN = 'sntryu_integration_test_token';
const SENTRY_HOST = 'logs.canawan.test';

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.NODE_ENV = 'test';
  await registerIntegrationsForTest();
  ({ app } = await import('../../src/index.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const sentryIssue = {
  id: '5001',
  shortId: 'FORGE-CORE-7',
  status: 'unresolved',
  substatus: 'ongoing',
  level: 'error',
  count: 1,
  userCount: 1,
  firstSeen: '2026-09-24T10:00:00Z',
  lastSeen: '2026-09-24T11:00:00Z',
  permalink: `https://${SENTRY_HOST}/organizations/canawan/issues/5001/`,
  project: { slug: 'forge-core' },
  title: 'TypeError: cannot read x',
  culprit: 'GET /api/issues/next',
  metadata: { value: 'cannot read x' },
};

let asked: string[];

/** Answer only this test's Sentry host; anything else the app does goes to the real fetch. */
function stubSentry(body: unknown): void {
  const real = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) => {
      const url = String(input);
      if (!url.includes(SENTRY_HOST)) {
        return (real as (a: unknown, b?: unknown) => Promise<Response>)(input, init);
      }
      asked.push(url);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

async function bindSentry(): Promise<void> {
  const { encryptJson } = await import('../../src/integrations/vault.js');
  const connectionId = randomUUID();
  bindingId = randomUUID();
  const config = {
    host: SENTRY_HOST,
    targets: [{ label: 'core', organizationSlug: 'canawan', projectSlug: 'forge-core' }],
  };
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, secrets_enc, active)
    VALUES (${connectionId}, 'user', ${ownerId}::uuid, 'sentry', ${JSON.stringify(config)}::jsonb,
            ${encryptJson({ authToken: AUTH_TOKEN })}, true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings
      (id, connection_id, project_id, provider, role, stages, config, active, agent_access)
    VALUES (${bindingId}, ${connectionId}, ${projectId}::uuid, 'sentry', 'service',
            ARRAY[]::text[], ${JSON.stringify(config)}::jsonb, true, 'all')
  `);
}

beforeEach(async () => {
  asked = [];
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
  const { issueWorkspaceCredential } = await import('../../src/devices/workspace-credential.js');
  const device = await createTestDevice(harness.db, ownerId, { status: 'online' });
  token = await issueWorkspaceCredential({ deviceId: device.id, projectId, holderUserId: ownerId });
  await bindSentry();
  stubSentry([sentryIssue]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rpc(body: unknown): Promise<Record<string, unknown>> {
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

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'forge_sentry', arguments: { projectId, ...args } },
  });
  const result = out.result as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
  };
  expect(result.isError ?? false, result.content.map((c) => c.text).join('\n')).toBe(false);
  return (result.structuredContent ??
    JSON.parse(result.content.map((c) => c.text).join('\n'))) as Record<string, unknown>;
}

describe('forge_sentry over /mcp', () => {
  it('is listed by the running server, and says what it does not do', async () => {
    const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (out.result as { tools: Array<{ name: string; description: string }> }).tools;
    const tool = tools.find((t) => t.name === 'forge_sentry');
    expect(tool, 'forge_sentry is not in the running server tool list').toBeDefined();
    expect(tool?.description).toContain('READ-ONLY');
    expect(tool?.description).toContain('changes nothing there');
    expect(tool?.description).toContain('files nothing in the Forge tracker');
  });

  it('answers what Sentry is reporting for the bound project', async () => {
    const answer = await call({ action: 'list', release: '83f0c9b', window: '24h' });

    expect(answer.ok).toBe(true);
    const issues = answer.issues as Array<Record<string, unknown>>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: '5001',
      shortId: 'FORGE-CORE-7',
      title: 'TypeError: cannot read x',
      culprit: 'GET /api/issues/next',
      count: 1,
      userCount: 1,
    });
    const url = new URL(asked[0] as string);
    expect(url.searchParams.get('statsPeriod')).toBe('24h');
    expect(url.searchParams.get('query')).toContain('release:"83f0c9b"');
  });

  it('reads one issue by the id the listing gave', async () => {
    stubSentry(sentryIssue);
    const answer = await call({ action: 'get', issueId: '5001' });
    expect(answer.ok).toBe(true);
    expect((answer.issue as Record<string, unknown>).shortId).toBe('FORGE-CORE-7');
  });

  it('refuses the same call by name once the binding is gone, and returns no issues key', async () => {
    const before = await call({ action: 'list' });
    expect((before.issues as unknown[]).length).toBe(1);

    await harness.db.execute(sql`DELETE FROM integration_bindings WHERE id = ${bindingId}::uuid`);
    asked = [];

    const after = await call({ action: 'list' });
    expect(after.ok).toBe(false);
    expect(after).not.toHaveProperty('issues');
    expect((after.refusal as Record<string, unknown>).reason).toBe('no_binding');
    expect(String((after.refusal as Record<string, unknown>).message)).toContain(
      'no Sentry binding on this project',
    );
    expect(asked, 'nothing should have been asked of Sentry').toEqual([]);
  });

  it('leaves the scheduled pull thresholding exactly as it was', async () => {
    const { runSentryPull } = await import('../../src/integrations/sentry/intake.js');

    stubSentry([sentryIssue]);
    const belowThreshold = await runSentryPull({ projectId });
    expect(belowThreshold.status, belowThreshold.output).not.toBe('failed');
    expect(belowThreshold.output).toContain('0 issue(s) filed');
    expect(new URL(asked[0] as string).searchParams.get('statsPeriod')).toBeNull();

    asked = [];
    stubSentry([{ ...sentryIssue, count: 40, userCount: 9 }]);
    const aboveThreshold = await runSentryPull({ projectId });
    expect(aboveThreshold.output).toContain('1 issue(s) filed');
  });

  it('refuses a binding no agent on this project may use', async () => {
    await harness.db.execute(
      sql`UPDATE integration_bindings SET agent_access = 'none' WHERE id = ${bindingId}::uuid`,
    );
    const answer = await call({ action: 'list' });
    expect(answer.ok).toBe(false);
    expect((answer.refusal as Record<string, unknown>).reason).toBe('not_granted');
  });
});
