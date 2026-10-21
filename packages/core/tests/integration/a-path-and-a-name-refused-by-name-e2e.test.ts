/**
 * ISS-1229 r25 — judge-72 found two writes that answered a wrong value badly. A repository path the
 * field asks to be absolute was taken relative, and an organization name past its 200-character limit
 * was refused as "Invalid input", which names neither the field nor the limit. Each is now refused by
 * name, saying what was wrong and what shape is valid.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let orgId: string;
let projectId: string;
let runnerId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  orgId = (await seedOrg(harness.db, ownerId)).id;
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: 'paths', name: 'Paths', orgId })
  ).id;
  const device = await createTestDevice(harness.db, ownerId);
  await bindTestRunner(harness.db, { projectId, deviceId: device.id });
  const rows = await harness.db.execute<{ id: string }>(
    sql`SELECT id FROM runners WHERE project_id = ${projectId}`,
  );
  runnerId = rows[0]?.id as string;
});

async function as(path: string, method: string, body: unknown): Promise<Response> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${await signUserToken(ownerId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function refusal(
  res: Response,
): Promise<{ status: number; code?: string; message?: string }> {
  return { status: res.status, ...((await res.json()) as { code?: string; message?: string }) };
}

const NOT_ABSOLUTE =
  /The repository path "projects\/app" is not an absolute path\. Give the checkout/;

describe('a repository path that is not absolute', () => {
  it('is refused by name on a project, and nothing is saved', async () => {
    const res = await refusal(
      await as(`/api/projects/${projectId}`, 'PATCH', { repoPath: 'projects/app' }),
    );
    expect(res).toMatchObject({ status: 400, code: 'REPO_PATH_NOT_ABSOLUTE' });
    expect(res.message).toMatch(NOT_ABSOLUTE);
    const rows = await harness.db.execute<{ repo_path: string | null }>(
      sql`SELECT repo_path FROM projects WHERE id = ${projectId}`,
    );
    expect(rows[0]?.repo_path).not.toBe('projects/app');
  });

  it("is refused by name on a project's runner, and nothing is saved", async () => {
    const res = await refusal(
      await as(`/api/projects/${projectId}/runners/${runnerId}`, 'PATCH', {
        repoPath: 'projects/app',
      }),
    );
    expect(res).toMatchObject({ status: 400, code: 'REPO_PATH_NOT_ABSOLUTE' });
    expect(res.message).toMatch(NOT_ABSOLUTE);
    const rows = await harness.db.execute<{ repo_path: string | null }>(
      sql`SELECT repo_path FROM runners WHERE id = ${runnerId}`,
    );
    expect(rows[0]?.repo_path).toBeNull();
  });

  it('leaves every other wrong body refused as it was', async () => {
    const res = await as(`/api/projects/${projectId}/runners/${runnerId}`, 'PATCH', {
      labels: [''],
    });
    expect(res.status, await res.clone().text()).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('BAD_REQUEST');
  });

  it.each(['/home/forge/projects/app', 'C:\\projects\\app', ''])('takes %j', async (repoPath) => {
    const res = await as(`/api/projects/${projectId}/runners/${runnerId}`, 'PATCH', { repoPath });
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe('an organization name past its limit', () => {
  const tooLong = 'n'.repeat(201);
  const sentence =
    "An organization's name is at most 200 characters, so it was not saved. Shorten it, then save again.";

  it('is refused on rename with a sentence naming the field and its limit', async () => {
    const res = await refusal(await as(`/api/orgs/${orgId}`, 'PATCH', { name: tooLong }));
    expect(res).toMatchObject({ status: 400, code: 'BAD_REQUEST', message: sentence });
  });

  it('is refused on create in the same words', async () => {
    const res = await refusal(await as('/api/orgs', 'POST', { slug: 'long-name', name: tooLong }));
    expect(res).toMatchObject({ status: 400, code: 'BAD_REQUEST', message: sentence });
  });

  it('refuses adding someone already in it with a sentence saying so', async () => {
    const email = (
      await harness.db.execute<{ email: string }>(
        sql`SELECT email FROM users WHERE id = ${ownerId}`,
      )
    )[0]?.email;
    const res = await refusal(
      await as(`/api/orgs/${orgId}/members`, 'POST', { email, role: 'member' }),
    );
    expect(res).toMatchObject({
      status: 409,
      code: 'ALREADY_MEMBER',
      message: 'This person is already a member of the organization.',
    });
  });

  it('takes a name of exactly 200 characters', async () => {
    const res = await as(`/api/orgs/${orgId}`, 'PATCH', { name: 'n'.repeat(200) });
    expect(res.status, await res.clone().text()).toBe(200);
  });
});
