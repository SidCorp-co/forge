import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

describe('integration harness', () => {
  it('runs against a database every journal migration was applied to', async () => {
    const journal = (await import('../../drizzle/migrations/meta/_journal.json')).default as {
      entries: unknown[];
    };
    const [applied] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect(applied?.n).toBe(journal.entries.length);
  });

  it('gives each file a database of its own, never the one DATABASE_URL named before it', async () => {
    const [here] = await rows<{ name: string }>(sql`SELECT current_database() AS name`);
    expect(here?.name).toMatch(/^file_[0-9a-f]{12}$/);
    const owner = await createTestUser();
    const project = await createTestProject(owner.id);
    const [found] = await rows<{ id: string }>(
      sql`SELECT id FROM projects WHERE id = ${project.id}`,
    );
    expect(found?.id).toBe(project.id);
    expect(db).toBeDefined();
  });
});
