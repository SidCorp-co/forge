import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

/**
 * ISS-1075 — `runner_releases` against real Postgres.
 *
 * Every rule this file tests is a SQL statement rather than a branch, so a
 * mocked db proves none of them:
 *
 * - the re-arm's `WHERE runner_releases.tag_state = 'absent'`, which is the
 *   whole of "a failed preflight may run again, a cut tag may not";
 * - the `settled_at IS NULL` on both settles, which is what makes a
 *   re-delivered `workflow_run` write nothing;
 * - `runner_releases_published_chk` and `runner_releases_settled_chk`, which
 *   are the database refusing a row that says it published over a tag nothing
 *   confirmed.
 *
 * Read the whole set as one claim: the row cannot be made to lie about the
 * repository, whichever caller tries and in whichever order two of them arrive.
 */
let harness: TestDatabase;
let store: typeof import('../../src/integrations/github/runner-release-store.js');
let projectId: string;
let bindingId: string;

const TAG = 'runner-v0.13.3';
const deadline = (minutes: number) => new Date(Date.now() + minutes * 60_000);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  store = await import('../../src/integrations/github/runner-release-store.js');
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  const user = await createTestUser(harness.db, { email: `rel-${Date.now()}@test.forge.local` });
  const project = await createTestProject(harness.db, user.id);
  projectId = project.id;
  const [connection] = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (owner_type, owner_id, provider)
    VALUES ('user', ${user.id}, 'github') RETURNING id
  `);
  const [binding] = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages)
    VALUES (${connection?.id}, ${projectId}, 'github', 'service', '{}'::text[]) RETURNING id
  `);
  bindingId = String(binding?.id);
});

const open = (tag = TAG) =>
  store.openRunnerRelease({
    projectId,
    bindingId,
    repository: 'SidCorp-co/forge',
    version: tag.replace('runner-v', ''),
    tag,
    requestedById: null,
    deadlineAt: deadline(90),
  });

describe('runner_releases — opening one', () => {
  it('opens at preflight with nothing yet true on the repository', async () => {
    const outcome = await open();
    expect(outcome.opened).not.toBeNull();
    expect(outcome.opened?.status).toBe('preflight');
    expect(outcome.opened?.step).toBe('resolve_repository');
    expect(outcome.opened?.tagState).toBe('unread');
    expect(outcome.opened?.publication).toBe('unread');
    expect(outcome.opened?.settledAt).toBeNull();
    expect(outcome.opened?.readings).toEqual([]);
  });

  it('re-arms a row whose tag never reached the repository', async () => {
    const first = await open();
    await store.appendReading(String(first.opened?.id), 1, 'check_crate_version: refused');
    await store.settleFailed(String(first.opened?.id), 1, {
      step: 'check_crate_version',
      failure: 'Cargo.toml declares 0.13.2',
      tagState: 'absent',
    });

    const second = await open();
    expect(second.opened?.id).toBe(first.opened?.id);
    expect(second.opened?.status).toBe('preflight');
    expect(second.opened?.failure).toBeNull();
    expect(second.opened?.settledAt).toBeNull();
    expect(second.opened?.readings).toEqual([]);
  });

  it('refuses a second start while the first is still running', async () => {
    const first = await open();
    await store.advance(String(first.opened?.id), 1, { step: 'check_tag_absent' });

    const second = await open();
    expect(second.opened).toBeNull();
    expect(second.held?.id).toBe(first.opened?.id);
    expect(second.held?.step).toBe('check_tag_absent');
    expect(second.held?.settledAt).toBeNull();
  });

  it('refuses a second attempt once the tag exists', async () => {
    const first = await open();
    await store.advance(String(first.opened?.id), 1, { tagState: 'present', status: 'building' });

    const second = await open();
    expect(second.opened).toBeNull();
    expect(second.held?.tagState).toBe('present');
    expect(second.held?.id).toBe(first.opened?.id);
  });

  it('refuses a second attempt while the tag is of unknown existence', async () => {
    const first = await open();
    await store.settleFailed(String(first.opened?.id), 1, {
      step: 'cut_tag',
      failure: 'Forge never heard the answer',
      tagState: 'unknown',
    });
    const second = await open();
    expect(second.opened).toBeNull();
    expect(second.held?.tagState).toBe('unknown');
  });

  it('re-arms a settled row whose tag was never read', async () => {
    const first = await open();
    await store.settleFailed(String(first.opened?.id), 1, {
      step: 'resolve_commit',
      failure: 'GitHub answered 403 reading the commit',
      tagState: 'unread',
    });
    const second = await open();
    expect(second.opened?.id).toBe(first.opened?.id);
    expect(second.opened?.tagState).toBe('unread');
    expect(second.opened?.settledAt).toBeNull();
  });

  it('keeps one row per tag and separates two tags', async () => {
    await open();
    await open('runner-v0.13.4');
    const rows = await store.listForProject(projectId);
    expect(rows.map((r) => r.tag).sort()).toEqual(['runner-v0.13.3', 'runner-v0.13.4']);
  });
});

describe('runner_releases — settling one, exactly once', () => {
  it('lets the first settle win and the second write nothing', async () => {
    const opened = (await open()).opened;
    const id = String(opened?.id);
    await store.advance(id, 1, { tagState: 'present', status: 'building', step: 'await_build' });

    const first = await store.settlePublished(id, 1, {
      publicationDetail: 'GitHub holds a published release carrying both assets.',
      buildConclusion: 'success',
      workflowRunId: '111',
      workflowUrl: 'https://github.com/o/r/actions/runs/111',
      releaseUrl: 'https://github.com/o/r/releases/tag/runner-v0.13.3',
      buildReportedAt: new Date(),
    });
    const second = await store.settlePublished(id, 1, {
      publicationDetail: 'a second delivery',
      buildConclusion: 'success',
      workflowRunId: '222',
      workflowUrl: null,
      releaseUrl: null,
      buildReportedAt: new Date(),
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    const row = await store.findById(id);
    expect(row?.workflowRunId).toBe('111');
    expect(row?.status).toBe('published');
    expect(row?.publicationDetail).toContain('both assets');
  });

  it('lets a failure settle once and refuses a later one over it', async () => {
    const id = String((await open()).opened?.id);
    await store.advance(id, 1, { tagState: 'present', status: 'building', step: 'await_build' });
    expect(
      await store.settleFailed(id, 1, {
        step: 'await_build',
        failure: 'the build concluded failure',
        tagState: 'present',
        publication: 'absent',
      }),
    ).toBe(true);
    expect(
      await store.settleFailed(id, 1, { step: 'confirm_release', failure: 'a second verdict' }),
    ).toBe(false);
    const row = await store.findById(id);
    expect(row?.failure).toBe('the build concluded failure');
    expect(row?.step).toBe('await_build');
  });

  it('refuses an advance over a settled row', async () => {
    const id = String((await open()).opened?.id);
    await store.settleFailed(id, 1, { step: 'resolve_commit', failure: 'stopped' });
    expect(await store.advance(id, 1, { status: 'building', step: 'await_build' })).toBe(false);
    expect((await store.findById(id))?.status).toBe('failed');
  });
});

async function violates(name: string, run: Promise<unknown>) {
  const err = (await run.then(() => null).catch((e) => e)) as
    | (Error & { constraint_name?: string; cause?: { constraint_name?: string } })
    | null;
  expect(err).not.toBeNull();
  expect(err?.constraint_name ?? err?.cause?.constraint_name).toBe(name);
}

describe('runner_releases — what the database itself refuses', () => {
  it('refuses `published` over a tag of unknown existence', async () => {
    const id = String((await open()).opened?.id);
    await store.advance(id, 1, { tagState: 'unknown' });
    await violates(
      'runner_releases_published_chk',
      harness.db.execute(sql`
        UPDATE runner_releases
           SET status = 'published', publication = 'published', settled_at = now()
         WHERE id = ${id}
      `),
    );
  });

  it('refuses `published` over a release nobody read', async () => {
    const id = String((await open()).opened?.id);
    await store.advance(id, 1, { tagState: 'present' });
    await violates(
      'runner_releases_published_chk',
      harness.db.execute(sql`
        UPDATE runner_releases SET status = 'published', settled_at = now() WHERE id = ${id}
      `),
    );
  });

  it('refuses a terminal row with no settled_at, and an in-flight row with one', async () => {
    const id = String((await open()).opened?.id);
    await violates(
      'runner_releases_settled_chk',
      harness.db.execute(sql`UPDATE runner_releases SET status = 'failed' WHERE id = ${id}`),
    );
    await violates(
      'runner_releases_settled_chk',
      harness.db.execute(sql`UPDATE runner_releases SET settled_at = now() WHERE id = ${id}`),
    );
  });

  it('refuses a tag state and a status it has no vocabulary for', async () => {
    const id = String((await open()).opened?.id);
    await violates(
      'runner_releases_tag_state_chk',
      harness.db.execute(sql`UPDATE runner_releases SET tag_state = 'maybe' WHERE id = ${id}`),
    );
    await violates(
      'runner_releases_status_chk',
      harness.db.execute(sql`UPDATE runner_releases SET status = 'cut' WHERE id = ${id}`),
    );
  });
});

describe('runner_releases — the reads the rest of the path makes', () => {
  it('finds a release by the binding and tag a delivery names', async () => {
    const opened = (await open()).opened;
    expect((await store.findByBindingAndTag(bindingId, TAG))?.id).toBe(opened?.id);
    expect(await store.findByBindingAndTag(bindingId, 'runner-v9.9.9')).toBeNull();
  });

  it('finds only the releases still in flight at a commit', async () => {
    const id = String((await open()).opened?.id);
    await store.advance(id, 1, { commitSha: 'abc1234', step: 'await_build', status: 'building' });
    expect((await store.inFlightAtCommit(bindingId, 'abc1234')).map((r) => r.id)).toEqual([id]);
    await store.settleFailed(id, 1, { step: 'await_build', failure: 'stopped' });
    expect(await store.inFlightAtCommit(bindingId, 'abc1234')).toEqual([]);
  });

  it('offers the deadline pass every unsettled row past its clock, and no settled one', async () => {
    const overdue = String((await open()).opened?.id);
    await harness.db.execute(sql`
      UPDATE runner_releases SET deadline_at = now() - interval '5 minutes' WHERE id = ${overdue}
    `);
    const fresh = String((await open('runner-v0.13.4')).opened?.id);

    expect((await store.overdueReleases(new Date())).map((r) => r.id)).toEqual([overdue]);
    await store.settleFailed(overdue, 1, { step: 'await_build', failure: 'named' });
    expect(await store.overdueReleases(new Date())).toEqual([]);
    expect(fresh).not.toBe(overdue);
  });

  it('appends one reading per step, in order', async () => {
    const id = String((await open()).opened?.id);
    await store.appendReading(id, 1, 'resolve_commit: abc1234');
    await store.appendReading(id, 1, 'check_tag_absent: none');
    expect((await store.findById(id))?.readings).toEqual([
      'resolve_commit: abc1234',
      'check_tag_absent: none',
    ]);
  });
});

describe('runner_releases — settling under the reading it was selected on', () => {
  it('refuses a settle whose reading the row has already left', async () => {
    const id = String((await open()).opened?.id);
    await store.advance(id, 1, { step: 'cut_tag', status: 'cutting', tagState: 'unknown' });

    const stale = await store.settleFailed(id, 1, {
      step: 'resolve_commit',
      failure: 'the deadline read this row two steps ago',
      ifUnchanged: { step: 'resolve_commit', tagState: 'unread' },
    });
    expect(stale).toBe(false);
    const still = await store.findById(id);
    expect(still?.settledAt).toBeNull();
    expect(still?.step).toBe('cut_tag');
    expect(still?.tagState).toBe('unknown');

    const current = await store.settleFailed(id, 1, {
      step: 'cut_tag',
      failure: 'Forge never heard the answer',
      ifUnchanged: { step: 'cut_tag', tagState: 'unknown' },
    });
    expect(current).toBe(true);
    expect((await store.findById(id))?.tagState).toBe('unknown');
  });
});

describe('runner_releases — the commit the tag was read at', () => {
  it('keeps the observed target apart from the requested one', async () => {
    const id = String((await open()).opened?.id);
    await store.advance(id, 1, { commitSha: 'abc1234' });
    await store.settleFailed(id, 1, {
      step: 'check_tag_absent',
      failure: 'already exists, pointing at olderco',
      tagState: 'present',
      tagCommitSha: 'olderco',
    });
    const row = await store.findById(id);
    expect(row?.commitSha).toBe('abc1234');
    expect(row?.tagCommitSha).toBe('olderco');
  });

  it('leaves the observed target unread where nobody read it', async () => {
    const id = String((await open()).opened?.id);
    await store.advance(id, 1, { commitSha: 'abc1234' });
    await store.settleFailed(id, 1, {
      step: 'cut_tag',
      failure: 'GitHub says the ref is already there',
      tagState: 'present',
    });
    expect((await store.findById(id))?.tagCommitSha).toBeNull();
  });

  it('clears it on the re-arm, with the rest of the previous attempt', async () => {
    const id = String((await open()).opened?.id);
    await store.settleFailed(id, 1, {
      step: 'resolve_commit',
      failure: 'read refused',
      tagState: 'unread',
      tagCommitSha: 'olderco',
    });
    const second = await open();
    expect(second.opened?.tagCommitSha).toBeNull();
  });
});

describe('runner_releases — the attempt a write was issued for', () => {
  it('refuses every write from the attempt a re-arm replaced', async () => {
    const first = await open();
    const id = String(first.opened?.id);
    expect(first.opened?.attempt).toBe(1);
    await store.settleFailed(id, 1, {
      step: 'check_crate_version',
      failure: 'Cargo.toml declares 0.13.2',
      tagState: 'absent',
    });

    const second = await open();
    expect(second.opened?.id).toBe(id);
    expect(second.opened?.attempt).toBe(2);

    expect(await store.advance(id, 1, { step: 'cut_tag', tagState: 'unknown' })).toBe(false);
    expect(
      await store.settleFailed(id, 1, { step: 'cut_tag', failure: 'a superseded caller' }),
    ).toBe(false);
    await store.appendReading(id, 1, 'cut_tag: a superseded caller');

    const now = await store.findById(id);
    expect(now?.attempt).toBe(2);
    expect(now?.step).toBe('resolve_repository');
    expect(now?.settledAt).toBeNull();
    expect(now?.readings).toEqual([]);

    expect(await store.advance(id, 2, { step: 'cut_tag', tagState: 'unknown' })).toBe(true);
  });

  it('refuses a deadline settle from a sweep that selected the replaced attempt', async () => {
    const id = String((await open()).opened?.id);
    await store.settleFailed(id, 1, {
      step: 'resolve_commit',
      failure: 'read refused',
      tagState: 'unread',
    });
    await open();

    // The sweep is holding attempt 1's reading, and attempt 2 happens to be at the same pair.
    const stale = await store.settleFailed(id, 1, {
      step: 'resolve_repository',
      failure: 'the deadline named a release that is running again',
      ifUnchanged: { step: 'resolve_repository', tagState: 'unread' },
    });
    expect(stale).toBe(false);
    expect((await store.findById(id))?.settledAt).toBeNull();
  });
});
