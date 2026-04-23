import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TestDb } from './db.js';

/**
 * `createTestUser` inserts against the real `users` table (Phase 2.1-C).
 * `createTestProject` still stubs until Phase 2.1 (ISS-147) lands the
 * `projects` table.
 */

export interface TestUser {
  id: string;
  email: string;
}

export interface CreateTestUserOverrides {
  id?: string;
  email?: string;
  passwordHash?: string;
}

export async function createTestUser(
  db: TestDb,
  overrides: CreateTestUserOverrides = {},
): Promise<TestUser> {
  const user: TestUser = {
    id: overrides.id ?? randomUUID(),
    email: overrides.email ?? `user-${randomUUID()}@test.forge.local`,
  };
  const passwordHash = overrides.passwordHash ?? '!test-not-a-real-hash';

  await db.execute(sql`
    INSERT INTO users (id, email, password_hash)
    VALUES (${user.id}, ${user.email}, ${passwordHash})
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
  await requireTable(db, 'projects', 'Phase 2.1 (projects table, ISS-147)');

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
