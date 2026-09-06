/**
 * The phase 6 config migration, run as SQL against real Postgres.
 *
 * ISS-873 invariant 6: `sessionMode` has to leave every stored project config
 * BEFORE it leaves the `.strict()` pipeline-config schema, or every project
 * still carrying the key fails validation as a whole.
 *
 * The migration's own file is what runs here rather than a copy of its SQL, so
 * an edit to the file is what these assertions are made against. Nothing else
 * in the suite executes a hand-written data migration, and no unit lane can:
 * the abort is a `RAISE EXCEPTION` inside a `DO` block and the strip is a jsonb
 * operator, so both live entirely in the database.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/migrations/0214_duplex_strips_session_mode.sql', import.meta.url),
  ),
  'utf8',
);

let harness: TestDatabase;
let userId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
});

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
});

/** Run the migration file exactly as the migrator would. */
async function runMigration(): Promise<void> {
  await harness.client.unsafe(MIGRATION);
}

async function configOf(slug: string): Promise<Record<string, unknown> | null> {
  const rows = await harness.db.execute(
    sql`SELECT agent_config FROM projects WHERE slug = ${slug}`,
  );
  const row = (rows as unknown as Array<{ agent_config: Record<string, unknown> | null }>)[0];
  return row?.agent_config ?? null;
}

describe('ISS-873 phase 6 — stripping sessionMode from stored configs', () => {
  it('removes the key and leaves every sibling of it alone', async () => {
    await createTestProject(harness.db, userId, {
      slug: 'on-duplex',
      agentConfig: {
        pipelineConfig: {
          sessionMode: 'duplex',
          enabled: true,
          sessionResidencySeconds: 600,
          states: { open: { mode: 'auto' } },
        },
      },
    });

    await runMigration();

    const cfg = (await configOf('on-duplex')) as {
      pipelineConfig: Record<string, unknown>;
    };
    expect(cfg.pipelineConfig).not.toHaveProperty('sessionMode');
    // cm:guard the siblings are the assertion, not decoration — a `#-` path or a whole-object rewrite strips the key and takes these with it, and the project then reads as configured-by-nobody rather than as migrated.
    expect(cfg.pipelineConfig.enabled).toBe(true);
    expect(cfg.pipelineConfig.sessionResidencySeconds).toBe(600);
    expect(cfg.pipelineConfig.states).toEqual({ open: { mode: 'auto' } });
  });

  it('touches neither a config without the key nor one without a pipelineConfig at all', async () => {
    await createTestProject(harness.db, userId, {
      slug: 'key-absent',
      agentConfig: { pipelineConfig: { enabled: true } },
    });
    await createTestProject(harness.db, userId, {
      slug: 'no-pipeline-config',
      agentConfig: { projectFacts: { a: 'b' } },
    });

    await runMigration();

    expect(await configOf('key-absent')).toEqual({ pipelineConfig: { enabled: true } });
    // cm:guard a project with no `pipelineConfig` must not GAIN one — `jsonb_set` over an absent path is what conjures it, which is why the strip is guarded by a `?` existence test rather than run over every row.
    expect(await configOf('no-pipeline-config')).toEqual({ projectFacts: { a: 'b' } });
  });

  it('refuses outright when a project is explicitly opted out, naming every one', async () => {
    await createTestProject(harness.db, userId, {
      slug: 'zeta-opted-out',
      agentConfig: { pipelineConfig: { sessionMode: 'print' } },
    });
    await createTestProject(harness.db, userId, {
      slug: 'alpha-opted-out',
      agentConfig: { pipelineConfig: { sessionMode: 'print', enabled: true } },
    });
    await createTestProject(harness.db, userId, {
      slug: 'on-duplex',
      agentConfig: { pipelineConfig: { sessionMode: 'duplex' } },
    });

    await expect(runMigration()).rejects.toThrow(/explicitly opted OUT of duplex/);
  });

  it('leaves the opted-out row carrying its own answer after the refusal', async () => {
    await createTestProject(harness.db, userId, {
      slug: 'opted-out',
      agentConfig: { pipelineConfig: { sessionMode: 'print', enabled: true } },
    });
    await createTestProject(harness.db, userId, {
      slug: 'on-duplex',
      agentConfig: { pipelineConfig: { sessionMode: 'duplex' } },
    });

    await expect(runMigration()).rejects.toThrow();

    // cm:guard the one assertion that fails if the `DO` block is dropped: an opted-out project must still SAY it opted out afterwards, because a migration that stripped the key moves exactly the project that refused duplex onto duplex and leaves nothing recording that its answer was overridden.
    expect(await configOf('opted-out')).toEqual({
      pipelineConfig: { sessionMode: 'print', enabled: true },
    });
    // cm:guard asserts the migration is ALL-OR-NOTHING rather than half-applied — the abort shares one implicit transaction with the strip, so a duplex project it would have cleaned still carries its key after the refusal.
    expect(await configOf('on-duplex')).toEqual({ pipelineConfig: { sessionMode: 'duplex' } });
  });
});
