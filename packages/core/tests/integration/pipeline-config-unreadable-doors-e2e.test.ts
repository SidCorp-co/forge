/**
 * ISS-1368 — the doors that read and write a project's `pipelineConfig` refuse a stored document
 * the schema refuses by name, naming each key and what is stored at it, and the boot scan names
 * every such project once. Real Postgres and the real HTTP and MCP surfaces.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';
import {
  BAD_PATH,
  expectNamed,
  PLACE,
  REFUSED,
  RUNTIMES,
  refusalOf,
  storeConfig,
} from '../helpers/refused-pipeline-config.js';

const sentry = vi.hoisted(() => ({
  captured: vi.fn<(err: unknown, hint?: { tags?: { projectId?: string } }) => void>(),
}));

vi.mock('../../src/observability/sentry.js', async (original) => {
  const real = await original<typeof import('../../src/observability/sentry.js')>();
  return {
    ...real,
    isSentryEnabled: () => true,
    Sentry: { ...real.Sentry, captureException: sentry.captured },
  };
});

/** The parts of a reply these cases read. */
type Reply = {
  code?: string;
  message?: string;
  details: { refused: unknown[] };
  pipelineConfig: { releaseRuntimes?: unknown };
};

const POOL_READ = { poolBacklog: { statuses: ['confirmed'] } };
const POOL_WRITE = { poolBacklog: { statuses: ['confirmed', 'approved'] } };

let harness: TestDatabase;
let server: TestServer;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let ownerId: string;
let refusedId: string;

const named = (said: string) => expectNamed(said, refusedId);

async function call(method: 'GET' | 'PATCH', path: string, body?: unknown) {
  const token = await signUserToken(ownerId);
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Reply };
}

const configPath = () => `/api/projects/${refusedId}/pipeline-config`;

async function configTool() {
  const { forgeConfigTool } = await import('../../src/mcp/tools/forge-config.js');
  const { PAT_GRANT_ALL } = await import('../../src/auth/pat-permissions.js');
  const principal = {
    kind: 'pat' as const,
    permissions: PAT_GRANT_ALL,
    agency: 'human' as const,
    agentUserId: null,
    deviceId: null,
    userId: ownerId,
    tokenId: randomUUID(),
    scopes: ['read', 'write', 'admin'],
    projectIds: [refusedId],
    boundProjectId: null,
  };
  return forgeConfigTool({ principal, projectSlug: null } as never);
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.close?.();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  const project = (agentConfig: Record<string, unknown>) =>
    createTestProject(harness.db, ownerId, { orgId: org.id, agentConfig });
  refusedId = (await project({ pipelineConfig: REFUSED })).id;
  const soundId = (await project({ pipelineConfig: POOL_READ })).id;
  for (const projectId of [refusedId, soundId]) {
    await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  }
});

describe('the pipeline-config doors refuse a stored document the schema refuses, by name', () => {
  it('the REST read is refused naming each key and what is stored at it', async () => {
    const read = await call('GET', configPath());

    expect(read.status).toBe(409);
    expect(read.json.code).toBe('PIPELINE_CONFIG_UNREADABLE');
    named(String(read.json.message));
    expect(read.json.details.refused).toEqual([
      expect.objectContaining({ path: PLACE, key: 'releaseRuntimes', stored: RUNTIMES }),
    ]);
  });

  it('the REST read refuses a stored null rather than answering the defaults', async () => {
    await storeConfig(harness.db, refusedId, null);

    const read = await call('GET', configPath());

    expect(read.status).toBe(409);
    expect(read.json.code).toBe('PIPELINE_CONFIG_UNREADABLE');
    expect(read.json.details.refused).toEqual([
      expect.objectContaining({ path: 'pipelineConfig', stored: null }),
    ]);
  });

  it('a stored null says what to send, and the patch it names repairs it', async () => {
    await storeConfig(harness.db, refusedId, null);

    const read = await call('GET', configPath());

    expect(String(read.json.message)).not.toContain('Correct ``');
    expect(String(read.json.message)).toContain(
      'send a pipeline-config patch naming the keys to store, with an empty base',
    );
    const patched = await call('PATCH', configPath(), { base: {}, patch: POOL_READ });
    expect(patched.status).toBe(200);
    expect((await call('GET', configPath())).status).toBe(200);
  });

  it('the MCP read is refused naming each key and what is stored at it', async () => {
    const tool = await configTool();

    const said = await refusalOf(() => tool.handler({ action: 'get', projectId: refusedId }));

    expect(said).toMatch(/^BAD_REQUEST: PIPELINE_CONFIG_UNREADABLE: /);
    named(said);
    expect(said).toContain(JSON.stringify(BAD_PATH));
  });

  it('a REST patch that leaves the refused key says it was written and names what is left', async () => {
    const patched = await call('PATCH', configPath(), { base: POOL_READ, patch: POOL_WRITE });

    expect(patched.status).toBe(409);
    expect(patched.json.code).toBe('PIPELINE_CONFIG_UNREADABLE');
    expect(String(patched.json.message)).toMatch(/^The patch was written, and /);
    named(String(patched.json.message));
  });

  it('an MCP update that leaves the refused key says it was written and names what is left', async () => {
    const tool = await configTool();
    const update = { action: 'update', projectId: refusedId, pipelineConfig: POOL_WRITE };

    const said = await refusalOf(() => tool.handler({ ...update, pipelineConfigBase: POOL_READ }));

    expect(said).toMatch(/^BAD_REQUEST: PIPELINE_CONFIG_UNREADABLE: The patch was written, and /);
    named(said);
  });

  it('accepts the patch that corrects the refused key, after which the reads answer', async () => {
    const fixed = [{ name: 'runner', paths: ['packages/runner'], servedBy: 'project-runners' }];

    const patched = await call('PATCH', configPath(), {
      base: { releaseRuntimes: RUNTIMES },
      patch: { releaseRuntimes: fixed },
    });

    expect(patched.status).toBe(200);
    const read = await call('GET', configPath());
    expect(read.status).toBe(200);
    expect(read.json.pipelineConfig.releaseRuntimes).toEqual(fixed);
  });

  it('names every refused document once at boot, logged, and no sound or archived one', async () => {
    const { reportUnreadablePipelineConfigs } = await import('../../src/pipeline/orchestrator.js');
    const { logger } = await import('../../src/logger.js');
    const archived = await createTestProject(harness.db, ownerId, {
      agentConfig: { pipelineConfig: REFUSED },
    });
    await harness.db.execute(
      sql`UPDATE projects SET archived_at = now() WHERE id = ${archived.id}`,
    );
    const logged = vi.spyOn(logger, 'error');

    const scanned = await reportUnreadablePipelineConfigs();

    expect(scanned.map((n) => n.projectId)).toEqual([refusedId]);
    named(scanned[0]?.message ?? '');
    expect(logged.mock.calls.map((c) => c[1])).toEqual([scanned[0]?.message]);
    logged.mockRestore();
  });

  it('registering the orchestrator at boot runs that scan, logged and reported once', async () => {
    const { registerPipelineOrchestrator } = await import('../../src/pipeline/orchestrator.js');
    const { logger } = await import('../../src/logger.js');
    const archived = await createTestProject(harness.db, ownerId, {
      agentConfig: { pipelineConfig: REFUSED },
    });
    await harness.db.execute(
      sql`UPDATE projects SET archived_at = now() WHERE id = ${archived.id}`,
    );
    const logged = vi.spyOn(logger, 'error');
    sentry.captured.mockClear();

    registerPipelineOrchestrator({ on: () => undefined } as never);

    await vi.waitFor(() => expect(sentry.captured).toHaveBeenCalled());
    const reported = sentry.captured.mock.calls.map((c) => c[1]?.tags?.projectId);
    expect(reported).toEqual([refusedId]);
    const scanned = logged.mock.calls.map((c) => String(c[1])).filter((m) => m.includes('refused'));
    expect(scanned).toHaveLength(1);
    named(scanned[0] ?? '');
    logged.mockRestore();
  });
});
