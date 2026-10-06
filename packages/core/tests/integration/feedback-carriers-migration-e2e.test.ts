/**
 * Migration 0429, run by drizzle's own migrator over the rows the old schema left: every item routed to
 * one issue through `feedback.routed_issue_id` keeps that issue as its one carrier in
 * `feedback_route_issues`, the column goes, and the database holds an issue route to its carriers from
 * then on (ISS-265).
 */

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0429_a_feedback_item_is_carried_by_several_issues';

let ground: MigrationGround;
let m: MigrationDb;
let person: string;
let projectId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  person = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${person}, ${`${person}@forge.test`}, '!x', 'human')`;
  const orgId = randomUUID();
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${person})`;
  projectId = randomUUID();
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'Atlas', ${orgId}, ${person})`;
});

afterEach(async () => {
  await m.drop();
});

async function issue(db: postgres.Sql, seq: number): Promise<string> {
  const id = randomUUID();
  await db`INSERT INTO issues (id, project_id, iss_seq, title, created_by_id) VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${person})`;
  return id;
}

/** An item as either schema takes it: `routed_issue_id` is named only where the old column is meant. */
async function item(
  db: postgres.Sql,
  seq: number,
  routed: { status: string; route: string | null; issue?: string; answer?: string },
): Promise<string> {
  const id = randomUUID();
  const row: Record<string, string | number | null> = {
    id,
    project_id: projectId,
    fb_seq: seq,
    kind: 'bug',
    title: `item ${seq}`,
    where_seen: 'The board',
    status: routed.status,
    route: routed.route,
    answer: routed.answer ?? null,
    reported_by: person,
    reporter_agency: 'human',
  };
  if (routed.issue) row.routed_issue_id = routed.issue;
  await db`INSERT INTO feedback ${db(row)}`;
  return id;
}

async function refusedBy(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error('the write was not refused');
}

describe('an item routed to one issue before the migration', () => {
  it('keeps that issue as its one carrier, and only issue-routed items gain one', async () => {
    const carrier = await issue(m.sql, 1);
    const routed = await item(m.sql, 1, { status: 'triaged', route: 'issue', issue: carrier });
    const answered = await item(m.sql, 2, { status: 'triaged', route: 'answer', answer: 'Yes.' });
    const untriaged = await item(m.sql, 3, { status: 'new', route: null });
    await m.migrate();
    const carriers = await m.sql<{ feedback_id: string; issue_id: string }[]>`
      SELECT feedback_id, issue_id FROM feedback_route_issues ORDER BY feedback_id`;
    expect(carriers.map((c) => [c.feedback_id, c.issue_id])).toEqual([[routed, carrier]]);
    const left = await m.sql<{ id: string; route: string | null }[]>`
      SELECT id, route FROM feedback WHERE id IN (${routed}, ${answered}, ${untriaged}) ORDER BY fb_seq`;
    expect(left.map((r) => r.route)).toEqual(['issue', 'answer', null]);
  });

  it('drops the one-carrier column', async () => {
    await m.migrate();
    const [column] = await m.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'feedback' AND column_name = 'routed_issue_id'`;
    expect(column?.n).toBe(0);
  });
});

describe('after the migration the database holds an issue route to its carriers', () => {
  it('refuses an issue route committed with no carrier', async () => {
    await m.migrate();
    const said = await refusedBy(item(m.sql, 1, { status: 'triaged', route: 'issue' }));
    expect(said).toContain('FEEDBACK_ROUTE_INCOMPLETE');
  });

  it('takes an issue route and its carriers written in one transaction, several of them', async () => {
    await m.migrate();
    const a = await issue(m.sql, 1);
    const b = await issue(m.sql, 2);
    await m.sql.begin(async (tx) => {
      const fb = await item(tx as unknown as postgres.Sql, 1, {
        status: 'triaged',
        route: 'issue',
      });
      await tx`INSERT INTO feedback_route_issues (feedback_id, issue_id) VALUES (${fb}, ${a}), (${fb}, ${b})`;
    });
    const [held] = await m.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM feedback_route_issues`;
    expect(held?.n).toBe(2);
  });

  it('refuses a carrier left on an item routed elsewhere', async () => {
    await m.migrate();
    const a = await issue(m.sql, 1);
    const fb = await item(m.sql, 1, { status: 'triaged', route: 'answer', answer: 'Yes.' });
    const said = await refusedBy(
      m.sql`INSERT INTO feedback_route_issues (feedback_id, issue_id) VALUES (${fb}, ${a})`,
    );
    expect(said).toContain('FEEDBACK_ROUTE_TARGET_MISMATCH');
  });
});
