/**
 * Migration 0575, run by drizzle's own migrator over the rows the old code left (ISS-851, owner
 * ruling 2026-11-01, `release-is-the-agents-record`): a release its agent recorded stored
 * verification `unverified`, its ledger verdict `unverified`, and readings ending "Forge read no
 * deploy". Each becomes `recorded`, the agent's record being the release. A release proved by a probe
 * is left as it was. Run a second time it changes nothing, and a run storing a verification no
 * release state represents aborts the deploy naming it.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';
import { MIGRATIONS_FOLDER } from '../helpers/migrations.js';

const TAG = '0575_a_release_the_agent_recorded_reads_recorded';

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  const userId = randomUUID();
  const orgId = randomUUID();
  projectId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
});

afterEach(async () => {
  await m.drop();
});

/** A release run as the old code left it, with its ledger row. */
async function release(metadata: object, verdict: string, readings: string[], reason: string) {
  const id = randomUUID();
  await m.sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${id}, ${projectId}, 'system', 'completed', now(), ${m.sql.json(metadata as never)})
  `;
  await m.sql`
    INSERT INTO release_attempts (run_id, stage, idempotency_key, verdict, verdict_reason, readings)
    VALUES (${id}, 'verify', 'release-record', ${verdict}, ${reason}, ${m.sql.json(readings as never)})
  `;
  return id;
}

async function read(id: string) {
  const [run] = await m.sql<Array<{ metadata: Record<string, unknown> }>>`
    SELECT metadata FROM pipeline_runs WHERE id = ${id}
  `;
  const [attempt] = await m.sql<
    Array<{ verdict: string; verdict_reason: string; readings: string[] }>
  >`SELECT verdict, verdict_reason, readings FROM release_attempts WHERE run_id = ${id}`;
  return { metadata: run?.metadata ?? {}, ...attempt };
}

/** The file's statements run again, by hand: the migrator itself never re-applies a recorded tag. */
async function runAgain(): Promise<void> {
  const text = readFileSync(`${MIGRATIONS_FOLDER}/${TAG}.sql`, 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    if (statement.trim()) await m.sql.unsafe(statement);
  }
}

async function refusal(): Promise<string> {
  try {
    await m.migrate();
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    return `${err.message} ${err.cause?.message ?? ''}`;
  }
  return 'migrated';
}

const EPOD = {
  source: 'release-record',
  verification: 'unverified',
  finish: { state: 'finished', verification: 'unverified' },
};

describe('0575: a release its agent recorded reads recorded', () => {
  it('renames the run, its finish and its ledger row, and drops "Forge read no deploy"', async () => {
    const epod = await release(
      EPOD,
      'unverified',
      ['recorded by its agent as 1.31.1; Forge read no deploy'],
      'recorded by its agent as 1.31.1; Forge reads no commit and checked no deploy',
    );
    const probed = await release(
      { source: 'release-batch', verification: 'probed' },
      'ok',
      ['probe 1 reads abc'],
      'two readings agreed',
    );

    await m.migrate();

    const r = await read(epod);
    expect(r.metadata.verification).toBe('recorded');
    expect((r.metadata.finish as Record<string, unknown>).verification).toBe('recorded');
    expect(r.verdict).toBe('recorded');
    expect(r.readings).toEqual(['recorded by its agent as 1.31.1']);
    expect(r.verdict_reason).toBe('recorded by its agent as 1.31.1');
    const p = await read(probed);
    expect(p.metadata.verification).toBe('probed');
    expect(p).toMatchObject({ verdict: 'ok', readings: ['probe 1 reads abc'] });
  });

  it('refuses a ledger verdict unverified once it has run', async () => {
    await m.migrate();
    const id = randomUUID();
    await m.sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
      VALUES (${id}, ${projectId}, 'system', 'completed', now(), '{}'::jsonb)
    `;
    await expect(
      m.sql`INSERT INTO release_attempts (run_id, stage, idempotency_key, verdict)
            VALUES (${id}, 'verify', 'release-record', 'unverified')`,
    ).rejects.toThrow(/release_attempts_verdict_chk/);
  });

  it('run twice, changes nothing the first run left', async () => {
    const epod = await release(EPOD, 'unverified', ['recorded by its agent as 2.0.0'], 'x');
    await m.migrate();
    const first = await read(epod);

    await runAgain();

    expect(await read(epod)).toEqual(first);
  });

  it('aborts naming a run whose stored verification no release state represents', async () => {
    const odd = await release({ verification: 'eyeballed' }, 'ok', [], 'x');

    const said = await refusal();

    expect(said).toContain(`pipeline run ${odd} stores verification eyeballed`);
  });
});
