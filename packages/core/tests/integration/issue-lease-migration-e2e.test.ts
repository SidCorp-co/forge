/**
 * ISS-1109 — the shipped migration, run against rows the old code left behind.
 *
 * The statements here are read out of `0292_issue_leases.sql` rather than
 * restated, because what has to hold is what the deploy will execute. A copy
 * of it in a test proves the copy.
 *
 * Two properties. The backfill carries every lease a live run session is
 * holding at the moment of the deploy — without it the table starts empty and
 * every issue being worked reads as free to the next box. And a pair of live
 * run sessions already holding one key ABORTS the deploy naming them, rather
 * than being cleaned away so the CREATE succeeds: that pair is the state this
 * table exists to make impossible, and picking a winner in a migration hands
 * the loser's box an issue it still believes it is running.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0292_issue_leases.sql', import.meta.url),
);

let harness: TestDatabase;

/** One statement of the shipped migration, by what it starts with. */
function statementStartingWith(prefix: string): string {
  const source = readFileSync(MIGRATION, 'utf8');
  const statements = source.split('--> statement-breakpoint');
  const hit = statements.find((s) => s.includes(prefix));
  if (!hit) {
    throw new Error(
      `0292_issue_leases.sql no longer holds a statement starting with ${prefix}. This test reads ` +
        'the shipped file rather than a copy, so a rewrite stops it instead of silently proving ' +
        'something that will not deploy.',
    );
  }
  return hit.slice(hit.indexOf(prefix));
}

const guardBlock = () => statementStartingWith('DO $$');
const backfill = () => statementStartingWith('INSERT INTO "issue_leases"');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** A run session as the OLD code left it: membership in the array, no lease row. */
async function anOldRunSession(args: {
  projectId: string;
  deviceId: string;
  issueKeys: string[];
  status?: string;
}): Promise<{ runId: string; sessionId: string }> {
  const runs = (await harness.db.execute(sql`
    INSERT INTO pipeline_runs (project_id, kind, status, metadata)
    VALUES (${args.projectId}, 'system', 'running',
            jsonb_build_object('type', 'run_session', 'runIssues',
              ${JSON.stringify(args.issueKeys)}::jsonb))
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const runId = String(runs[0]?.id);
  const sessions = (await harness.db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, title, status, started_at, metadata)
    VALUES (${args.projectId}, ${args.deviceId}, ${runId}, 'run: old', ${args.status ?? 'running'},
            now(), jsonb_build_object('type', 'run_session'))
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { runId, sessionId: String(sessions[0]?.id) };
}

async function aProjectWithTwoBoxes() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const boxA = await createTestDevice(harness.db, user.id);
  const boxB = await createTestDevice(harness.db, user.id);
  return { user, project, boxA, boxB };
}

/**
 * Everything one failed statement says, driver wrapper and cause together.
 *
 * The client wraps a Postgres error in `Failed query: <sql>` and hangs the real
 * one off `cause`, so a test matching only the top message reads every failure
 * as the same failure.
 */
async function failureTextOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return '';
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    return `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  }
}

async function leaseRows(): Promise<Array<Record<string, unknown>>> {
  return (await harness.db.execute(
    sql`SELECT issue_key, device_id, session_id, run_id FROM issue_leases ORDER BY issue_key`,
  )) as unknown as Array<Record<string, unknown>>;
}

describe('the constraint the migration installs', () => {
  it('rejects a second row for one project and issue key', async () => {
    const { project, boxA, boxB } = await aProjectWithTwoBoxes();
    const first = await anOldRunSession({
      projectId: project.id,
      deviceId: boxA.id,
      issueKeys: ['ISS-700'],
    });
    const second = await anOldRunSession({
      projectId: project.id,
      deviceId: boxB.id,
      issueKeys: ['ISS-700'],
    });
    await harness.db.execute(sql`
      INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
      VALUES (${project.id}, 'ISS-700', ${boxA.id}, ${first.sessionId}, ${first.runId})
    `);

    const failure = await failureTextOf(
      harness.db.execute(sql`
        INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
        VALUES (${project.id}, 'ISS-700', ${boxB.id}, ${second.sessionId}, ${second.runId})
      `),
    );

    expect(
      failure,
      'without the primary key nothing refuses the second taker, which is the whole defect',
    ).toMatch(/issue_leases_project_id_issue_key_pk|duplicate key/);
  });

  it('lets two projects hold the same issue key', async () => {
    const user = await createTestUser(harness.db);
    const one = await createTestProject(harness.db, user.id);
    const two = await createTestProject(harness.db, user.id);
    const box = await createTestDevice(harness.db, user.id);
    const a = await anOldRunSession({
      projectId: one.id,
      deviceId: box.id,
      issueKeys: ['ISS-700'],
    });
    const b = await anOldRunSession({
      projectId: two.id,
      deviceId: box.id,
      issueKeys: ['ISS-700'],
    });

    await harness.db.execute(sql`
      INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
      VALUES (${one.id}, 'ISS-700', ${box.id}, ${a.sessionId}, ${a.runId}),
             (${two.id}, 'ISS-700', ${box.id}, ${b.sessionId}, ${b.runId})
    `);

    expect(
      (await leaseRows()).length,
      'ISS-700 on two projects is two different issues, and a key that collided across them would strand one of them',
    ).toBe(2);
  });
});

describe('the backfill the migration runs', () => {
  it('carries every issue a live run session is holding', async () => {
    const { project, boxA } = await aProjectWithTwoBoxes();
    const live = await anOldRunSession({
      projectId: project.id,
      deviceId: boxA.id,
      issueKeys: ['ISS-700', 'ISS-701'],
    });

    await harness.db.execute(sql.raw(backfill()));

    const rows = await leaseRows();
    expect(rows.map((r) => r.issue_key)).toEqual(['ISS-700', 'ISS-701']);
    expect(rows.every((r) => String(r.session_id) === live.sessionId)).toBe(true);
  });

  it('carries nothing for a run session that is already terminal', async () => {
    const { project, boxA } = await aProjectWithTwoBoxes();
    await anOldRunSession({
      projectId: project.id,
      deviceId: boxA.id,
      issueKeys: ['ISS-702'],
      status: 'failed',
    });

    await harness.db.execute(sql.raw(backfill()));

    expect(
      await leaseRows(),
      'a dead run whose membership was never cleared would come back as a lease nobody can release',
    ).toEqual([]);
  });

  it('runs twice without raising', async () => {
    const { project, boxA } = await aProjectWithTwoBoxes();
    await anOldRunSession({
      projectId: project.id,
      deviceId: boxA.id,
      issueKeys: ['ISS-703'],
    });

    await harness.db.execute(sql.raw(backfill()));
    await harness.db.execute(sql.raw(backfill()));

    expect((await leaseRows()).length).toBe(1);
  });
});

describe('the guard the migration runs before the backfill', () => {
  it('passes where no two live run sessions hold one key', async () => {
    const { project, boxA, boxB } = await aProjectWithTwoBoxes();
    await anOldRunSession({ projectId: project.id, deviceId: boxA.id, issueKeys: ['ISS-700'] });
    await anOldRunSession({ projectId: project.id, deviceId: boxB.id, issueKeys: ['ISS-701'] });

    await expect(harness.db.execute(sql.raw(guardBlock()))).resolves.toBeDefined();
  });

  it('aborts where two live run sessions already hold one key', async () => {
    const { project, boxA, boxB } = await aProjectWithTwoBoxes();
    await anOldRunSession({ projectId: project.id, deviceId: boxA.id, issueKeys: ['ISS-700'] });
    await anOldRunSession({ projectId: project.id, deviceId: boxB.id, issueKeys: ['ISS-700'] });

    expect(
      await failureTextOf(harness.db.execute(sql.raw(guardBlock()))),
      'a migration that picks a winner deletes the evidence of the double-hold and hands the loser an issue it still believes it is running',
    ).toMatch(/ISS-1109/);
  });

  it('names the issue key it aborted over', async () => {
    const { project, boxA, boxB } = await aProjectWithTwoBoxes();
    await anOldRunSession({ projectId: project.id, deviceId: boxA.id, issueKeys: ['ISS-704'] });
    await anOldRunSession({ projectId: project.id, deviceId: boxB.id, issueKeys: ['ISS-704'] });

    expect(await failureTextOf(harness.db.execute(sql.raw(guardBlock())))).toMatch(/ISS-704/);
  });

  it('ignores a key whose second holder is terminal', async () => {
    const { project, boxA, boxB } = await aProjectWithTwoBoxes();
    await anOldRunSession({ projectId: project.id, deviceId: boxA.id, issueKeys: ['ISS-705'] });
    await anOldRunSession({
      projectId: project.id,
      deviceId: boxB.id,
      issueKeys: ['ISS-705'],
      status: 'completed',
    });

    await expect(
      harness.db.execute(sql.raw(guardBlock())),
      'every issue ever worked twice in sequence would abort the deploy if the guard counted dead runs',
    ).resolves.toBeDefined();
  });
});
