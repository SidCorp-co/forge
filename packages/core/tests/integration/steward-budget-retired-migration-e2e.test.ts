/**
 * Migration 0664 (ISS-1255), run by drizzle's own migrator over project documents written while the
 * steward had a daily budget: each `steward.budget` is stripped as a revision Forge writes itself and
 * named in a NOTICE, a budget of no turns and no jobs turns the steward off rather than on, and a
 * document without a budget is left exactly as it was. Migration 0665 then releases the runs that
 * budget had already deferred to the next UTC midnight, so they wait for a slot and not for a day,
 * and leaves a debounce, a run already ended and a second pass alone.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';
import { MIGRATIONS_FOLDER } from '../helpers/migrations.js';

const TAG = '0664_the_steward_budget_is_retired';

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let orgId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  userId = randomUUID();
  orgId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
});

afterEach(async () => {
  await m.drop();
});

/** A project holding `extra` in its document at revision 4, last written by the person. */
async function projectWith(slug: string, extra: Record<string, unknown>) {
  const id = randomUUID();
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${id}, ${slug}, 'P', ${orgId}, ${userId})`;
  const document = { version: 1, project: { id, slug, name: 'P' }, ...extra };
  await m.sql`
    INSERT INTO project_config_documents (project_id, revision, document, updated_by, updated_at)
    VALUES (${id}, 4, ${m.sql.json(document)}, ${userId}, '2026-11-01T00:00:00Z')`;
  return { id, document };
}

async function stored(id: string) {
  const [row] = await m.sql<
    Array<{ revision: number; document: Record<string, unknown>; updated_by: string | null }>
  >`SELECT revision, document, updated_by FROM project_config_documents WHERE project_id = ${id}`;
  return row;
}

describe('a project document written while the steward had a daily budget', () => {
  it('loses the budget as a revision Forge writes, keeps enabled, and names every document in the NOTICE', async () => {
    const lowered = await projectWith('lowered', {
      steward: { enabled: true, budget: { runnerJobs: 3 } },
    });
    const bare = await projectWith('bare', { steward: { budget: { gatewayTurns: 50 } } });
    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));

    const one = await stored(lowered.id);
    expect(one).toMatchObject({ revision: 5, updated_by: null });
    expect(one?.document.steward).toEqual({ enabled: true });
    // a steward key the strip leaves empty goes with it: absent is on, as it read before
    const two = await stored(bare.id);
    expect(two?.revision).toBe(5);
    expect(two?.document).not.toHaveProperty('steward');

    const notice = notices.find((n) => n.startsWith('0664:'));
    expect(notice).toContain('2 project document(s)');
    expect(notice).toContain(`lowered (${lowered.id}): steward.budget {"runnerJobs": 3} stripped`);
    expect(notice).toContain(`bare (${bare.id}): steward.budget {"gatewayTurns": 50} stripped`);
  });

  it('turns off a steward whose budget let it do nothing, rather than switching it on', async () => {
    const zero = await projectWith('zero', {
      steward: { enabled: true, budget: { gatewayTurns: 0, runnerJobs: 0 } },
    });
    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));
    expect((await stored(zero.id))?.document.steward).toEqual({ enabled: false });
    expect(notices.join('\n')).toContain('steward.enabled set false');
  });

  it('leaves a document without a budget exactly as it was', async () => {
    const plain = await projectWith('plain', { steward: { enabled: false } });
    const none = await projectWith('none', {});
    const before = await Promise.all([plain.id, none.id].map(stored));
    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));
    expect(await Promise.all([plain.id, none.id].map(stored))).toEqual(before);
    expect(notices.find((n) => n.startsWith('0664:'))).toContain('0 project document(s)');
  });
});

describe('a steward run the retired budget deferred to the next UTC day', () => {
  const RELEASE = '0665_runs_the_retired_budget_deferred_are_released';
  let runsGround: MigrationGround;
  let r: MigrationDb;
  let projectId: string;

  beforeAll(async () => {
    runsGround = await groundBefore(RELEASE);
  }, 120_000);

  afterAll(async () => {
    await runsGround.drop();
  });

  beforeEach(async () => {
    r = await runsGround.fresh();
    const owner = randomUUID();
    const org = randomUUID();
    projectId = randomUUID();
    await r.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${owner}, ${`${owner}@forge.test`}, '!x', 'human')`;
    await r.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${org}, ${`org-${org.slice(0, 8)}`}, 'Org', false, ${owner})`;
    await r.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, 'deferred', 'P', ${org}, ${owner})`;
  });

  afterEach(async () => {
    await r.drop();
  });

  /** A run of the release follow-through on its own issue, in `state`, due at `notBefore`. */
  async function run(key: string, state: 'queued' | 'done', notBefore: Date): Promise<string> {
    const [made] = await r.sql<Array<{ id: string }>>`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, queued_at, not_before, started_at, ended_at)
      VALUES (${projectId}, 'issue', ${randomUUID()}, ${key}, 'release.shipped', '[]'::jsonb,
              ARRAY['release_followthrough']::text[], ${state}, now() - interval '1 hour',
              ${notBefore}, ${state === 'done' ? r.sql`now() - interval '50 minutes'` : null},
              ${state === 'done' ? r.sql`now() - interval '40 minutes'` : null})
      RETURNING id`;
    if (!made) throw new Error('seed: no run');
    return made.id;
  }

  /** The runs `runs-store.ts:claimDueRuns` would take now: queued and due. */
  async function claimable(): Promise<string[]> {
    const rows = await r.sql<Array<{ id: string }>>`
      SELECT id FROM steward_runs WHERE state = 'queued' AND not_before <= now()`;
    return rows.map((x) => x.id);
  }

  async function notBeforeOf(id: string): Promise<string> {
    const [row] = await r.sql<Array<{ at: string }>>`
      SELECT to_char(not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS at
        FROM steward_runs WHERE id = ${id}`;
    return row?.at ?? '';
  }

  it('is due now, waiting only for a slot, while a debounce and an ended run are left as they were', async () => {
    // the budget's stamp, `nextUtcDay(now)`: the UTC midnight after now
    const now = new Date();
    const midnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86_400_000,
    );
    const deferred = await run('ISS-1254', 'queued', midnight);
    const debounced = await run('ISS-2', 'queued', new Date(now.getTime() + 2 * 60_000));
    const ended = await run('ISS-3', 'done', midnight);
    const untouched = [debounced, ended];
    const before = await Promise.all(untouched.map(notBeforeOf));
    expect(await claimable()).toEqual([]);

    const notices: string[] = [];
    await r.migrate((n) => notices.push(n));

    expect(await claimable()).toEqual([deferred]);
    expect(await Promise.all(untouched.map(notBeforeOf))).toEqual(before);
    const notice = notices.find((n) => n.startsWith('0665:'));
    expect(notice).toContain('1 steward run(s)');
    expect(notice).toContain(
      `${deferred} (deferred issue ISS-1254): was due ${midnight.toISOString().replace('.000Z', 'Z')}`,
    );
  });

  it('changes nothing on a second pass', async () => {
    const now = new Date();
    const midnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86_400_000,
    );
    const deferred = await run('ISS-1254', 'queued', midnight);
    await r.migrate();
    const released = await notBeforeOf(deferred);
    // drizzle's migrator skips an applied migration, so the second pass is the SQL itself, re-run
    await r.sql.unsafe(readFileSync(join(MIGRATIONS_FOLDER, `${RELEASE}.sql`), 'utf8'));
    expect(await notBeforeOf(deferred)).toBe(released);
  });
});
