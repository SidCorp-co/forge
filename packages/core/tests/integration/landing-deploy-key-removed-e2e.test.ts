/**
 * ISS-1186 — migration `0305_no_code_fires_a_deploy.sql`, run against real Postgres.
 *
 * The subject is the file on disk, read and executed, because what is under test is what the
 * container runs at boot: a test that inspected the SQL text would pass on a file Postgres
 * refuses. The migration has already run by the time this file starts, and it deletes a jsonb key
 * and nothing else, so re-applying it over seeded rows is the same operation twice.
 *
 * `xmin` is the subject of the untouched cases rather than the value, because a jsonb column
 * rewritten to the same content is still a row this migration touched — and "touched no other
 * row" is the claim, not "left the same bytes".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const migrationPath = fileURLToPath(
  new URL('../../drizzle/migrations/0305_no_code_fires_a_deploy.sql', import.meta.url),
);

/** The retired key beside the neighbours that must come through untouched. */
const ARMED = {
  enabled: true,
  deployOnLanding: true,
  autoProdDeploy: true,
  maxResumeTokens: 150_000,
  states: { open: { enabled: true, mode: 'manual' } },
};

/** The same document with the switch explicitly OFF — a key is a key, whatever it holds. */
const DISARMED = { enabled: true, deployOnLanding: false };

/** A stored config that never carried the key at all. */
const NEVER_HAD_IT = { enabled: true, autoProdDeploy: true };

type Stored = Record<string, unknown>;

interface Row {
  agent_config: Stored;
  xmin: string;
}

describe('migration 0305 removes the landing-deploy key (ISS-1186)', () => {
  let harness: TestDatabase;
  let armedId: string;
  let disarmedId: string;
  let neverId: string;
  let noConfigId: string;
  let before: Record<string, Row>;
  let after: Record<string, Row>;
  /** A connection of this test's own: the harness client is built with `onnotice: () => {}`, so
   * what the migration says out loud is invisible on it — and what it says is the only record a
   * removed value leaves. */
  let listening: Sql;
  const notices: string[] = [];

  const read = async (): Promise<Record<string, Row>> => {
    const rows = (await harness.db.execute(
      sql`SELECT id::text AS id, agent_config, xmin::text AS xmin FROM projects`,
    )) as unknown as (Row & { id: string })[];
    return Object.fromEntries(
      rows.map((r) => [r.id, { agent_config: r.agent_config, xmin: r.xmin }]),
    );
  };

  beforeAll(async () => {
    harness = await setupTestDatabase();
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);

    armedId = (
      await createTestProject(harness.db, user.id, {
        agentConfig: { pipelineConfig: ARMED, personaStyle: 'kept' },
      })
    ).id;
    disarmedId = (
      await createTestProject(harness.db, user.id, { agentConfig: { pipelineConfig: DISARMED } })
    ).id;
    neverId = (
      await createTestProject(harness.db, user.id, {
        agentConfig: { pipelineConfig: NEVER_HAD_IT },
      })
    ).id;
    noConfigId = (await createTestProject(harness.db, user.id, { agentConfig: {} })).id;

    listening = postgres(harness.url, {
      max: 1,
      onnotice: (n) => notices.push(String(n.message ?? '')),
    });

    before = await read();
    await listening.unsafe(readFileSync(migrationPath, 'utf8'));
    after = await read();
  }, 180_000);

  afterAll(async () => {
    await listening?.end({ timeout: 5 }).catch(() => {});
    await harness?.cleanup?.();
  });

  const pipelineOf = (row: Row): Stored => row.agent_config.pipelineConfig as Stored;

  /**
   * Running the file directly proves what the SQL does, not that anything runs it. Drizzle applies
   * what the journal names, so a file present and unregistered is a cleanup that never happens.
   */
  it('is registered in the journal drizzle reads, under its own tag', () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../drizzle/migrations/meta/_journal.json', import.meta.url)),
        'utf8',
      ),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    const entry = journal.entries.find((e) => e.tag === '0305_no_code_fires_a_deploy');
    expect(entry).toBeDefined();
    // Every entry BEFORE this one, not every other entry: drizzle reads the single
    // highest `created_at` it has already applied and skips anything at or below it
    // silently, forever (ISS-807). Asserting this is the highest in the file instead
    // makes the test one no successor can satisfy — 0306 was the first, and every
    // migration after it would have been the next (ISS-1192).
    const earlier = journal.entries.filter((e) => e.idx < (entry?.idx ?? 0));
    expect(earlier.length).toBeGreaterThan(0);
    expect(entry?.when).toBeGreaterThan(Math.max(...earlier.map((e) => e.when)));
  });

  it('removes the key from a project that had it on', () => {
    expect(pipelineOf(after[armedId] as Row)).not.toHaveProperty('deployOnLanding');
  });

  it('removes the key from a project that had it off, the key being the subject and not its value', () => {
    expect(pipelineOf(after[disarmedId] as Row)).not.toHaveProperty('deployOnLanding');
  });

  it('leaves every other key of that document equal to what it held', () => {
    const { deployOnLanding: _gone, ...neighbours } = ARMED;
    expect(pipelineOf(after[armedId] as Row)).toEqual(neighbours);
  });

  it('leaves the sibling agentConfig keys of that project alone', () => {
    expect((after[armedId] as Row).agent_config.personaStyle).toBe('kept');
  });

  it('does not touch a project whose stored config never held the key', () => {
    expect((after[neverId] as Row).xmin).toBe((before[neverId] as Row).xmin);
    expect((after[neverId] as Row).agent_config).toEqual({ pipelineConfig: NEVER_HAD_IT });
  });

  it('does not touch a project with no pipelineConfig at all', () => {
    expect((after[noConfigId] as Row).xmin).toBe((before[noConfigId] as Row).xmin);
    expect((after[noConfigId] as Row).agent_config).toEqual({});
  });

  it('touches exactly the two rows that carried the key', () => {
    const rewritten = Object.keys(after)
      .filter((id) => (after[id] as Row).xmin !== (before[id] as Row).xmin)
      .sort();
    expect(rewritten).toEqual([armedId, disarmedId].sort());
  });

  it('names each project and the value it is about to remove, before removing anything', () => {
    const removals = notices.filter((n) => n.includes('removing pipelineConfig.deployOnLanding'));
    expect(removals).toHaveLength(2);
    expect(removals.some((n) => n.includes(armedId) && n.includes('= true'))).toBe(true);
    expect(removals.some((n) => n.includes(disarmedId) && n.includes('= false'))).toBe(true);
  });

  it('carries the statement that puts a removed value back', () => {
    const removal = notices.find((n) => n.includes(armedId)) ?? '';
    expect(removal).toContain('UPDATE projects SET agent_config = jsonb_set(');
    expect(removal).toContain("'{pipelineConfig,deployOnLanding}'");
  });

  it('counts what it changed', () => {
    expect(notices).toContain(
      'ISS-1186: 2 project row(s) carried deployOnLanding and no longer do',
    );
  });

  it('is safe to run twice, so a re-applied migration removes nothing further', async () => {
    const beforeSecond = await read();
    await listening.unsafe(readFileSync(migrationPath, 'utf8'));
    const afterSecond = await read();
    for (const id of Object.keys(beforeSecond)) {
      expect((afterSecond[id] as Row).xmin).toBe((beforeSecond[id] as Row).xmin);
    }
  });
});
