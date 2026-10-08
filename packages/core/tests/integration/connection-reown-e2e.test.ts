/**
 * ISS-1216 — the migration that stops an App minted before ISS-1115 belonging to one person.
 *
 * The migration's own statement is read out of the `.sql` and run against seeded rows rather than
 * restated here: a copy of the rule in this file would stay green over a migration that had
 * stopped saying the same thing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;

beforeAll(async () => {
  harness = await setupTestDatabase();
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** The migration's statements, split the way the migrator splits them. */
function statements(): string[] {
  const file = fileURLToPath(
    new URL(
      '../../drizzle/migrations/0323_a_connection_is_owned_by_the_org_that_binds_it.sql',
      import.meta.url,
    ),
  );
  const all = readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(all.length, 'the migration is no longer the one statement this test runs').toBe(1);
  return all;
}

async function migrate(): Promise<void> {
  for (const statement of statements()) await harness.db.execute(sql.raw(statement));
}

async function user(): Promise<string> {
  return (await createTestUser(harness.db)).id;
}

async function connection(args: {
  owner: { type: 'user' | 'org'; id: string };
  provider?: string;
  boundTo: string[];
}): Promise<string> {
  const rows = (await harness.db.execute(sql`
    INSERT INTO integration_connections (owner_type, owner_id, provider, display_name, config)
    VALUES (${args.owner.type}, ${args.owner.id}, ${args.provider ?? 'github'}, 'App', '{}'::jsonb)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id as string;
  for (const projectId of args.boundTo) {
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, config)
      VALUES (${id}, ${projectId}, ${args.provider ?? 'github'}, 'service', '{}', '{}'::jsonb)
    `);
  }
  return id;
}

async function ownerOf(id: string): Promise<{ owner_type: string; owner_id: string }> {
  const rows = (await harness.db.execute(
    sql`SELECT owner_type, owner_id FROM integration_connections WHERE id = ${id}`,
  )) as unknown as Array<{ owner_type: string; owner_id: string }>;
  return rows[0] as { owner_type: string; owner_id: string };
}

async function countRows(table: 'integration_connections' | 'integration_bindings') {
  const rows = (await harness.db.execute(
    sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n;
}

describe('0323 re-owns an App only where one org is unambiguous', () => {
  it('gives the App to the org whose projects it is bound to, when its owner administers that org', async () => {
    const clicker = await user();
    const org = (await seedOrg(harness.db, clicker, { ownerRole: 'admin' })).id;
    const p1 = (await createTestProject(harness.db, clicker, { orgId: org })).id;
    const p2 = (await createTestProject(harness.db, clicker, { orgId: org })).id;
    const id = await connection({ owner: { type: 'user', id: clicker }, boundTo: [p1, p2] });

    await migrate();

    expect(await ownerOf(id)).toEqual({ owner_type: 'org', owner_id: org });
  });

  it('is idempotent: a second run finds nothing to change', async () => {
    const clicker = await user();
    const org = (await seedOrg(harness.db, clicker)).id;
    const project = (await createTestProject(harness.db, clicker, { orgId: org })).id;
    const id = await connection({ owner: { type: 'user', id: clicker }, boundTo: [project] });

    await migrate();
    await migrate();

    expect(await ownerOf(id)).toEqual({ owner_type: 'org', owner_id: org });
  });

  it('leaves an App bound across two organizations with its owner, because no one org can own it', async () => {
    const clicker = await user();
    const orgA = (await seedOrg(harness.db, clicker)).id;
    const orgB = (await seedOrg(harness.db, clicker)).id;
    const a = (await createTestProject(harness.db, clicker, { orgId: orgA })).id;
    const b = (await createTestProject(harness.db, clicker, { orgId: orgB })).id;
    const id = await connection({ owner: { type: 'user', id: clicker }, boundTo: [a, b] });

    await migrate();

    expect(await ownerOf(id)).toEqual({ owner_type: 'user', owner_id: clicker });
  });

  it('leaves an App whose owner is only a member of the org, so nobody loses the right to change it', async () => {
    const clicker = await user();
    const founder = await user();
    const org = (await seedOrg(harness.db, founder)).id;
    await createTestOrgMember(harness.db, { orgId: org, userId: clicker, role: 'member' });
    const project = (await createTestProject(harness.db, founder, { orgId: org })).id;
    const id = await connection({ owner: { type: 'user', id: clicker }, boundTo: [project] });

    await migrate();

    expect(await ownerOf(id)).toEqual({ owner_type: 'user', owner_id: clicker });
  });

  it("leaves a solo operator's App theirs, since a personal org owns nothing shared", async () => {
    const solo = await user();
    const personal = (await seedOrg(harness.db, solo, { isPersonal: true })).id;
    const project = (await createTestProject(harness.db, solo, { orgId: personal })).id;
    const id = await connection({ owner: { type: 'user', id: solo }, boundTo: [project] });

    await migrate();

    expect(await ownerOf(id)).toEqual({ owner_type: 'user', owner_id: solo });
  });

  it('leaves an App that no project is bound to, and an App of another provider', async () => {
    const clicker = await user();
    const org = (await seedOrg(harness.db, clicker)).id;
    const project = (await createTestProject(harness.db, clicker, { orgId: org })).id;
    const unbound = await connection({ owner: { type: 'user', id: clicker }, boundTo: [] });
    const coolify = await connection({
      owner: { type: 'user', id: clicker },
      provider: 'coolify',
      boundTo: [project],
    });

    await migrate();

    expect(await ownerOf(unbound)).toEqual({ owner_type: 'user', owner_id: clicker });
    expect(await ownerOf(coolify)).toEqual({ owner_type: 'user', owner_id: clicker });
  });

  it('counts an App bound only through a switched-off binding, because the row still names its project', async () => {
    const clicker = await user();
    const org = (await seedOrg(harness.db, clicker)).id;
    const project = (await createTestProject(harness.db, clicker, { orgId: org })).id;
    const id = await connection({ owner: { type: 'user', id: clicker }, boundTo: [project] });
    await harness.db.execute(
      sql`UPDATE integration_bindings SET active = false WHERE connection_id = ${id}`,
    );

    await migrate();

    expect(await ownerOf(id)).toEqual({ owner_type: 'org', owner_id: org });
  });

  it('deletes and rewrites nothing else, whichever way each row went', async () => {
    const clicker = await user();
    const orgA = (await seedOrg(harness.db, clicker)).id;
    const orgB = (await seedOrg(harness.db, clicker)).id;
    const a = (await createTestProject(harness.db, clicker, { orgId: orgA })).id;
    const a2 = (await createTestProject(harness.db, clicker, { orgId: orgA })).id;
    const b = (await createTestProject(harness.db, clicker, { orgId: orgB })).id;
    await connection({ owner: { type: 'user', id: clicker }, boundTo: [a] });
    await connection({ owner: { type: 'user', id: clicker }, boundTo: [a2, b] });

    await migrate();

    expect(await countRows('integration_connections')).toBe(2);
    expect(await countRows('integration_bindings')).toBe(3);
  });
});
