/**
 * ISS-994 — `states[X].mode` over the real HTTP surface.
 *
 * A schema test says what the two schemas do. Only the route says which of
 * them each door reached, and that is the whole shape of the fix: the WRITE
 * refuses a non-entry `mode` by name, the READ strips one so a project storing
 * one keeps a config at all. Wire the wrong schema to either and a unit test
 * still passes while a live project stops dispatching.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

let harness: TestDatabase;
let server: TestServer;
let mods: { signUserToken: typeof import('../../src/auth/jwt.js').signUserToken };
let ownerId: string;
let projectId: string;

async function call(
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = await mods.signUserToken(ownerId);
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function statesOf(json: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const cfg = json.pipelineConfig as { states?: Record<string, Record<string, unknown>> };
  return cfg.states ?? {};
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  mods = (await import('../../src/auth/jwt.js')) as unknown as typeof mods;
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.close?.();
  await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  const project = await createTestProject(harness.db, ownerId, {
    orgId: org.id,
    agentConfig: { pipelineConfig: { enabled: true, states: { open: { enabled: true } } } },
  });
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

describe('states[X].mode over PATCH /pipeline-config (ISS-994)', () => {
  it('refuses a mode at a stage that is not the entry status, naming the stage and the entry status', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      states: { in_progress: { mode: 'manual' } },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('in_progress');
    expect(JSON.stringify(res.json)).toContain('open');
  });

  it('writes nothing when it refuses', async () => {
    await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      states: { in_progress: { mode: 'manual' } },
    });
    const rows = (await harness.db.execute(
      sql`SELECT agent_config FROM projects WHERE id = ${projectId}`,
    )) as unknown as { agent_config: { pipelineConfig: { states: Record<string, unknown> } } }[];
    expect(rows[0]?.agent_config.pipelineConfig.states.in_progress).toBeUndefined();
  });

  it('accepts a mode at the entry status and reads it back', async () => {
    const patch = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      enabled: true,
      states: { open: { enabled: true, mode: 'manual' } },
    });
    expect(patch.status).toBe(200);
    const get = await call('GET', `/api/projects/${projectId}/pipeline-config`);
    expect(statesOf(get.json).open?.mode).toBe('manual');
  });
});

describe('GET /pipeline-config over a document that already stores a non-entry mode', () => {
  beforeEach(async () => {
    await harness.db.execute(sql`
      UPDATE projects
      SET agent_config = ${JSON.stringify({
        pipelineConfig: {
          enabled: true,
          states: {
            open: { enabled: true, mode: 'manual' },
            needs_info: { mode: 'manual' },
            in_progress: { enabled: true, mode: 'auto', model: 'sonnet' },
            awaiting_release: { enabled: true, mode: 'auto', model: 'sonnet' },
          },
        },
      })}::jsonb
      WHERE id = ${projectId}
    `);
  });

  it('answers rather than failing, which is what keeps the project dispatching', async () => {
    const get = await call('GET', `/api/projects/${projectId}/pipeline-config`);
    expect(get.status).toBe(200);
    expect((get.json.pipelineConfig as { enabled?: boolean }).enabled).toBe(true);
  });

  it('strips the non-reading mode and keeps the rest of that stage', async () => {
    const states = statesOf((await call('GET', `/api/projects/${projectId}/pipeline-config`)).json);
    expect(states.in_progress).toEqual({ enabled: true, model: 'sonnet' });
    expect(states.needs_info).toEqual({});
    expect(states.open?.mode).toBe('manual');
  });

  // ISS-1189 — the release stage now reads `mode`, so the read must hand it back rather than
  // strip it; stripping it would make a project declaring `auto` stop releasing in silence.
  it('keeps the mode the release stage reads', async () => {
    const states = statesOf((await call('GET', `/api/projects/${projectId}/pipeline-config`)).json);
    expect(states.awaiting_release).toEqual({ enabled: true, mode: 'auto', model: 'sonnet' });
  });
});
