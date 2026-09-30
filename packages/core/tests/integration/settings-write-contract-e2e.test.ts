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
  readEnvironments: typeof import('../../src/projects/environments-service.js').readEnvironments;
  writeEnvironmentsLimits: typeof import('../../src/projects/environments-service.js').writeEnvironmentsLimits;
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

const SEED_ENVIRONMENTS = {
  live: { url: 'https://live.example', commitPath: 'commit' },
  preview: { url: 'https://preview.example', shownNowhere: 'a key the form does not render' },
  testCredentials: [{ label: 'qa', username: 'qa@example.com', password: 'secret' }],
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const [jwt, environments] = await Promise.all([
    import('../../src/auth/jwt.js'),
    import('../../src/projects/environments-service.js'),
  ]);
  mods = {
    signUserToken: jwt.signUserToken,
    readEnvironments: environments.readEnvironments,
    writeEnvironmentsLimits: environments.writeEnvironmentsLimits,
  };
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
  const project = await createTestProject(harness.db, ownerId, {
    orgId: org.id,
    environments: SEED_ENVIRONMENTS,
  });
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

describe('the environments document', () => {
  async function readEnv(): Promise<Record<string, unknown>> {
    const res = await call('GET', `/api/projects/${projectId}/environments`);
    return res.json.environments as Record<string, unknown>;
  }

  it('refuses environments on the project route by name, naming the door it moved to', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}`, {
      environments: { live: { url: 'https://elsewhere.example' } },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ENVIRONMENTS_MOVED');
    expect(String(res.json.message)).toContain('PATCH /api/projects/:id/environments');
    expect((await mods.readEnvironments(projectId)).live).toEqual(SEED_ENVIRONMENTS.live);
  });

  it('leaves the keys the form never showed when every rendered field is cleared', async () => {
    const base = await readEnv();
    const res = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base,
      patch: { preview: { url: null, apiUrl: null, urls: [] } },
    });
    expect(res.status).toBe(200);

    const preview = (await mods.readEnvironments(projectId)).preview as Record<string, unknown>;
    expect(preview.shownNowhere).toBe('a key the form does not render');
    expect('url' in preview).toBe(false);
    expect((await mods.readEnvironments(projectId)).testCredentials).toEqual(
      SEED_ENVIRONMENTS.testCredentials,
    );
  });

  it('refuses a write whose ground moved and leaves the first writer standing', async () => {
    const base = await readEnv();
    const first = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base,
      patch: { limits: 'no outbound email' },
    });
    expect(first.status).toBe(200);

    const second = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base,
      patch: { limits: 'something else' },
    });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe('ENVIRONMENTS_STALE');
    expect((await mods.readEnvironments(projectId)).limits).toBe('no outbound email');
  });

  it('refuses a bare document by name', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}/environments`, {
      live: { url: 'https://elsewhere.example' },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ENVIRONMENTS_WRITE_SHAPE');
  });

  it('refuses a scoped limits write whose stored value moved under it', async () => {
    await mods.writeEnvironmentsLimits({ projectId, base: null, value: 'no outbound email' });
    await expect(
      mods.writeEnvironmentsLimits({ projectId, base: null, value: 'written blind' }),
    ).rejects.toMatchObject({ name: 'EnvironmentsError', code: 'ENVIRONMENTS_STALE' });
    expect((await mods.readEnvironments(projectId)).limits).toBe('no outbound email');
  });
});
