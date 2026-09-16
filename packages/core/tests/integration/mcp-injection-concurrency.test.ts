/**
 * ISS-1038 criterion 5 — two providers switched on from the same starting map
 * both survive, against real Postgres.
 *
 * This is the property the whole write design exists for. `updatePipelineConfig`
 * replaces `mcpServers` wholesale from a map the caller read earlier, so two
 * panel writes built on one fetched config would each carry the other's absence
 * and the later one would silently drop the earlier one's key — the
 * `wholesale-config-clobber` affordance. `setMcpServerSentinel` changes ONE
 * jsonb key in ONE statement instead, so the two cannot see each other's map
 * at all.
 *
 * A unit test cannot show this: the losing write is a real concurrent UPDATE on
 * a real row, and a mocked `db.execute` has no row to lose.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  setMcpServerSentinel: typeof import('../../src/pipeline/pipeline-config-service.js').setMcpServerSentinel;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  updatePipelineConfig: typeof import('../../src/pipeline/pipeline-config-service.js').updatePipelineConfig;
};

let testDb: TestDatabase;
let mods: Mods;
let projectId: string;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  mods = (await import('../../src/pipeline/pipeline-config-service.js')) as unknown as Mods;
});

afterAll(async () => {
  await testDb?.cleanup?.();
});

beforeEach(async () => {
  await truncateAll(testDb.db);
  const user = await createTestUser(testDb.db);
  const project = await createTestProject(testDb.db, user.id);
  projectId = project.id;
});

/** The stored map, read straight out of the jsonb column. */
async function storedServers(): Promise<Record<string, unknown>> {
  const rows = await testDb.db.execute(
    sql`SELECT agent_config -> 'pipelineConfig' -> 'mcpServers' AS m
        FROM projects WHERE id = ${projectId}`,
  );
  const row = (rows as unknown as { rows?: Array<{ m: unknown }> }).rows ?? (rows as unknown as Array<{ m: unknown }>);
  return ((row[0]?.m ?? {}) as Record<string, unknown>) ?? {};
}

async function seed(mcpServers: Record<string, unknown>): Promise<void> {
  await mods.updatePipelineConfig({ projectId, patch: { mcpServers } as never });
}

describe('setMcpServerSentinel against real Postgres (ISS-1038)', () => {
  it('two providers switched on from the same starting map both survive', async () => {
    await seed({ playwright: true });

    // Both writes are issued without either having read the other's result —
    // the shape two operators on two tabs produce.
    await Promise.all([
      mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: true }),
      mods.setMcpServerSentinel({ projectId, name: 'sentry', enabled: true }),
    ]);

    const stored = await storedServers();
    expect(stored.epodsystem).toBe(true);
    expect(stored.sentry).toBe(true);
    // And the key neither write named is untouched.
    expect(stored.playwright).toBe(true);
  });

  it('creates the mcpServers map on a project that has no pipelineConfig at all', async () => {
    await mods.setMcpServerSentinel({ projectId, name: 'postman', enabled: true });
    expect(await storedServers()).toEqual({ postman: true });
  });

  it('writes the bare boolean — nothing else lands under the key', async () => {
    await mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: true });
    const stored = await storedServers();
    expect(stored.epodsystem).toBe(true);
    // No credential, no rendered spec: the whole stored map serialises to the
    // sentinel and nothing more.
    expect(JSON.stringify(stored)).toBe('{"epodsystem":true}');
  });

  it('clearing one provider leaves every other key exactly as stored', async () => {
    await seed({
      playwright: true,
      'chrome-devtools-mcp': { type: 'stdio', command: 'npx' },
      epodsystem: true,
      sentry: true,
    });

    await mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: false });

    const stored = await storedServers();
    expect(stored.epodsystem).toBeUndefined();
    expect(stored.sentry).toBe(true);
    expect(stored.playwright).toBe(true);
    expect(stored['chrome-devtools-mcp']).toEqual({ type: 'stdio', command: 'npx' });
  });

  it('is idempotent — switching on twice leaves one key with one value', async () => {
    await mods.setMcpServerSentinel({ projectId, name: 'sentry', enabled: true });
    await mods.setMcpServerSentinel({ projectId, name: 'sentry', enabled: true });
    expect(await storedServers()).toEqual({ sentry: true });
  });

  it('clearing a provider that was never set is a no-op rather than an error', async () => {
    await seed({ playwright: true });
    await mods.setMcpServerSentinel({ projectId, name: 'postman', enabled: false });
    expect(await storedServers()).toEqual({ playwright: true });
  });
});
