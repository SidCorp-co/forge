/**
 * ISS-1317 — migration 0316 shows a project's agent account under its handle.
 *
 * The migration's own text is read from its file rather than restated, so what is proved is what
 * runs at the deploy. The template database already carries it, so each case plants the accounts
 * the migration would have met and runs it again.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL(
    '../../drizzle/migrations/0316_an_agent_account_is_shown_by_its_handle.sql',
    import.meta.url,
  ),
);

let harness: TestDatabase;
let orgId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  orgId = (await seedOrg(harness.db, owner.id)).id;
});

async function account(opts: {
  kind: 'agent' | 'human';
  handle: string | null;
  displayName?: string;
  inOrg?: string;
}): Promise<string> {
  const { id } = await createTestUser(harness.db, { kind: opts.kind });
  if (opts.displayName !== undefined) {
    await harness.db.execute(
      sql`UPDATE users SET display_name = ${opts.displayName} WHERE id = ${id}`,
    );
  }
  await harness.db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role, handle)
    VALUES (${opts.inOrg ?? orgId}, ${id}, 'member', ${opts.handle})
  `);
  return id;
}

async function labelOf(id: string): Promise<string | null> {
  const rows = await harness.db.execute(sql`SELECT display_name FROM users WHERE id = ${id}`);
  return (rows[0] as { display_name: string | null }).display_name;
}

/** Each account's label beside its row version, which moves on any write to the row. */
async function everyRow(): Promise<unknown[]> {
  return [
    ...(await harness.db.execute(
      sql`SELECT id, display_name, xmin::text AS version FROM users ORDER BY id`,
    )),
  ];
}

async function runMigration() {
  for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) await harness.db.execute(sql.raw(statement));
  }
}

describe('migration 0316', () => {
  it('labels an agent account that has none with the handle on its organization membership', async () => {
    const agent = await account({ kind: 'agent', handle: 'forge-dev' });
    await runMigration();
    expect(await labelOf(agent)).toBe('forge-dev');
  });

  it('leaves a label somebody already set as it is', async () => {
    const agent = await account({ kind: 'agent', handle: 'forge-dev', displayName: 'Release bot' });
    await runMigration();
    expect(await labelOf(agent)).toBe('Release bot');
  });

  it('leaves a person with no label unlabelled, handle or not', async () => {
    const person = await account({ kind: 'human', handle: 'somebody' });
    await runMigration();
    expect(await labelOf(person)).toBeNull();
  });

  it('leaves an agent whose membership names no handle unlabelled', async () => {
    const agent = await account({ kind: 'agent', handle: null });
    await runMigration();
    expect(await labelOf(agent)).toBeNull();
  });

  it('skips an agent with memberships in two organizations rather than choosing one', async () => {
    const agent = await account({ kind: 'agent', handle: 'first' });
    const other = await seedOrg(harness.db, (await createTestUser(harness.db)).id);
    await harness.db.execute(sql`
      INSERT INTO organization_members (org_id, user_id, role, handle)
      VALUES (${other.id}, ${agent}, 'member', 'second')
    `);
    await runMigration();
    expect(await labelOf(agent)).toBeNull();
  });

  it('changes no row when it runs a second time', async () => {
    await account({ kind: 'agent', handle: 'forge-dev' });
    await account({ kind: 'agent', handle: 'other-one', displayName: 'Kept' });
    await account({ kind: 'human', handle: null });
    await runMigration();
    const once = await everyRow();
    await runMigration();
    expect(once.length).toBeGreaterThan(3);
    expect(await everyRow()).toEqual(once);
  });
});
