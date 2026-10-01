import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import type { PolicyDocument } from '../../src/project-config/schema.js';
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
let mods: {
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
};
let ownerId: string;
let projectId: string;

async function call(
  method: 'GET' | 'PATCH' | 'PUT',
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
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

async function storedPolicy(): Promise<{ revision: number; document: PolicyDocument }> {
  const rows = (await harness.db.execute(sql`
    SELECT revision, document FROM project_policies WHERE project_id = ${projectId}
  `)) as unknown as Array<{ revision: number; document: PolicyDocument }>;
  const [row] = rows;
  if (!row || rows.length !== 1) throw new Error(`expected one policy row, found ${rows.length}`);
  return row;
}

const denying = (deny: string[]): PolicyDocument => ({
  ...DEFAULT_POLICY,
  permissions: { ...DEFAULT_POLICY.permissions, driver: { deny } },
});

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const jwt = await import('../../src/auth/jwt.js');
  mods = { signUserToken: jwt.signUserToken };
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.close?.();
  await harness?.cleanup?.();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  const project = await createTestProject(harness.db, ownerId, { orgId: org.id });
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

/**
 * ISS-5 / ISS-6 — the policy is the one door dispatch reads, written whole against the revision
 * its writer read. The memory store in `project-config/routes.test.ts` proves the refusals; this
 * proves them over the real row, where a write that slipped past would show up as a second
 * revision.
 */
describe('the policy document', () => {
  it('writes a deny list of tool patterns as the next revision', async () => {
    const deny = ['CronCreate', 'Bash(git push:*)', 'mcp__forge__forge_projects_update'];
    const res = await call('PUT', `/api/projects/${projectId}/policy`, {
      baseRevision: 1,
      document: denying(deny),
    });
    expect(res.status).toBe(200);
    const stored = await storedPolicy();
    expect(stored.revision).toBe(2);
    expect(stored.document.permissions.driver?.deny).toEqual(deny);
  });

  it('refuses a malformed pattern by name at its path, and the stored revision stands', async () => {
    const res = await call('PUT', `/api/projects/${projectId}/policy`, {
      baseRevision: 1,
      document: denying(['CronCreate', 'Bash( git push:*)']),
    });
    expect(res.status).toBe(422);
    const error = res.json.error as { code: string; refusals: Array<Record<string, unknown>> };
    expect(error.code).toBe('TOOL_PATTERN_INVALID');
    expect(error.refusals[0]?.path).toBe('/permissions/driver/deny/1');
    expect(await storedPolicy()).toEqual({ revision: 1, document: DEFAULT_POLICY });
  });

  it('refuses a write based on a revision that moved, leaving the first writer standing', async () => {
    const first = await call('PUT', `/api/projects/${projectId}/policy`, {
      baseRevision: 1,
      document: denying(['Workflow']),
    });
    expect(first.status).toBe(200);
    const second = await call('PUT', `/api/projects/${projectId}/policy`, {
      baseRevision: 1,
      document: denying(['CronList']),
    });
    expect(second.status).toBe(422);
    expect((second.json.error as { code: string }).code).toBe('STALE_BASE');
    const stored = await storedPolicy();
    expect(stored.revision).toBe(2);
    expect(stored.document.permissions.driver?.deny).toEqual(['Workflow']);
  });

  it('answers no pipeline-config route any more', async () => {
    const res = await call('GET', `/api/projects/${projectId}/pipeline-config`);
    expect(res.status).toBe(404);
  });
});

describe('the environments a project declares', () => {
  it('refuses environments on the project route by name, naming the project document', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}`, {
      environments: { live: { url: 'https://elsewhere.example' } },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('does not take `environments`');
    expect(JSON.stringify(res.json)).toContain('PUT /api/projects/:id/config');
  });

  it('answers no environments route any more', async () => {
    expect((await call('GET', `/api/projects/${projectId}/environments`)).status).toBe(404);
    expect((await call('PATCH', `/api/projects/${projectId}/environments`, {})).status).toBe(404);
  });
});
