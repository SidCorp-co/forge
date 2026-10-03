/**
 * ISS-54 — `0346_issue_status_is_who_it_waits_on.sql`, run against rows the seventeen-status code
 * left behind. The statements are read out of the shipped file, not restated: what has to hold is
 * what the deploy will execute.
 *
 * Every migration below 0346 goes into one template; each case clones it, because after the
 * forward run there is no seventeen-status column left to plant a row into.
 *
 * Two properties. Every row maps by the migration's one table — status, step, retired rung, park
 * kind and the status a park left — with its lease moved out of the blob and its branch and head
 * lifted into typed columns. And a row the table cannot say ABORTS the deploy naming it: nothing is
 * guessed and nothing is deleted to make the data fit.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseDbName, drainRetiredScratchDbs, retireScratchDb } from '../helpers/scratch-db.js';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/migrations', import.meta.url));

function migrationParts(): { below: string[]; target: string[] } {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
  const target = files.find((f) => f.sql.join('\n').includes('iss54_mapped_status'));
  if (!target) throw new Error('0346_issue_status_is_who_it_waits_on.sql is not in the folder');
  const below = files
    .filter((f) => f.folderMillis < target.folderMillis)
    .sort((a, b) => a.folderMillis - b.folderMillis)
    .flatMap((f) => f.sql);
  return { below, target: target.sql };
}

const { below, target } = migrationParts();

let adminUrl = '';
let admin: Sql;
let template = '';

beforeAll(async () => {
  adminUrl = process.env.TEST_PG_ADMIN_URL ?? process.env.TEST_DATABASE_URL ?? '';
  if (!adminUrl) throw new Error('no TEST_PG_ADMIN_URL — global setup did not run');
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  template = caseDbName('iss54tpl');
  await admin.unsafe(`CREATE DATABASE "${template}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${template}`;
  const tpl = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await tpl.begin(async (tx) => {
      for (const stmt of below) await tx.unsafe(stmt, []);
    });
  } finally {
    await tpl.end({ timeout: 5 });
  }
}, 180_000);

afterAll(async () => {
  if (template) retireScratchDb(adminUrl, template);
  await drainRetiredScratchDbs();
  await admin?.end({ timeout: 5 });
});

async function fresh(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  const name = caseDbName('iss54');
  await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  return {
    sql,
    drop: async () => {
      await sql.end({ timeout: 5 }).catch(() => {});
      retireScratchDb(adminUrl, name);
    },
  };
}

async function runForward(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    for (const stmt of target) await tx.unsafe(stmt, []);
  });
}

interface Ground {
  ownerId: string;
  projectId: string;
}

async function ground(sql: Sql): Promise<Ground> {
  const ownerId = randomUUID();
  const orgId = randomUUID();
  const projectId = randomUUID();
  await sql.unsafe(
    `INSERT INTO users (id, email, kind, email_verified_at) VALUES ($1, $2, 'human', now())`,
    [ownerId, `owner-${ownerId.slice(0, 8)}@example.com`],
  );
  await sql.unsafe(
    `INSERT INTO organizations (id, name, slug, created_by) VALUES ($1, $2, $3, $4)`,
    [orgId, `org ${orgId.slice(0, 8)}`, `org-${orgId.slice(0, 8)}`, ownerId],
  );
  await sql.unsafe(
    `INSERT INTO projects (id, slug, name, created_by, org_id) VALUES ($1, $2, $2, $3, $4)`,
    [projectId, `p-${projectId.slice(0, 8)}`, ownerId, orgId],
  );
  return { ownerId, projectId };
}

async function plantIssue(
  sql: Sql,
  g: Ground,
  status: string,
  extra: { waitingKind?: string | null; sessionContext?: unknown; mergedAt?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await sql.unsafe(
    `INSERT INTO issues (id, project_id, title, created_by_id, status, waiting_kind, session_context,
                         merged_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, CASE WHEN $8::boolean THEN now() END)`,
    [
      id,
      g.projectId,
      `at ${status}`,
      g.ownerId,
      status,
      extra.waitingKind ?? null,
      extra.sessionContext === undefined ? null : JSON.stringify(extra.sessionContext),
      extra.mergedAt === true,
    ],
  );
  return id;
}

/** An audited move the old code wrote, at a given age. */
async function plantMove(sql: Sql, issueId: string, from: string, to: string, minutesAgo: number) {
  await sql.unsafe(
    `INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type,
                                     actor_agency, source, created_at)
     VALUES ('issue', $1, $2, $3, 'system', 'agent', 'test', now() - ($4 || ' minutes')::interval)`,
    [issueId, from, to, String(minutesAgo)],
  );
}

async function errorOf(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

const KIND = 'rule';
const HEAD = 'ABCDEF0123456789abcdef0123456789abcdef01';

describe('0346 maps every row by its one table', () => {
  it('maps each of the seventeen statuses, its step, rung, kind, lease, branch and left status', async () => {
    const { sql, drop } = await fresh();
    try {
      const g = await ground(sql);
      const lease = { holder: 'run-7', renewedAt: '2026-10-01T00:00:00Z', minutes: 30 };
      const ids: Record<string, string> = {};
      for (const status of [
        'draft',
        'open',
        'confirmed',
        'clarified',
        'approved',
        'in_progress',
        'testing',
        'tested',
        'awaiting_release',
        'releasing',
        'reopen',
        'on_hold',
        'dropped',
      ]) {
        ids[status] = await plantIssue(sql, g, status);
      }
      ids.closed = await plantIssue(sql, g, 'closed', { mergedAt: true });
      ids.developed = await plantIssue(sql, g, 'developed', {
        sessionContext: { lease, worklog: { branch: 'ISS-1-x', head: HEAD }, note: 'kept' },
      });
      ids.waiting = await plantIssue(sql, g, 'waiting', { waitingKind: 'needs_resource' });
      ids.needs_info = await plantIssue(sql, g, 'needs_info');
      ids.needs_info_kind = await plantIssue(sql, g, 'needs_info', {
        waitingKind: 'needs_decision',
      });
      await plantMove(sql, ids.needs_info as string, 'open', 'developed', 30);
      await plantMove(sql, ids.needs_info as string, 'developed', 'needs_info', 20);
      await plantMove(sql, ids.on_hold as string, 'testing', 'on_hold', 50);
      await plantMove(sql, ids.on_hold as string, 'on_hold', 'needs_info', 40);
      await plantMove(sql, ids.on_hold as string, 'needs_info', 'on_hold', 10);

      await runForward(sql);

      const rows = (await sql.unsafe(`
        SELECT i.id, i.status, i.waiting_kind, i.session_context, w.step, w.legacy_status,
               w.left_status, w.lease_holder, w.branch, w.head_sha,
               issue_session_context(i.id, i.session_context) AS composed
          FROM issues i LEFT JOIN issue_work_state w ON w.issue_id = i.id
      `)) as unknown as Array<Record<string, unknown>>;
      const at = (key: string) => rows.find((r) => r.id === ids[key]) as Record<string, unknown>;
      const expected: Array<[string, string, string | null, string | null, string | null]> = [
        // old status, status, step, legacy rung, waiting kind
        ['draft', 'draft', null, null, null],
        ['open', 'open', null, null, null],
        ['confirmed', 'open', null, null, null],
        ['clarified', 'open', null, null, null],
        ['approved', 'approved', null, null, null],
        ['in_progress', 'in_progress', 'build', null, null],
        ['developed', 'in_progress', 'test', 'developed', null],
        ['testing', 'in_progress', 'test', 'testing', null],
        ['tested', 'awaiting_release', null, 'tested', null],
        ['awaiting_release', 'awaiting_release', null, null, null],
        ['releasing', 'awaiting_release', 'release', 'releasing', null],
        ['reopen', 'reopen', null, null, null],
        ['waiting', 'needs_info', null, null, 'needs_resource'],
        ['needs_info', 'needs_info', null, null, 'needs_answer'],
        ['needs_info_kind', 'needs_info', null, null, 'needs_decision'],
        ['on_hold', 'on_hold', null, null, null],
        ['closed', 'closed', null, null, null],
        ['dropped', 'dropped', null, null, null],
      ];
      for (const [old, status, step, rung, kind] of expected) {
        const row = at(old);
        expect(
          [row.status, row.step ?? null, row.legacy_status ?? null, row.waiting_kind ?? null],
          old,
        ).toEqual([status, step, rung, kind]);
      }

      // The newest audited move in from a working status, mapped by the same table.
      expect(at('needs_info').left_status).toBe('in_progress');
      expect(at('on_hold').left_status).toBe('in_progress');
      expect(at('waiting').left_status).toBeNull();

      // The lease left the blob for the work state, and composes back for the plugin.
      const dev = at('developed');
      expect(dev.session_context).toEqual({
        worklog: { branch: 'ISS-1-x', head: HEAD },
        note: 'kept',
      });
      expect(dev.lease_holder).toBe('run-7');
      expect(dev.branch).toBe('ISS-1-x');
      expect(dev.head_sha).toBe(HEAD.toLowerCase());
      expect((dev.composed as { lease: { holder: string } }).lease.holder).toBe('run-7');

      // Each status the migration changed is audited under its own source, and woke nothing.
      const audited = (await sql.unsafe(`
        SELECT count(*)::int AS n FROM kernel_transitions WHERE source = 'migration'
      `)) as unknown as Array<{ n: number }>;
      expect(audited[0]?.n).toBe(7);
      const outbox = (await sql.unsafe(`
        SELECT count(*)::int AS n FROM pipeline_outbox WHERE reason = 'iss54-migration-0346'
      `)) as unknown as Array<{ n: number }>;
      expect(outbox[0]?.n).toBe(0);

      // The ten-status checks stand after it: a retired name is refused by the database.
      const refused = await errorOf(
        sql.unsafe(
          `INSERT INTO issues (project_id, title, created_by_id, status)
                    VALUES ($1, 'late', $2, 'developed')`,
          [g.projectId, g.ownerId],
        ),
      );
      expect(refused).toContain('issues_status_chk');
      const kindless = await errorOf(
        sql.unsafe(
          `INSERT INTO issues (project_id, title, created_by_id, status)
                    VALUES ($1, 'late', $2, 'needs_info')`,
          [g.projectId, g.ownerId],
        ),
      );
      expect(kindless).toContain('issues_waiting_kind_chk');
    } finally {
      await drop();
    }
  });

  it('maps a knowledge entry condition naming a retired status', async () => {
    const { sql, drop } = await fresh();
    try {
      const g = await ground(sql);
      const id = randomUUID();
      await sql.unsafe(
        `INSERT INTO knowledge_entries (id, project_id, kind, slug, title, body, injection,
                                        confidence, read_when)
         VALUES ($1, $2, $4, 'judge-notes', 'judge notes', 'body', 'on_demand', 'verified', $3::text::jsonb)`,
        [id, g.projectId, JSON.stringify({ statuses: ['developed', 'testing', 'open'] }), KIND],
      );
      await runForward(sql);
      const rows = (await sql.unsafe(`SELECT read_when FROM knowledge_entries WHERE id = $1`, [
        id,
      ])) as unknown as Array<{ read_when: { statuses: string[] } }>;
      expect([...(rows[0]?.read_when.statuses ?? [])].sort()).toEqual(['in_progress', 'open']);
    } finally {
      await drop();
    }
  });
});

describe('0346 aborts on a row its table cannot say, naming it', () => {
  it('a waiting park with no kind', async () => {
    const { sql, drop } = await fresh();
    try {
      const g = await ground(sql);
      const id = await plantIssue(sql, g, 'waiting');
      const err = await errorOf(runForward(sql));
      expect(err).toContain('ISS-54 migration 0346');
      expect(err).toContain(id);
      expect(err).toContain('no waiting_kind');
      const left = (await sql.unsafe(`SELECT status FROM issues WHERE id = $1`, [
        id,
      ])) as unknown as Array<{ status: string }>;
      expect(left[0]?.status).toBe('waiting');
    } finally {
      await drop();
    }
  });

  it('a status outside the seventeen', async () => {
    const { sql, drop } = await fresh();
    try {
      const g = await ground(sql);
      await sql.unsafe(`ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_chk`);
      const id = await plantIssue(sql, g, 'deploying');
      const err = await errorOf(runForward(sql));
      expect(err).toContain(`${id} at \`deploying\``);
      expect(err).toContain('no mapping for the status');
    } finally {
      await drop();
    }
  });

  it('a kind left on a row that is not a park', async () => {
    const { sql, drop } = await fresh();
    try {
      const g = await ground(sql);
      const id = await plantIssue(sql, g, 'open', { waitingKind: 'needs_decision' });
      const err = await errorOf(runForward(sql));
      expect(err).toContain(`${id} (needs_decision)`);
    } finally {
      await drop();
    }
  });
});
