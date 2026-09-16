// ISS-1048 — release readiness answers "does this project declare its test commands?" from the
// slugs `selectAllSlugsFromKnowledge` returns. That is only sound while a present slug means real
// text. `bodySchema` refuses a whitespace body at the door, but migration 0254 copies every
// `agentConfig.projectFacts` value across unchanged, from a map that had no such rule — so a
// project that held `test-commands: "   "` arrives holding a row that would answer its obligation
// with three spaces, where the contract this replaces read the text, trimmed it, and reported the
// gap. A validator cannot repair rows that predate it, so the fence is in the query.
//
// The assertion goes red by deleting `btrim(body) <> ''` from the query: the whitespace slug comes
// back and the gap it should have reported disappears. Real Postgres, because every unit test of
// this path mocks the function itself and cannot see the SQL.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let service: typeof import('../../src/knowledge/service.js');

async function insertRaw(slug: string, body: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO knowledge_entries (project_id, kind, slug, title, body)
    VALUES (${projectId}::uuid, 'convention', ${slug}, ${`Title ${slug}`}, ${body})`);
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  // The service reads through the app's own `db` singleton, which binds at import. Point it at
  // this file's disposable schema BEFORE that import, or it connects to whatever DATABASE_URL the
  // shell happened to hold.
  process.env.DATABASE_URL = harness.url;
  // `config/env.ts` parses the whole environment at module scope and `db/client.ts` imports it, so
  // importing the service below throws before any test body runs unless these are present. They are
  // absent on CI and were present in the shell that first ran this file, which is exactly how this
  // passed locally and failed there. Set per file, the way every other integration test that
  // imports a service does it; ISS-1067 is the issue that stops import-time parsing being a thing
  // each test has to know about.
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id, {
    name: `iss1048-${randomUUID().slice(0, 8)}`,
  });
  projectId = project.id;
  service = await import('../../src/knowledge/service.js');

  // Written the way migration 0254 writes them — straight INSERT, no validator in the path,
  // exactly as a row copied out of the old `projectFacts` map arrives.
  await insertRaw('test-commands', '   ');
  await insertRaw('build-commands', '\n\t \n');
  await insertRaw('release-procedure', 'Tag, then run the release batch.');
});

afterAll(async () => {
  await harness.cleanup?.();
});

describe('a slug only answers its obligation when the row behind it holds text (ISS-1048)', () => {
  it('does not report a whitespace-bodied slug as held', async () => {
    const held = await service.selectAllSlugsFromKnowledge(projectId);
    expect(held).not.toContain('test-commands');
    expect(held).not.toContain('build-commands');
  });

  it('still reports a slug whose row holds real text', async () => {
    const held = await service.selectAllSlugsFromKnowledge(projectId);
    expect(held).toContain('release-procedure');
  });

  it('starts holding the slug once the body is filled in', async () => {
    await harness.db.execute(sql`
      UPDATE knowledge_entries SET body = 'pnpm test'
      WHERE project_id = ${projectId}::uuid AND slug = 'test-commands'`);
    const held = await service.selectAllSlugsFromKnowledge(projectId);
    expect(held).toContain('test-commands');
  });
});
