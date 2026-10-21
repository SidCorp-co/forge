/**
 * ISS-1421 r22 — judge-91 counted 82 connections on beta owned by organizations that no longer
 * exist: deleting an organization deletes its connections since round 21, and the ones it left
 * before that stood on, each still holding the key it was given. The dispatcher's ruling: a migration
 * removes them, their bindings with them. Run against real Postgres, the file applied as the deploy
 * applies it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0355_connections_go_with_their_org.sql', import.meta.url),
);

let harness: TestDatabase;

beforeAll(async () => {
  harness = await setupTestDatabase();
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function connection(ownerType: 'user' | 'org', ownerId: string): Promise<string> {
  const [row] = [
    ...(await harness.db.execute(
      sql`INSERT INTO integration_connections (owner_type, owner_id, provider, display_name, config)
          VALUES (${ownerType}, ${ownerId}, 'sentry', 'scratch', '{}'::jsonb) RETURNING id`,
    )),
  ] as { id: string }[];
  return row?.id as string;
}

async function bind(connectionId: string, projectId: string): Promise<void> {
  await harness.db.execute(
    sql`INSERT INTO integration_bindings (connection_id, project_id, provider, role, config)
        VALUES (${connectionId}, ${projectId}, 'sentry', 'service', '{}'::jsonb)`,
  );
}

const exists = async (table: 'integration_connections' | 'integration_bindings', id: string) => {
  const column = table === 'integration_connections' ? sql`id` : sql`connection_id`;
  const rows = await harness.db.execute(
    sql`SELECT 1 FROM ${sql.raw(table)} WHERE ${column} = ${id}`,
  );
  return [...rows].length > 0;
};

describe('migration 0355: connections go with their organization (criteria 234, 235)', () => {
  it("deletes the connections of an organization that is gone, with their bindings, and no one else's", async () => {
    const owner = await createTestUser(harness.db);
    const kept = await seedOrg(harness.db, owner.id);
    const project = await createTestProject(harness.db, owner.id, { orgId: kept.id });
    const second = await createTestProject(harness.db, owner.id, { orgId: kept.id });

    // An organization deleted before round 21 left its connections standing; its id is the ghost.
    const ghost = '00000000-0000-4000-8000-0000000000a1';
    const orphan = await connection('org', ghost);
    await bind(orphan, project.id);
    const live = await connection('org', kept.id);
    await bind(live, second.id);
    const personal = await connection('user', owner.id);

    expect(await exists('integration_connections', orphan)).toBe(true);
    expect(await exists('integration_bindings', orphan)).toBe(true);

    await harness.db.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));

    expect(await exists('integration_connections', orphan)).toBe(false);
    expect(await exists('integration_bindings', orphan)).toBe(false);
    expect(await exists('integration_connections', live)).toBe(true);
    expect(await exists('integration_bindings', live)).toBe(true);
    expect(await exists('integration_connections', personal)).toBe(true);
  });
});
