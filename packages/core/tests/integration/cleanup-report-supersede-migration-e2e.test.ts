/**
 * Migration 0599, run by drizzle's own migrator over the reports a deploy finds (ISS-912): each report
 * a fire filed is superseded by the next that fire filed, so fire e23d2b1f's 571cd8d7 (a sha naming
 * no commit) reads superseded by f74d6fcc, and a report filed without a fire, or the only one of its
 * fire, stays current.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0599_a_later_cleanup_report_supersedes_its_fires_earlier_one';

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;
let scheduleId: string;

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
  scheduleId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, 'forge', 'Forge', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO schedules (id, project_id, name, cron, kind) VALUES (${scheduleId}, ${projectId}, 'Cleanup window', '0 18 * * *', 'cleanup')`;
});

afterEach(async () => {
  await m.drop();
});

async function fire(): Promise<string> {
  const id = randomUUID();
  await m.sql`INSERT INTO schedule_runs (id, schedule_id, project_id, trigger, status, started_at) VALUES (${id}, ${scheduleId}, ${projectId}, 'scheduled', 'running', now())`;
  return id;
}

async function filed(fireId: string | null, secondsAgo: number): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO cleanup_reports (id, project_id, schedule_run_id, branch, head_sha, result, cleared, remains, covers, created_at)
    VALUES (${id}, ${projectId}, ${fireId}, 'dev', ${'c'.repeat(40)}, 'green', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
            now() - make_interval(secs => ${secondsAgo}))`;
  return id;
}

const supersededBy = async () =>
  new Map(
    (
      await m.sql<{ id: string; superseded_by: string | null }[]>`
        SELECT id, superseded_by FROM cleanup_reports`
    ).map((r) => [r.id, r.superseded_by]),
  );

describe('0599: a later cleanup report supersedes its fire’s earlier one', () => {
  it('chains each fire’s reports oldest to newest, and leaves the newest, a lone report and a fireless one current', async () => {
    const [a, b] = [await fire(), await fire()];
    const mistyped = await filed(a, 30);
    const corrected = await filed(a, 16);
    const third = await filed(a, 2);
    const lone = await filed(b, 10);
    const [loose1, loose2] = [await filed(null, 20), await filed(null, 5)];

    await m.migrate();

    const read = await supersededBy();
    expect(read.get(mistyped)).toBe(corrected);
    expect(read.get(corrected)).toBe(third);
    for (const current of [third, lone, loose1, loose2]) expect(read.get(current)).toBeNull();
  });

  it('refuses a report superseding itself', async () => {
    const id = await filed(await fire(), 1);
    await m.migrate();
    await expect(
      m.sql`UPDATE cleanup_reports SET superseded_by = id WHERE id = ${id}`,
    ).rejects.toThrow(/cleanup_reports_superseded_chk/);
  });
});
