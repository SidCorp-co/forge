/**
 * ISS-1380 — Sentry targets live on the binding, so one project's agents cannot read another's.
 *
 * Against real Postgres and the real doors: targets written through the REST routes land on the
 * binding and not the shared connection; the connection routes refuse them by name; and with two
 * projects bound to ONE connection, both granting agents access, project A naming project B's label
 * is refused naming A's labels — on `forge_sentry` list and get, in the prompt block, in the scheduled
 * pull and on a delivered webhook — with nothing asked of Sentry.
 *
 * The planted case is the defect itself: the same two projects with the targets held on the
 * connection, as every release before this one wrote them.
 */

import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let ownerId: string;
let jwt: string;
let projectA: string;
let projectB: string;
let tokenA: string;
let tokenB: string;
let connectionId: string;
let bindingA: string;
let bindingB: string;

const AUTH_TOKEN = 'sntryu_integration_test_token';
const SENTRY_HOST = 'logs.canawan.test';
const aCore = { label: 'a-core', organizationSlug: 'canawan', projectSlug: 'a-core' };
const bCore = { label: 'b-core', organizationSlug: 'canawan', projectSlug: 'b-core' };

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

let asked: string[];

/** Answer only this test's Sentry host with an empty issue list; everything else is the real fetch. */
function stubSentry(): void {
  const real = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) => {
      const url = String(input);
      if (!url.includes(SENTRY_HOST)) {
        return (real as (a: unknown, b?: unknown) => Promise<Response>)(input, init);
      }
      asked.push(url);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

/** What these tests read of a REST answer: the integration a write returns, or the refusal. */
interface RestBody {
  integration: { id: string; connectionId: string };
  [key: string]: unknown;
}

/** What `forge_sentry` answers, in the two shapes it has. */
interface SentryAnswer {
  ok: boolean;
  refusal: { reason: string; message: string };
}

async function rest(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as RestBody };
}

const configOf = async (table: 'integration_connections' | 'integration_bindings', id: string) =>
  (
    (await harness.db.execute(
      sql`SELECT config FROM ${sql.raw(table)} WHERE id = ${id}::uuid`,
    )) as unknown as Array<{ config: Record<string, unknown> }>
  )[0]?.config;

async function credentialFor(projectId: string): Promise<string> {
  const { issueWorkspaceCredential } = await import('../../src/devices/workspace-credential.js');
  const device = await createTestDevice(harness.db, ownerId, { status: 'online' });
  return issueWorkspaceCredential({ deviceId: device.id, projectId, holderUserId: ownerId });
}

/** Both projects bound to ONE connection, each through the door the product gives, each granting agents. */
beforeEach(async () => {
  asked = [];
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  ownerId = user.id;
  const orgId = (await seedOrg(harness.db, ownerId)).id;
  projectA = (await createTestProject(harness.db, ownerId, { orgId })).id;
  projectB = (await createTestProject(harness.db, ownerId, { orgId })).id;
  for (const projectId of [projectA, projectB]) {
    await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  }
  jwt = await (await import('../../src/auth/jwt.js')).signUserToken(ownerId);

  const created = await rest('POST', `/api/projects/${projectA}/integrations`, {
    provider: 'sentry',
    role: 'service',
    config: { host: SENTRY_HOST, targets: [aCore] },
    secrets: { authToken: AUTH_TOKEN },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bindingA = created.body.integration.id;
  connectionId = created.body.integration.connectionId;
  const bound = await rest('POST', `/api/integration-connections/${connectionId}/bindings`, {
    projectId: projectB,
    role: 'service',
    config: { targets: [bCore] },
  });
  expect(bound.status, JSON.stringify(bound.body)).toBe(201);
  bindingB = bound.body.integration.id;
  await harness.db.execute(
    sql`UPDATE integration_bindings SET agent_access = 'all' WHERE id IN (${bindingA}::uuid, ${bindingB}::uuid)`,
  );
  tokenA = await credentialFor(projectA);
  tokenB = await credentialFor(projectB);
  stubSentry();
});

afterEach(() => vi.unstubAllGlobals());

async function forgeSentry(
  token: string,
  projectId: string,
  args: Record<string, unknown>,
): Promise<SentryAnswer> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forge_sentry', arguments: { projectId, ...args } },
    }),
  });
  expect(res.status).toBe(200);
  const out = (await res.json()) as {
    result: { content: Array<{ text: string }>; structuredContent?: SentryAnswer };
  };
  return (out.result.structuredContent ??
    JSON.parse(out.result.content[0]?.text ?? '{}')) as SentryAnswer;
}

describe('where the targets were stored', () => {
  it("puts each project's targets on its own binding and none on the shared connection", async () => {
    expect(await configOf('integration_connections', connectionId)).toEqual({ host: SENTRY_HOST });
    expect(await configOf('integration_bindings', bindingA)).toEqual({ targets: [aCore] });
    expect(await configOf('integration_bindings', bindingB)).toEqual({ targets: [bCore] });
  });

  it("changes one project's targets without touching the sibling or the connection", async () => {
    const next = { label: 'b-web', organizationSlug: 'canawan', projectSlug: 'b-web' };

    const patched = await rest('PATCH', `/api/projects/${projectB}/integrations/${bindingB}`, {
      config: { targets: [bCore, next] },
    });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(await configOf('integration_bindings', bindingB)).toEqual({ targets: [bCore, next] });
    expect(await configOf('integration_bindings', bindingA)).toEqual({ targets: [aCore] });
    expect(await configOf('integration_connections', connectionId)).toEqual({ host: SENTRY_HOST });
  });

  it('refuses targets on a connection create and a connection patch, naming the key', async () => {
    const create = await rest('POST', '/api/integration-connections', {
      provider: 'sentry',
      config: { host: SENTRY_HOST, targets: [aCore] },
      secrets: { authToken: AUTH_TOKEN },
    });
    const patch = await rest('PATCH', `/api/integration-connections/${connectionId}`, {
      config: { targets: [bCore] },
    });

    for (const refused of [create, patch]) {
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(
        '`targets` is not connection config for Sentry',
      );
    }
    expect(await configOf('integration_connections', connectionId)).toEqual({ host: SENTRY_HOST });
  });
});

describe("project A naming project B's target", () => {
  it("is refused by name on list, listing only A's labels, and Sentry is never asked", async () => {
    const answer = await forgeSentry(tokenA, projectA, { action: 'list', target: 'b-core' });

    expect(answer.ok).toBe(false);
    expect(answer.refusal.reason).toBe('target_unknown');
    expect(answer.refusal.message).toContain('"b-core"');
    expect(answer.refusal.message).toContain('this binding declares: a-core');
    expect(answer.refusal.message).not.toMatch(/declares:.*b-core/);
    expect(asked).toEqual([]);
  });

  it('is refused by name on get, and Sentry is never asked', async () => {
    const answer = await forgeSentry(tokenA, projectA, {
      action: 'get',
      issueId: '5001',
      target: 'b-core',
    });

    expect(answer.ok).toBe(false);
    expect(answer.refusal.reason).toBe('target_unknown');
    expect(answer.refusal.message).toContain('this binding declares: a-core');
    expect(asked).toEqual([]);
  });

  it("is answered when A names its own target, which asks Sentry for A's project alone", async () => {
    const answer = await forgeSentry(tokenA, projectA, { action: 'list', target: 'a-core' });

    expect(answer.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(decodeURIComponent(asked[0] as string)).toContain('project:a-core');
    expect(asked[0]).not.toContain('b-core');
  });

  it("leaves B able to read B's own", async () => {
    const answer = await forgeSentry(tokenB, projectB, { action: 'list', target: 'b-core' });

    expect(answer.ok).toBe(true);
    expect(decodeURIComponent(asked[0] as string)).toContain('project:b-core');
  });
});

describe('a binding that declares no targets', () => {
  it('is refused naming the binding, whatever its siblings or the connection hold', async () => {
    await harness.db.execute(
      sql`UPDATE integration_bindings SET config = '{}'::jsonb WHERE id = ${bindingA}::uuid`,
    );
    // The state an older release leaves behind: targets written to the shared connection.
    await harness.db.execute(sql`
      UPDATE integration_connections
         SET config = ${JSON.stringify({ host: SENTRY_HOST, targets: [aCore, bCore] })}::jsonb
       WHERE id = ${connectionId}::uuid
    `);

    const answer = await forgeSentry(tokenA, projectA, { action: 'list' });

    expect(answer.ok).toBe(false);
    expect(answer.refusal.reason).toBe('no_targets');
    expect(answer.refusal.message).toContain(bindingA);
    expect(asked).toEqual([]);
  });

  it("is not given B's targets by a copy on the connection when A declares its own", async () => {
    await harness.db.execute(sql`
      UPDATE integration_connections
         SET config = ${JSON.stringify({ host: SENTRY_HOST, targets: [bCore] })}::jsonb
       WHERE id = ${connectionId}::uuid
    `);

    const answer = await forgeSentry(tokenA, projectA, { action: 'list', target: 'b-core' });

    expect(answer.ok).toBe(false);
    expect(answer.refusal.reason).toBe('target_unknown');
    expect(answer.refusal.message).toContain('this binding declares: a-core');
  });
});

describe('the other doors that read targets', () => {
  it("prompts project A with A's targets and none of B's", async () => {
    const { loadActiveIntegrationRows, renderIntegrations } = await import(
      '../../src/prompt/facts/resolve.js'
    );

    const block = renderIntegrations(await loadActiveIntegrationRows(projectA));

    expect(block).toContain('a-core');
    expect(block).not.toContain('b-core');
  });

  it("prompts A with none of B's even when the connection holds them", async () => {
    const { loadActiveIntegrationRows, renderIntegrations } = await import(
      '../../src/prompt/facts/resolve.js'
    );
    await harness.db.execute(sql`
      UPDATE integration_connections
         SET config = ${JSON.stringify({ host: SENTRY_HOST, targets: [aCore, bCore] })}::jsonb
       WHERE id = ${connectionId}::uuid
    `);

    const block = renderIntegrations(await loadActiveIntegrationRows(projectA));

    expect(block).toContain('a-core');
    expect(block).not.toContain('b-core');
  });

  it("pulls A's Sentry project alone", async () => {
    const { runSentryPull } = await import('../../src/integrations/sentry/intake.js');

    const result = await runSentryPull({ projectId: projectA });

    expect(result.status, result.output).not.toBe('failed');
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) {
      expect(decodeURIComponent(url)).toContain('project:a-core');
      expect(url).not.toContain('b-core');
    }
  });

  it("turns away a delivery for B's Sentry project on A's binding, attributing it to no target", async () => {
    const { selectSentryTarget } = await import('../../src/integrations/sentry/webhook.js');
    const { effectiveConfig, findBindingWithConnectionById } = await import(
      '../../src/integrations/store.js'
    );
    const pair = await findBindingWithConnectionById(bindingA);
    if (!pair) throw new Error('binding A is gone');
    const config = effectiveConfig(pair) as never;

    expect(selectSentryTarget(config, 'a-core')).toEqual({ label: 'a-core' });
    expect(selectSentryTarget(config, 'b-core')).toMatchObject({
      refusal: expect.stringContaining('this binding declares: a-core'),
    });
  });
});
