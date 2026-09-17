import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * ISS-1069 — migration 0264 runs against the real table, on every shape a row can hold.
 *
 * The migration is the half of this change that cannot be rolled back by reverting a commit, and
 * its rules are all about values the TypeScript side never sees: a column holding SQL null, a
 * column holding the JSON literal `null`, a value that is not an object at all, keys present but
 * empty, and a key the file does not recognise. A unit test over `normalizeEnvironments` covers
 * none of them, because the question here is what Postgres wrote — so this suite replays the
 * actual `.sql` file against the actual `projects` table.
 *
 * It does that by putting the column BACK under its old name first. The harness database is already
 * migrated, so 0264 has run; renaming `environments` to `preview_deploy` reconstructs the exact
 * pre-migration state the file is written against. That is also what makes the abort cases
 * meaningful: an aborted run must leave the old name in place with every row unwritten, which is a
 * claim about the column's NAME and not only its contents.
 */
// cm:guard module scope and not one long `describe`, because the setup below is shared by three
// subjects — the forward rewrite, the abort, and the rollback — and nesting them under a fourth
// `describe` put its callback past the function line budget.
let harness: TestDatabase;
let forward: string[];
let down: string;
let ownerId: string;
let orgId: string;

async function statements(path: string): Promise<string[]> {
  const text = await readFile(new URL(path, import.meta.url), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Put the column back under its pre-0264 name, so the file can be replayed against it.
 *
 * Idempotent, because an ABORT case leaves the column already under the old name and the next
 * test would otherwise fail on the rename rather than on its own subject.
 */
async function rewind(): Promise<void> {
  await harness.db.execute(sql`
    DO $rewind$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'projects' AND column_name = 'environments'
      ) THEN
        ALTER TABLE projects RENAME COLUMN environments TO preview_deploy;
      END IF;
    END $rewind$;
  `);
}

async function runForward(): Promise<void> {
  for (const statement of forward) await harness.db.execute(sql.raw(statement));
}

/**
 * The whole error chain as text, or `null` where the migration succeeded.
 *
 * cm:guard the CAUSE and not the message. Drizzle wraps a failed statement as `Failed query:
 * <the sql>` and hangs the Postgres error off `.cause`, so an assertion reading only the top
 * message matches the migration's own source text — including every slug-shaped word in it — and
 * would go green against a migration that aborted for an entirely different reason, or that named
 * no project at all.
 */
async function forwardError(): Promise<string | null> {
  try {
    await runForward();
    return null;
  } catch (err) {
    const parts: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) parts.push(e.message);
    return parts.slice(1).join('\n') || parts.join('\n');
  }
}

async function seed(slug: string, value: unknown): Promise<string> {
  const project = await createTestProject(harness.db, ownerId, { orgId, slug });
  // The column is under its OLD name by the time this runs, so the write is raw rather than
  // through drizzle's `projects` table, whose model names the new one.
  await harness.db.execute(
    value === undefined
      ? sql`UPDATE projects SET preview_deploy = NULL WHERE id = ${project.id}`
      : sql`UPDATE projects SET preview_deploy = ${JSON.stringify(value)}::jsonb WHERE id = ${project.id}`,
  );
  return project.id;
}

async function read(id: string, column: 'environments' | 'preview_deploy'): Promise<unknown> {
  const rows = (await harness.db.execute(
    column === 'environments'
      ? sql`SELECT environments AS v FROM projects WHERE id = ${id}`
      : sql`SELECT preview_deploy AS v FROM projects WHERE id = ${id}`,
  )) as unknown as { v: unknown }[];
  return rows[0]?.v;
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  forward = await statements('../../drizzle/migrations/0264_environments.sql');
  // cm:guard the down file is ONE statement block — it carries its own BEGIN/COMMIT and no
  // `--> statement-breakpoint`, because nothing in the migrator ever reads it. A split that
  // produced more than one piece means the file grew a breakpoint it must not have.
  const downParts = await statements('../../drizzle/rollback/0264_down.sql');
  expect(downParts).toHaveLength(1);
  down = downParts[0] as string;
}, 120_000);

afterAll(async () => {
  await harness.cleanup();
});

// cm:guard the rename happens BEFORE any row is seeded, because `seed` writes the OLD column
// name — that is the whole point of the rewind. Doing it per test rather than once is what keeps
// an abort case, which leaves the column un-renamed, from poisoning the next test.
beforeEach(async () => {
  await truncateAll(harness.db);
  await rewind();
  const owner = await createTestUser(harness.db, { email: `owner-${randomUUID()}@example.com` });
  ownerId = owner.id;
  orgId = (await seedOrg(harness.db, ownerId)).id;
});

describe('every row moves, and nothing is dropped', () => {
  it('moves the four renamed keys and leaves testCredentials where it is', async () => {
    const id = await seed('p-full', {
      stagingUrl: 'https://stg.example.com',
      stagingApiUrl: 'https://api.stg.example.com',
      testingUrls: [{ label: 'Beta', url: 'https://beta.example.com' }],
      notes: 'the QA account reaches no other project',
      testCredentials: [{ label: 'Admin', username: 'bot@x', password: 'keep-me' }],
    });

    await runForward();

    expect(await read(id, 'environments')).toEqual({
      preview: {
        url: 'https://stg.example.com',
        apiUrl: 'https://api.stg.example.com',
        urls: [{ label: 'Beta', url: 'https://beta.example.com' }],
      },
      live: { url: null, apiUrl: null, commitUrl: null, commitPath: null },
      limits: 'the QA account reaches no other project',
      testCredentials: [{ label: 'Admin', username: 'bot@x', password: 'keep-me' }],
    });
  });

  // cm:guard the catchall's half of the contract, in the database rather than in zod: the schema
  // passes unknown keys through so a client one version ahead is not truncated by this one, and a
  // migration that dropped them would make that promise false the moment it ran.
  it('carries a key it does not recognise through unchanged', async () => {
    const id = await seed('p-unknown', {
      stagingUrl: 'https://stg.example.com',
      futureKnob: { nested: ['a', 1, null] },
    });

    await runForward();

    const out = (await read(id, 'environments')) as Record<string, unknown>;
    expect(out.futureKnob).toEqual({ nested: ['a', 1, null] });
  });

  // cm:guard ABSENT, JSON null and empty are ONE answer — this project has no preview side — and
  // the migration writes that answer once so three readers do not each derive it. Each case below
  // is a different stored byte sequence, and a migration that handled only the first would leave
  // the other two reading as a half-filled preview.
  it.each([
    ['the three keys absent', { testCredentials: [] }],
    ['the three keys JSON null', { stagingUrl: null, stagingApiUrl: null, testingUrls: null }],
    ['an empty testingUrls list', { testingUrls: [] }],
    ['an empty object', {}],
  ])('writes preview: null for a row with %s', async (label, value) => {
    const id = await seed(`p-empty-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}`, value);

    await runForward();

    const out = (await read(id, 'environments')) as Record<string, unknown>;
    expect(out.preview).toBeNull();
    expect(out.live).toEqual({ url: null, apiUrl: null, commitUrl: null, commitPath: null });
    expect(out.limits).toBeNull();
  });

  it('writes a preview for a row that declares only testing URLs', async () => {
    const id = await seed('p-urls-only', {
      testingUrls: [{ label: 'Beta', url: 'https://beta.example.com' }],
    });

    await runForward();

    const out = (await read(id, 'environments')) as Record<string, unknown>;
    expect(out.preview).toEqual({
      url: null,
      apiUrl: null,
      urls: [{ label: 'Beta', url: 'https://beta.example.com' }],
    });
  });

  // cm:guard a SQL null and a JSON null both say "nothing is declared" and are left EXACTLY as
  // they are. Writing the new shape over them would turn 28 untouched projects into 28 rows
  // carrying a live object nobody filled, which reads as a declaration.
  it('leaves a SQL null exactly as it is', async () => {
    const id = await seed('p-sql-null', undefined);

    await runForward();

    expect(await read(id, 'environments')).toBeNull();
  });

  it('leaves a JSON null exactly as it is', async () => {
    const id = await seed('p-json-null', null);

    await runForward();

    expect(await read(id, 'environments')).toBeNull();
  });
});

/**
 * A row the new shape cannot represent ABORTS, by name.
 *
 * The alternative — cleaning the row away so the `ALTER` succeeds — is the silent substitution
 * this repository refuses everywhere: the operator's value is gone and nobody is told. So each
 * case asserts three things: it throws, the message names the project's SLUG, and the column is
 * still there under its old name with the row unwritten.
 */
describe('a row the new shape cannot hold aborts by name, writing nothing', () => {
  it.each([
    ['a stored value that is not an object', '"just a string"'],
    ['a stagingUrl holding an object', { stagingUrl: { href: 'https://x' } }],
    ['a notes holding a number', { notes: 7 }],
    ['a testingUrls holding an object', { testingUrls: { a: 1 } }],
    ['a testCredentials holding a string', { testCredentials: 'admin' }],
    ['a row that already carries a preview key', { preview: { url: 'https://x' } }],
    ['a row that already carries a live key', { live: { url: 'https://x' } }],
    ['a row that already carries a limits key', { limits: 'already here' }],
  ])('refuses %s', async (label, value) => {
    const slug = `offender-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
    const id = await seed(slug, typeof value === 'string' ? JSON.parse(value) : value);

    expect(await forwardError()).toContain(slug);

    // cm:guard the column is still under its OLD name and the row is still the operator's own
    // value. An abort that had already renamed the column would leave a database the previous
    // image cannot serve and the new one cannot finish migrating.
    expect(await read(id, 'preview_deploy')).toEqual(
      typeof value === 'string' ? JSON.parse(value) : value,
    );
  });

  // cm:guard EVERY offender at once, so an operator fixes them in one pass rather than one
  // redeploy each. A migration naming only the first found turns a five-row problem into five
  // deploy cycles.
  it('names every offending project in one message', async () => {
    await seed('offender-alpha', { notes: 7 });
    await seed('offender-beta', { stagingUrl: [] });
    await seed('innocent-gamma', { stagingUrl: 'https://stg.example.com' });

    const err = await forwardError();

    expect(err).toContain('offender-alpha');
    expect(err).toContain('offender-beta');
    expect(err).not.toContain('innocent-gamma');
  });
});

/**
 * The way back, and the one thing it cannot restore.
 *
 * `rollback/0264_down.sql` is applied BY HAND before the previous image starts, so nothing in CI
 * would otherwise execute a line of it — and a rollback file that has never run is a plan rather
 * than a way back. The NOTICE is asserted as well as the values, because the live side has no
 * field in the old shape and printing it is the only chance an operator gets to write it down.
 */
describe('rollback/0264_down.sql', () => {
  // cm:guard a connection of its own with `onnotice` wired, because the NOTICE is half of what
  // this file has to prove: the live side has no field in the old shape, so printing it is the
  // only chance an operator gets to write those values down before they go. A run that swallowed
  // the notice would pass every value assertion below and still be the wrong rollback.
  async function runDown(): Promise<string[]> {
    const notices: string[] = [];
    const client = postgres(harness.url, {
      max: 1,
      onnotice: (n: { message?: string }) => {
        if (n.message) notices.push(n.message);
      },
    });
    try {
      await client.unsafe(down);
    } finally {
      await client.end();
    }
    return notices;
  }

  it('returns a fully-populated row to the value it held before 0264 ran', async () => {
    const before = {
      stagingUrl: 'https://stg.example.com',
      stagingApiUrl: 'https://api.stg.example.com',
      testingUrls: [{ label: 'Beta', url: 'https://beta.example.com' }],
      notes: 'the QA account reaches no other project',
      testCredentials: [{ label: 'Admin', username: 'bot@x', password: 'keep-me' }],
      futureKnob: 'round-trips',
    };
    const id = await seed('p-roundtrip', before);

    await runForward();
    await runDown();

    expect(await read(id, 'preview_deploy')).toEqual(before);
  });

  // cm:guard limits text typed AFTER the deploy comes back too, because the old shape has a field
  // for it. This is the half of the restoration that is not merely "undo what we wrote".
  it('restores limits written after the deploy into notes', async () => {
    const id = await seed('p-late-limits', { stagingUrl: 'https://stg.example.com' });

    await runForward();
    await harness.db.execute(
      sql`UPDATE projects SET environments = jsonb_set(environments, '{limits}', '"typed later"') WHERE id = ${id}`,
    );
    await runDown();

    const out = (await read(id, 'preview_deploy')) as Record<string, unknown>;
    expect(out.notes).toBe('typed later');
  });

  // cm:guard the several equivalent empties all come back as `{}`, which is the ONE way the
  // restoration is not byte-exact — and it costs nothing, because every reader in the tree goes
  // through `?? {}` and then a per-key `typeof` test. Stating it here is what stops the next
  // reader mistaking it for a bug.
  it('brings an empty row back as {} whichever empty it was', async () => {
    const ids = await Promise.all([
      seed('p-e1', {}),
      seed('p-e2', { stagingUrl: null }),
      seed('p-e3', { testingUrls: [] }),
    ]);

    await runForward();
    await runDown();

    for (const id of ids) expect(await read(id, 'preview_deploy')).toEqual({});
  });

  it('raises a NOTICE naming each project whose live side it is about to drop', async () => {
    const id = await seed('p-has-live', { stagingUrl: 'https://stg.example.com' });
    await seed('p-no-live', { stagingUrl: 'https://other.example.com' });

    await runForward();
    await harness.db.execute(
      sql`UPDATE projects SET environments = jsonb_set(environments, '{live,commitUrl}', '"https://api.example.com/health"') WHERE id = ${id}`,
    );
    const notices = await runDown();

    const text = notices.join('\n');
    expect(text).toContain('p-has-live');
    expect(text).toContain('https://api.example.com/health');
    expect(text).not.toContain('p-no-live');
  });
});
