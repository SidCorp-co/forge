// cm:why ISS-80 against a real Postgres: a recorded landing ends the lease and moves the issue where
// workflow issue-lifecycle puts landed work, through the merge mark both doors share.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestUser,
  seedProjectSource,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

let harness: TestDatabase;
let userId: string;
let projectId: string;
let seq = 80;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
}, 60_000);

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, userId)).id;
  await seedProjectSource(harness.db, projectId, userId, 'git');
});

function liveLease(holder: string) {
  return { holder, renewedAt: new Date().toISOString(), minutes: 60 };
}

async function seed(opts: {
  status: string;
  lease?: Record<string, unknown> | null;
  step?: string;
  archived?: boolean;
}) {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, archived_at)
    VALUES (${id}, ${projectId}, ${seq}, 'landed by hand', ${opts.status}, ${userId},
            ${opts.archived ? sql`now()` : sql`NULL`})
  `);
  const lease = opts.lease === undefined ? null : JSON.stringify(opts.lease);
  const step = opts.step ?? null;
  await harness.db.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease, step, step_started_at)
    VALUES (${id}, ${lease}::jsonb, ${step}, ${step ? sql`now()` : sql`NULL`})
  `);
  return { id, projectId, mergedAt: null as Date | null };
}

async function passEveryCriterion(issueId: string) {
  const [c] = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${issueId}, 1, 'the landing moves the issue', 1) RETURNING id
  `);
  await harness.db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha, author_user_id, author_agency)
    VALUES (${(c as { id: string }).id}, ${issueId}, 'pass', 'commit', ${SHA}, ${userId}, 'human')
  `);
}

async function mark(issue: { id: string; projectId: string; mergedAt: Date | null }) {
  const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');
  return applyMergeMarker({
    issue,
    op: 'mark',
    target: 'dev',
    commit: SHA,
    note: 'landed on dev outside a runner job',
    actor: {
      agency: 'human',
      commentAuthorId: userId,
      hookActor: { type: 'user', id: userId, agency: 'human' },
    },
  });
}

async function read(id: string) {
  const [r] = await harness.db.execute<{
    status: string;
    merged_at: unknown;
    step: string | null;
    legacy_status: string | null;
    lease: Record<string, unknown> | null;
  }>(sql`
    SELECT i.status, i.merged_at, w.step, w.legacy_status, w.lease
      FROM issues i LEFT JOIN issue_work_state w ON w.issue_id = i.id
     WHERE i.id = ${id}
  `);
  return r as {
    status: string;
    merged_at: unknown;
    step: string | null;
    legacy_status: string | null;
    lease: Record<string, unknown> | null;
  };
}

async function transitionsOf(id: string) {
  const rows = await harness.db.execute<{ from_status: string; to_status: string }>(sql`
    SELECT from_status, to_status FROM kernel_transitions
     WHERE entity = 'issue' AND entity_id = ${id} ORDER BY created_at ASC
  `);
  return [...rows].map((r) => `${r.from_status}->${r.to_status}`);
}

describe('ISS-80 — a recorded landing moves the issue on (real Postgres)', () => {
  it('ends the lease of an in_progress issue and leaves it at step test for its judge, as developed', async () => {
    const issue = await seed({
      status: 'in_progress',
      lease: liveLease('orchestrator-dev-iss-58'),
      step: 'build',
    });

    const { lifecycle, issue: after } = await mark(issue);

    expect(lifecycle).toMatchObject({
      outcome: 'judge_owed',
      status: 'in_progress',
      step: 'test',
      leaseEnded: 'orchestrator-dev-iss-58',
    });
    const row = await read(issue.id);
    expect(row.merged_at).not.toBeNull();
    expect(row.status).toBe('in_progress');
    expect(row.step).toBe('test');
    expect(row.legacy_status).toBe('developed');
    expect(row.lease?.stopped).toEqual(expect.any(String));
    expect(row.lease?.history).toEqual([
      expect.objectContaining({
        how: 'landed',
        holder: 'orchestrator-dev-iss-58',
        status: 'in_progress',
      }),
    ]);
    expect(after.workState?.leaseHolder).toBe('orchestrator-dev-iss-58');
    const { issueHolder } = await import('../../src/issues/work-state.js');
    expect(await issueHolder(harness.db as never, issue)).toBeNull();
  });

  it('moves an in_progress issue whose criteria all pass to awaiting_release, through the kernel', async () => {
    const issue = await seed({ status: 'in_progress', lease: liveLease('claude-dev-iss-59') });
    await passEveryCriterion(issue.id);

    const { lifecycle } = await mark(issue);

    expect(lifecycle).toMatchObject({
      outcome: 'awaiting_release',
      status: 'awaiting_release',
      leaseEnded: 'claude-dev-iss-59',
    });
    expect((await read(issue.id)).status).toBe('awaiting_release');
    expect(await transitionsOf(issue.id)).toEqual(['in_progress->awaiting_release']);
  });

  it('never closes: a landed issue with passing verdicts stops at awaiting_release', async () => {
    const issue = await seed({ status: 'in_progress' });
    await passEveryCriterion(issue.id);

    await mark(issue);

    expect((await read(issue.id)).status).not.toBe('closed');
    expect(await transitionsOf(issue.id)).not.toContain('in_progress->closed');
  });

  it('leaves an open issue at open, ends its claim, and says why', async () => {
    const issue = await seed({ status: 'open', lease: liveLease('orchestrator:dev-content-lang') });

    const { lifecycle } = await mark(issue);

    expect(lifecycle).toMatchObject({
      outcome: 'unmoved',
      status: 'open',
      leaseEnded: 'orchestrator:dev-content-lang',
    });
    expect(lifecycle?.detail).toContain('NO_HOLDER');
    expect((await read(issue.id)).status).toBe('open');
    expect(await transitionsOf(issue.id)).toEqual([]);
  });

  it('leaves the issue and its lease to a run in flight on it', async () => {
    const issue = await seed({
      status: 'in_progress',
      lease: liveLease('drive-run'),
      step: 'build',
    });
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${randomUUID()}, ${projectId}, ${issue.id}, 'issue', 'running', now())
    `);

    const { lifecycle } = await mark(issue);

    expect(lifecycle).toMatchObject({
      outcome: 'left_to_run',
      status: 'in_progress',
      leaseEnded: null,
    });
    const row = await read(issue.id);
    expect(row.step).toBe('build');
    expect(row.lease?.stopped).toBeUndefined();
  });

  it.each([
    ['at step test', false, 'build'],
    ['to awaiting_release', true, 'build'],
  ])(
    'leaves the issue to a run that takes it after the lease ended, before the move %s',
    async (_move, passing, step) => {
      await harness.db.execute(sql`
      CREATE OR REPLACE FUNCTION iss80_run_arrives() RETURNS trigger AS $$
      BEGIN
        IF NEW.lease ? 'stopped' AND NOT (coalesce(OLD.lease, '{}'::jsonb) ? 'stopped') THEN
          INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
          SELECT gen_random_uuid(), i.project_id, i.id, 'issue', 'running', now()
            FROM issues i WHERE i.id = NEW.issue_id;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
      await harness.db.execute(sql`
      CREATE TRIGGER iss80_run_arrives AFTER UPDATE ON issue_work_state
        FOR EACH ROW EXECUTE FUNCTION iss80_run_arrives()
    `);
      try {
        const issue = await seed({
          status: 'in_progress',
          lease: liveLease('orchestrator-dev-iss-58'),
          step,
        });
        if (passing) await passEveryCriterion(issue.id);

        const { lifecycle } = await mark(issue);

        expect(lifecycle).toMatchObject({
          outcome: 'left_to_run',
          status: 'in_progress',
          leaseEnded: 'orchestrator-dev-iss-58',
        });
        const row = await read(issue.id);
        expect(row.status).toBe('in_progress');
        expect(row.step).toBe(step);
        expect(row.legacy_status).toBeNull();
        expect(await transitionsOf(issue.id)).toEqual([]);
      } finally {
        await harness.db.execute(sql`DROP TRIGGER IF EXISTS iss80_run_arrives ON issue_work_state`);
        await harness.db.execute(sql`DROP FUNCTION IF EXISTS iss80_run_arrives()`);
      }
    },
  );

  it('reports a refused move by its code rather than absorbing it: an archived issue stays where it was', async () => {
    const issue = await seed({ status: 'in_progress', step: 'build', archived: true });
    await passEveryCriterion(issue.id);

    const { lifecycle } = await mark(issue);

    expect(lifecycle).toMatchObject({ outcome: 'unmoved', status: 'in_progress' });
    expect(lifecycle?.outcome === 'unmoved' ? lifecycle.refusal?.code : null).toBe(
      'ISSUE_ARCHIVED',
    );
    expect((await read(issue.id)).step).toBe('build');
  });

  it('writes what it did into the audit comment the mark leaves', async () => {
    const issue = await seed({
      status: 'in_progress',
      lease: liveLease('orchestrator-dev-iss-58'),
    });

    await mark(issue);

    const rows = await harness.db.execute<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issue.id}`,
    );
    const body = [...rows].map((r) => r.body).join('\n');
    expect(body).toContain('step `test`');
    expect(body).toContain('The lease held by orchestrator-dev-iss-58 was ended by the landing.');
  });

  it('is idempotent: a second mark on a landed, judged-owed issue writes no second lease stamp', async () => {
    const issue = await seed({
      status: 'in_progress',
      lease: liveLease('orchestrator-dev-iss-58'),
    });
    await mark(issue);

    const again = await mark(issue);

    expect(again.action).toBe('already_merged');
    expect(again.lifecycle).toMatchObject({ outcome: 'judge_owed', leaseEnded: null });
    expect((await read(issue.id)).lease?.history).toHaveLength(1);
  });
});
