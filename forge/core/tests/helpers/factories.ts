import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TestDb } from './db.js';

/**
 * Factory defaults intentionally do NOT touch `src/db/schema.ts` — that schema
 * is still an empty `export const schema = {}` placeholder (Phase 2.1-A/B will
 * add the real `users` / `projects` tables per RFC 0002 §Schema).
 *
 * Each factory checks for the target table at call time:
 * - Table missing → throw with a clear pointer to the owning phase.
 * - Table present → insert a deterministic row and return it.
 *
 * Keeping the public signatures stable now lets every downstream integration
 * test be written today; once the schema lands, fill in the real inserts
 * without touching the call sites.
 */

export interface TestUser {
  id: string;
  email: string;
  name: string;
}

export interface CreateTestUserOverrides {
  id?: string;
  email?: string;
  name?: string;
}

export async function createTestUser(
  db: TestDb,
  overrides: CreateTestUserOverrides = {},
): Promise<TestUser> {
  await requireTable(db, 'users', 'Phase 2.1-A/B (users table)');

  const user: TestUser = {
    id: overrides.id ?? randomUUID(),
    email: overrides.email ?? `user-${randomUUID()}@test.forge.local`,
    name: overrides.name ?? 'Test User',
  };

  await db.execute(sql`
    INSERT INTO users (id, email, name)
    VALUES (${user.id}, ${user.email}, ${user.name})
  `);

  return user;
}

export interface TestProject {
  id: string;
  name: string;
  ownerId: string;
}

export interface CreateTestProjectOverrides {
  id?: string;
  name?: string;
}

export async function createTestProject(
  db: TestDb,
  ownerId: string,
  overrides: CreateTestProjectOverrides = {},
): Promise<TestProject> {
  await requireTable(db, 'projects', 'Phase 2.1-C (projects table)');

  const project: TestProject = {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? `Test Project ${randomUUID().slice(0, 8)}`,
    ownerId,
  };

  await db.execute(sql`
    INSERT INTO projects (id, name, owner_id)
    VALUES (${project.id}, ${project.name}, ${project.ownerId})
  `);

  return project;
}

async function requireTable(db: TestDb, tableName: string, ownerPhase: string): Promise<void> {
  const rows = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ${tableName}
    ) AS exists
  `);

  const first = rows[0] as { exists?: unknown } | undefined;
  if (!first || first.exists !== true) {
    throw new Error(
      `Test factory expected "${tableName}" table, but it is not defined yet. This table lands in ${ownerPhase}. Until then, either stub the table in your test or skip this factory.`,
    );
  }
}
