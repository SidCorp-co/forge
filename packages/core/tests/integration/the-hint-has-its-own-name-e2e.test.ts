/**
 * ISS-1236 r5 — the project's checkout hint is `projects.repo_path_hint`, a name no other column
 * shares, so `scripts/check-repo-path-readers.mjs` can find every read of it by searching for the name.
 * The rename keeps every stored value, and the API still reads and writes the hint as `repoPath`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callRest, callTool } from '../helpers/door-parity.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';
import {
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0389_the_hint_has_its_own_name.sql', import.meta.url),
);
const LIVE_ROW = '/home/kieutrung/tools/forge';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let jwt: string;
let pat: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  projectId = (await createTestProject(harness.db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');
  jwt = await signUserToken(owner.id);
  pat = (await mintPat({ userId: owner.id, name: 'owner', scopes: ['read', 'write', 'admin'] }))
    .plaintext;
});

async function storedHint(id = projectId): Promise<string | null> {
  const rows = (await harness.db.execute(
    sql`SELECT repo_path_hint AS hint FROM projects WHERE id = ${id}`,
  )) as unknown as Array<{ hint: string | null }>;
  return rows[0]?.hint ?? null;
}

class Rollback extends Error {}

describe('migration 0389', () => {
  it("keeps every project's hint, moved to repo_path_hint, and leaves runners.repo_path alone", async () => {
    const statements = readFileSync(MIGRATION, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const client = harness.client as Sql;
    let after: Array<{ id: string; hint: string | null }> = [];
    let columns: string[] = [];
    try {
      await client.begin(async (tx) => {
        await tx.unsafe('DROP INDEX conversation_messages_client_token_uq');
        await tx.unsafe('ALTER TABLE conversation_messages DROP COLUMN client_token');
        await tx.unsafe('ALTER TABLE projects RENAME COLUMN repo_path_hint TO repo_path');
        await tx`UPDATE projects SET repo_path = ${LIVE_ROW} WHERE id = ${projectId}`;
        for (const statement of statements) await tx.unsafe(statement);
        after = await tx<Array<{ id: string; hint: string | null }>>`
          SELECT id, repo_path_hint AS hint FROM projects`;
        columns = (
          await tx<Array<{ c: string }>>`
            SELECT table_name || '.' || column_name AS c FROM information_schema.columns
             WHERE column_name IN ('repo_path', 'repo_path_hint')
               AND table_name IN ('projects', 'runners') ORDER BY 1`
        ).map((r) => r.c);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    expect(after).toEqual([{ id: projectId, hint: LIVE_ROW }]);
    expect(columns).toEqual(['projects.repo_path_hint', 'runners.repo_path']);
  });
});

describe('the API keeps the name repoPath', () => {
  it('REST PATCH writes the hint and GET reads it back as repoPath', async () => {
    const patched = await callRest(server.baseUrl, jwt, 'PATCH', `/api/projects/${projectId}`, {
      repoPath: '/srv/rest',
    });
    expect(patched.status, patched.refused).toBe(200);
    expect((patched.body as { repoPath: string | null }).repoPath).toBe('/srv/rest');
    expect(await storedHint()).toBe('/srv/rest');

    const read = await callRest(server.baseUrl, jwt, 'GET', `/api/projects/${projectId}`);
    expect((read.body as { repoPath: string | null }).repoPath).toBe('/srv/rest');
  });

  it('forge_projects update writes the hint and get reads it back as repoPath', async () => {
    const updated = await callTool(pat, 'forge_projects.update', {
      projectId,
      patch: { repoPath: '/srv/tool' },
    });
    expect(updated.refused).toBeUndefined();
    expect(await storedHint()).toBe('/srv/tool');

    const got = await callTool(pat, 'forge_projects.get', { projectId });
    expect((got.body as { project: { repoPath: string | null } }).project.repoPath).toBe(
      '/srv/tool',
    );
  });

  it('forge_projects create writes the hint it is given', async () => {
    const [org] = (await harness.db.execute(
      sql`SELECT org_id AS "orgId" FROM projects WHERE id = ${projectId}`,
    )) as unknown as Array<{ orgId: string }>;
    const created = await callTool(pat, 'forge_projects.create', {
      orgId: org?.orgId,
      slug: 'hinted',
      name: 'Hinted',
      repoPath: '/srv/created',
    });
    expect(created.refused).toBeUndefined();
    const id = (created.body as { project: { id: string } }).project.id;
    expect(await storedHint(id)).toBe('/srv/created');
  });
});
