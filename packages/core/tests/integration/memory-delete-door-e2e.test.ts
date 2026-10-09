/**
 * ISS-1372 — a memory row is deleted by its natural key through one function, whichever door asks.
 *
 * `DELETE /api/memory/by-source` carried a delete of its own beside `deleteMemory`, which
 * `forge_memory.delete` calls. Both now answer from the same function; this file holds the two
 * doors to the same role rule and the same row.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Caller, callRest, callTool, type Door, seedRoles } from '../helpers/door-parity.js';
import {
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let callers: Record<'viewer' | 'member' | 'admin', Caller>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const seeded = await seedRoles(harness.db);
  projectId = seeded.projectId;
  callers = seeded.callers;
  await harness.db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content)
    VALUES (${projectId}, 'note', 'a-note', 'to be deleted')`);
});

async function rows(): Promise<number> {
  const r = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM memories WHERE project_id = ${projectId}`,
  )) as unknown as Array<{ n: number }>;
  return r[0]?.n ?? 0;
}

type Remove = (who: Caller) => Promise<Door>;

const doors: Record<string, Remove> = {
  'REST DELETE /api/memory/by-source': (who) =>
    callRest(
      server.baseUrl,
      who.jwt,
      'DELETE',
      `/api/memory/by-source?projectId=${projectId}&source=note&sourceRef=a-note`,
    ),
  'forge_memory.delete': (who) =>
    callTool(who.pat, 'forge_memory.delete', { projectId, source: 'note', sourceRef: 'a-note' }),
};

describe.each(Object.entries(doors))('%s', (_name, remove) => {
  it('refuses a viewer and keeps the row', async () => {
    expect((await remove(callers.viewer)).refused).toBeDefined();
    expect(await rows()).toBe(1);
  });

  it('removes the row for a member', async () => {
    expect(await remove(callers.member)).not.toHaveProperty('refused');
    expect(await rows()).toBe(0);
  });
});
