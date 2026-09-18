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

// cm:why a fresh PROJECT per case rather than a truncate: every row this file writes is keyed on
// one project, so a new project is full isolation, and `truncateAll` over ~300 tables costs 46s
// per case on a cold database — which is a hook timeout rather than a test.
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
    expect(outcome.opened?.tagState).toBe('absent');
    expect(outcome.opened?.publication).toBe('unread');
    expect(outcome.opened?.settledAt).toBeNull();
    expect(outcome.opened?.readings).toEqual([]);
  });

  // cm:guard criterion 24. A preflight that refused wrote nothing to the repository, so the same
  // version must be runnable again — and the re-arm has to CLEAR the previous attempt's verdict,
  // or the second run inherits the first one's failure sentence.
  it('re-arms a row whose tag never reached the repository', async () => {
    const first = await open();
    await store.appendReading(String(first.opened?.id), 'check_crate_version: refused');
    await store.settleFailed(String(first.opened?.id), {
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

  // cm:guard criterion 22, and the reason it is a statement and not a branch: two callers that
  // both read `absent` and then both insert would both cut. The `WHERE` is what makes the second
  // one lose inside Postgres.
  it('refuses a second attempt once the tag exists', async () => {
    const first = await open();
    await store.advance(String(first.opened?.id), { tagState: 'present', status: 'building' });

    const second = await open();
    expect(second.opened).toBeNull();
    expect(second.held?.tagState).toBe('present');
    expect(second.held?.id).toBe(first.opened?.id);
  });

  it('refuses a second attempt while the tag is of unknown existence', async () => {
    const first = await open();
    await store.advance(String(first.opened?.id), { tagState: 'unknown', status: 'cutting' });
    const second = await open();
    expect(second.opened).toBeNull();
    expect(second.held?.tagState).toBe('unknown');
  });

  it('keeps one row per tag and separates two tags', async () => {
    await open();
    await open('runner-v0.13.4');
    const rows = await store.listForProject(projectId);
    expect(rows.map((r) => r.tag).sort()).toEqual(['runner-v0.13.3', 'runner-v0.13.4']);
  });
});

describe('runner_releases — settling one, exactly once', () => {
  // cm:guard criterion 14 — the SAME completed delivery arriving twice. The second settle answers
  // `false` and changes nothing, which is why the caller reports 0 rows moved rather than 1.
  it('lets the first settle win and the second write nothing', async () => {
    const opened = (await open()).opened;
    const id = String(opened?.id);
    await store.advance(id, { tagState: 'present', status: 'building', step: 'await_build' });

    const first = await store.settlePublished(id, {
      publicationDetail: 'GitHub holds a published release carrying both assets.',
      buildConclusion: 'success',
      workflowRunId: '111',
      workflowUrl: 'https://github.com/o/r/actions/runs/111',
      releaseUrl: 'https://github.com/o/r/releases/tag/runner-v0.13.3',
      buildReportedAt: new Date(),
    });
    const second = await store.settlePublished(id, {
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
    await store.advance(id, { tagState: 'present', status: 'building', step: 'await_build' });
    expect(
      await store.settleFailed(id, {
        step: 'await_build',
        failure: 'the build concluded failure',
        tagState: 'present',
        publication: 'absent',
      }),
    ).toBe(true);
    expect(
      await store.settleFailed(id, { step: 'confirm_release', failure: 'a second verdict' }),
    ).toBe(false);
    const row = await store.findById(id);
    expect(row?.failure).toBe('the build concluded failure');
    expect(row?.step).toBe('await_build');
  });

  // cm:guard `advance` is conditional for the same reason the settles are: the deadline pass can
  // name a release between two steps of a sequence still running, and that sequence must not then
  // move a row somebody already closed.
  it('refuses an advance over a settled row', async () => {
    const id = String((await open()).opened?.id);
    await store.settleFailed(id, { step: 'resolve_commit', failure: 'stopped' });
    expect(await store.advance(id, { status: 'building', step: 'await_build' })).toBe(false);
    expect((await store.findById(id))?.status).toBe('failed');
  });
});

// cm:guard postgres-js puts the constraint's name on the ERROR rather than in its message, so an
// assertion on `toThrow(/name/)` passes for any failed query at all — including a typo in the SQL
// under test. Every case below therefore reads `constraint_name`.
async function violates(name: string, run: Promise<unknown>) {
  const err = (await run.then(() => null).catch((e) => e)) as
    | (Error & { constraint_name?: string; cause?: { constraint_name?: string } })
    | null;
  expect(err).not.toBeNull();
  expect(err?.constraint_name ?? err?.cause?.constraint_name).toBe(name);
}

describe('runner_releases — what the database itself refuses', () => {
  // cm:guard `runner_releases_published_chk`. This is the last line of defence for
  // `VISION: state-never-lies`: a caller that writes `published` over a tag nothing confirmed is
  // refused by Postgres rather than by a code path somebody can forget to call.
  it('refuses `published` over a tag of unknown existence', async () => {
    const id = String((await open()).opened?.id);
    await store.advance(id, { tagState: 'unknown' });
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
    await store.advance(id, { tagState: 'present' });
    await violates(
      'runner_releases_published_chk',
      harness.db.execute(sql`
        UPDATE runner_releases SET status = 'published', settled_at = now() WHERE id = ${id}
      `),
    );
  });

  // cm:guard `runner_releases_settled_chk`. A terminal row with no clock is a release nobody can
  // date, and an in-flight row carrying one is a release the deadline pass will never reach.
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
    await store.advance(id, { commitSha: 'abc1234', step: 'await_build', status: 'building' });
    expect((await store.inFlightAtCommit(bindingId, 'abc1234')).map((r) => r.id)).toEqual([id]);
    await store.settleFailed(id, { step: 'await_build', failure: 'stopped' });
    expect(await store.inFlightAtCommit(bindingId, 'abc1234')).toEqual([]);
  });

  // cm:guard the deadline pass's own selection, and `settled_at IS NULL` in it is why a release
  // already named is never named twice.
  it('offers the deadline pass every unsettled row past its clock, and no settled one', async () => {
    const overdue = String((await open()).opened?.id);
    await harness.db.execute(sql`
      UPDATE runner_releases SET deadline_at = now() - interval '5 minutes' WHERE id = ${overdue}
    `);
    const fresh = String((await open('runner-v0.13.4')).opened?.id);

    expect((await store.overdueReleases(new Date())).map((r) => r.id)).toEqual([overdue]);
    await store.settleFailed(overdue, { step: 'await_build', failure: 'named' });
    expect(await store.overdueReleases(new Date())).toEqual([]);
    expect(fresh).not.toBe(overdue);
  });

  it('appends one reading per step, in order', async () => {
    const id = String((await open()).opened?.id);
    await store.appendReading(id, 'resolve_commit: abc1234');
    await store.appendReading(id, 'check_tag_absent: none');
    expect((await store.findById(id))?.readings).toEqual([
      'resolve_commit: abc1234',
      'check_tag_absent: none',
    ]);
  });
});
