/**
 * Migration 0344 over the `issue.updated` rows the old code left, then the boot backfill (ISS-124).
 * 0344 must convert nothing at boot, because beta holds hundreds of thousands of such rows and a
 * migration that rewrites them in one transaction outlives the container's health window. The
 * backfill converts one issue's chain per transaction, resumes after a kill, and records the
 * `activity-field-changes` marker only when no chain is left or refused.
 */

import { randomUUID } from 'node:crypto';
import { convertSnapshotPayload } from '@forge/contracts/field-changes';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_FIELD_CHANGES_KEY,
  type Executor,
  runActivityFieldChangesBackfillOnce,
} from '../../src/issues/activity-backfill.js';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0344_an_issue_update_records_what_changed';

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;
let person: string;
let seq = 0;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  person = randomUUID();
  projectId = randomUUID();
  const orgId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${person}, ${`${person}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${person})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${person})`;
});

afterEach(async () => {
  await m.drop();
});

const conn = () => drizzle(m.sql) as unknown as Executor;

async function issue(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await m.sql`INSERT INTO issues (id, project_id, iss_seq, title, created_by_id) VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${person})`;
  return id;
}

interface Snapshot {
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

async function row(issueId: string, at: number, payload: unknown): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO activity_log (id, issue_id, actor_type, actor_id, actor_agency, action, payload, created_at)
    VALUES (${id}, ${issueId}, 'user', ${person}, 'person', 'issue.updated', ${m.sql.json(payload as never)}, to_timestamp(${1_700_000_000 + at}))
  `;
  return id;
}

/** A chain of `n` snapshot rows: status walks forward, sessionContext grows a lease history. */
async function chain(issueId: string, n: number): Promise<Array<{ id: string; snap: Snapshot }>> {
  const out: Array<{ id: string; snap: Snapshot }> = [];
  let status = 'open';
  let history: unknown[] = [];
  for (let i = 0; i < n; i += 1) {
    const nextStatus = `s${i}`;
    const nextHistory = [...history, { n: i }];
    const snap: Snapshot = {
      fields: ['status', 'sessionContext', 'title'],
      before: { status, sessionContext: { lease: { history } }, title: 'same' },
      after: {
        status: nextStatus,
        sessionContext: { lease: { history: nextHistory } },
        title: 'same',
      },
    };
    out.push({ id: await row(issueId, i, snap), snap });
    status = nextStatus;
    history = nextHistory;
  }
  return out;
}

async function payloads(issueId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await m.sql<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload FROM activity_log WHERE issue_id = ${issueId} AND action = 'issue.updated' ORDER BY created_at, id`;
  return rows.map((r) => r.payload);
}

async function unconverted(): Promise<number> {
  const [r] = await m.sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM activity_log WHERE action = 'issue.updated' AND NOT payload ? 'changes'`;
  return r?.n ?? 0;
}

async function marked(): Promise<boolean> {
  const [r] = await m.sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM backfill_markers WHERE key = ${ACTIVITY_FIELD_CHANGES_KEY}`;
  return (r?.n ?? 0) > 0;
}

describe('migration 0344 at boot', () => {
  it('converts no row and leaves the two functions for the backfill to call', async () => {
    const a = await issue();
    await chain(a, 3);

    await m.migrate();

    expect(await unconverted()).toBe(3);
    const [fn] = await m.sql<Array<{ ok: boolean }>>`
      SELECT to_regprocedure('forge_issue_update_convert(uuid)') IS NOT NULL AS ok`;
    expect(fn?.ok).toBe(true);
  });
});

describe('the activity-field-changes backfill', () => {
  it('converts every chain, matching the TypeScript reading of each row, and sets the marker', async () => {
    const issues = [await issue(), await issue(), await issue()];
    const written = await Promise.all(issues.map((i) => chain(i, 4)));
    await m.migrate();

    const report = await runActivityFieldChangesBackfillOnce(conn());

    expect(report).toMatchObject({ chains: 3, rows: 12, refusals: [] });
    expect(await unconverted()).toBe(0);
    expect(await marked()).toBe(true);
    for (const [k, id] of issues.entries()) {
      const stored = await payloads(id);
      for (const [i, p] of stored.entries()) {
        const snap = written[k]?.[i]?.snap;
        const twin = convertSnapshotPayload(snap);
        expect(p.changes).toEqual(twin.changes);
        expect(p.fields).toEqual(['status', 'sessionContext']);
        expect(p.unchanged).toEqual(['title']);
      }
      // The anchor rule: the first row names every field's whole before; the next rows only the
      // field the previous row's after does not give (none here, the chain is contiguous).
      expect(Object.keys((stored[0]?.anchor ?? {}) as object).sort()).toEqual([
        'sessionContext',
        'status',
        'title',
      ]);
      expect(stored[1]?.anchor).toBeUndefined();
    }
    expect(await runActivityFieldChangesBackfillOnce(conn())).toBeNull();
  });

  it('anchors a field whose previous row does not give its before', async () => {
    const a = await issue();
    await row(a, 0, { fields: ['status'], before: { status: 'a' }, after: { status: 'b' } });
    await row(a, 1, { fields: ['status'], before: { status: 'zzz' }, after: { status: 'c' } });
    await m.migrate();

    await runActivityFieldChangesBackfillOnce(conn());

    const stored = await payloads(a);
    expect(stored[0]?.anchor).toEqual({ status: 'a' });
    expect(stored[1]?.anchor).toEqual({ status: 'zzz' });
  });

  it('finds nothing on a database with no snapshot row and sets the marker at once', async () => {
    await m.migrate();

    const report = await runActivityFieldChangesBackfillOnce(conn());

    expect(report).toMatchObject({ chains: 0, rows: 0, refusals: [] });
    expect(await marked()).toBe(true);
  });

  it('keeps what a killed run reached, and the next run finishes the rest and sets the marker', async () => {
    const issues = [await issue(), await issue(), await issue(), await issue()];
    for (const i of issues) await chain(i, 3);
    await m.migrate();

    const real = conn();
    let converted = -1; // the first transaction is the marker read
    const killed = {
      execute: real.execute.bind(real),
      transaction: ((fn: never) => {
        if (converted >= 2) return new Promise(() => {});
        converted += 1;
        return real.transaction(fn);
      }) as typeof real.transaction,
    };
    void runActivityFieldChangesBackfillOnce(killed);
    while (converted < 2 || (await unconverted()) > 6) await new Promise((r) => setTimeout(r, 20));
    // two chains of three rows are committed, the process "dies" at the third
    expect(await unconverted()).toBe(6);
    expect(await marked()).toBe(false);

    const report = await runActivityFieldChangesBackfillOnce(conn());

    expect(report).toMatchObject({ chains: 2, rows: 6, refusals: [] });
    expect(await unconverted()).toBe(0);
    expect(await marked()).toBe(true);
  });

  it('refuses a chain by name, converts the others, and leaves the marker unset', async () => {
    const good = await issue();
    const bad = await issue();
    await chain(good, 2);
    await row(bad, 0, { fields: ['status'], before: { status: 'a' }, after: {} });
    await m.migrate();

    const report = await runActivityFieldChangesBackfillOnce(conn());

    expect(report?.chains).toBe(1);
    expect(report?.refusals).toHaveLength(1);
    expect(report?.refusals[0]?.issueId).toBe(bad);
    expect(report?.refusals[0]?.reason).toContain(
      'field "status" is listed in "fields" with no value in "after"',
    );
    expect(await marked()).toBe(false);
    expect(await unconverted()).toBe(1);
  });

  it('converts the snapshot rows of a chain a new-shape row already follows, and leaves that row', async () => {
    const a = await issue();
    await chain(a, 2);
    await m.migrate();
    const newer = {
      fields: ['status'],
      changes: [{ path: ['status'], op: 'set', before: 's1', after: 'done' }],
    };
    await row(a, 100, newer);

    const report = await runActivityFieldChangesBackfillOnce(conn());

    expect(report).toMatchObject({ chains: 1, rows: 2, refusals: [] });
    const stored = await payloads(a);
    expect(stored).toHaveLength(3);
    expect(stored[2]).toEqual(newer);
  });

  it(`converts ${process.env.ISS124_ROWS ?? 400} rows and reports the per-chain cost`, async () => {
    const total = Number(process.env.ISS124_ROWS ?? 400);
    const perChain = 40;
    const chains = Math.ceil(total / perChain);
    for (let c = 0; c < chains; c += 1) {
      const id = await issue();
      await m.sql`
        INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload, created_at)
        SELECT ${id}, 'user', ${person}, 'person', 'issue.updated',
          jsonb_build_object('fields', jsonb_build_array('status', 'sessionContext'),
            'before', jsonb_build_object('status', 's' || (g - 1), 'sessionContext', jsonb_build_object('blob', repeat('x', 11000), 'lease', jsonb_build_object('n', g - 1))),
            'after', jsonb_build_object('status', 's' || g, 'sessionContext', jsonb_build_object('blob', repeat('x', 11000), 'lease', jsonb_build_object('n', g)))),
          to_timestamp(1700000000 + g)
        FROM generate_series(1, ${perChain}) g`;
    }
    await m.migrate();
    const started = performance.now();

    const report = await runActivityFieldChangesBackfillOnce(conn());

    const ms = performance.now() - started;
    process.stderr.write(
      `ISS-124 measure: ${report?.rows} rows, ${report?.chains} chains, ${Math.round(ms)} ms, ${(ms / (report?.chains ?? 1)).toFixed(1)} ms/chain\n`,
    );
    expect(report?.rows).toBe(chains * perChain);
    expect(await unconverted()).toBe(0);
  }, 600_000);
});
