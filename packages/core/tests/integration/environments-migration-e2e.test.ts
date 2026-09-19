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
 * ISS-1069 — migration 0279 runs against the real table, on every shape a row can hold.
 *
 * The migration is the half of this change that cannot be rolled back by reverting a commit, and
 * its rules are all about values the TypeScript side never sees: a column holding SQL null, a
 * column holding the JSON literal `null`, a value that is not an object at all, keys present but
 * empty, and a key the file does not recognise. A unit test over `normalizeEnvironments` covers
 * none of them, because the question here is what Postgres wrote — so this suite replays the
 * actual `.sql` file against the actual `projects` table.
 *
 * It does that by putting the column BACK under its old name first. The harness database is already
 * migrated, so 0279 has run; renaming `environments` to `preview_deploy` reconstructs the exact
 * pre-migration state the file is written against. That is also what makes the abort cases
 * meaningful: an aborted run must leave the old name in place with every row unwritten, which is a
 * claim about the column's NAME and not only its contents.
 */
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
 * Put the column back under its pre-0279 name, so the file can be replayed against it.
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
  forward = await statements('../../drizzle/migrations/0279_environments.sql');
  const downParts = await statements('../../drizzle/rollback/0279_down.sql');
  expect(downParts).toHaveLength(1);
  down = downParts[0] as string;
}, 120_000);

afterAll(async () => {
  await harness.cleanup();
});

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

  it('carries a key it does not recognise through unchanged', async () => {
    const id = await seed('p-unknown', {
      stagingUrl: 'https://stg.example.com',
      futureKnob: { nested: ['a', 1, null] },
    });

    await runForward();

    const out = (await read(id, 'environments')) as Record<string, unknown>;
    expect(out.futureKnob).toEqual({ nested: ['a', 1, null] });
  });

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
    ['a testingUrls entry that is a bare string', { testingUrls: ['https://beta.example.com'] }],
    ['a testingUrls entry that is null', { testingUrls: [null] }],
    ['a testingUrls entry that is a number', { testingUrls: [7] }],
    ['a testCredentials entry that is a bare string', { testCredentials: ['admin'] }],
    ['a testCredentials entry that is null', { testCredentials: [null] }],
    [
      'a testingUrls row whose url is an object',
      { testingUrls: [{ label: 'Beta', url: { href: 'https://beta.example.com' } }] },
    ],
    [
      'a testingUrls row whose label is a number',
      { testingUrls: [{ label: 7, url: 'https://b.x' }] },
    ],
    ['a testingUrls row with no url at all', { testingUrls: [{ label: 'Beta' }] }],
    [
      'a testCredentials row with no password',
      { testCredentials: [{ label: 'Admin', username: 'bot@x' }] },
    ],
    [
      'a testCredentials row whose username is a number',
      { testCredentials: [{ label: 'Admin', username: 7, password: 'p' }] },
    ],
  ])('refuses %s', async (label, value) => {
    const slug = `offender-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
    const id = await seed(slug, typeof value === 'string' ? JSON.parse(value) : value);

    expect(await forwardError()).toContain(slug);

    expect(await read(id, 'preview_deploy')).toEqual(
      typeof value === 'string' ? JSON.parse(value) : value,
    );
  });

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
 * `rollback/0279_down.sql` is applied BY HAND before the previous image starts, so nothing in CI
 * would otherwise execute a line of it — and a rollback file that has never run is a plan rather
 * than a way back. The NOTICE is asserted as well as the values, because the live side has no
 * field in the old shape and printing it is the only chance an operator gets to write it down.
 */
describe('rollback/0279_down.sql', () => {
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

  it('returns a fully-populated row to the value it held before 0279 ran', async () => {
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

  it('does not strip an explicit null inside a testing URL row it never touched', async () => {
    const before = {
      stagingUrl: 'https://stg.example.com',
      testingUrls: [
        { label: 'Beta', url: 'https://beta.example.com', future: { mode: null }, tag: null },
      ],
    };
    const id = await seed('p-nested-null', before);

    await runForward();
    await runDown();

    expect(await read(id, 'preview_deploy')).toEqual(before);
  });

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
