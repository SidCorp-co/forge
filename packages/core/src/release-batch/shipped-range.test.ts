import { describe, expect, it } from 'vitest';
import { type RangeHost, rangeReads, shippedBetween } from './shipped-range.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

const JOURNAL = 'packages/core/drizzle/migrations/meta/_journal.json';
const OPENAPI = 'packages/core/contracts/forge-api.openapi.json';
const PKG = 'packages/core/package.json';
const COMPOSE = 'docker-compose.prod.yml';

const journal = (...tags: string[]) =>
  JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag, when: idx })) });

const op = (summary: string, schema = 'Page') => ({
  summary,
  responses: {
    200: {
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
    },
  },
});
const spec = (
  paths: Record<string, unknown>,
  schemas: Record<string, unknown> = { Page: { type: 'object' } },
) => JSON.stringify({ paths, components: { schemas } });

type Files = Record<string, Record<string, string>>;

/** A repository of two commits: the files each holds, and which paths differ. */
function repo(files: Files, changed: string[], opts: { why?: string } = {}): RangeHost {
  return {
    async compareFiles() {
      if (opts.why) return { why: opts.why };
      return {
        status: 'ahead',
        files: changed,
        changes: changed.map((path) => ({ path, change: 'changed' as const })),
      };
    },
    async readFile(path, ref) {
      const text = files[ref]?.[path];
      return text === undefined ? { missing: `${path} does not exist at ${ref}` } : text;
    },
  };
}

describe('what a release range ships, read from the repository (BC-7, BC-9)', () => {
  it('names the migrations the journal gains, as files', async () => {
    const host = repo(
      {
        [BASE]: { [JOURNAL]: journal('0475_a', '0476_b') },
        [HEAD]: { [JOURNAL]: journal('0475_a', '0476_b', '0477_preview', '0478_page') },
      },
      [JOURNAL],
    );
    const read = await shippedBetween(host, BASE, HEAD);
    expect(read).toMatchObject({
      state: 'read',
      base: BASE,
      head: HEAD,
      migrations: [
        'packages/core/drizzle/migrations/0477_preview.sql',
        'packages/core/drizzle/migrations/0478_page.sql',
      ],
    });
  });

  it('names an API operation added, one changed through a schema it reaches, and one removed', async () => {
    const host = repo(
      {
        [BASE]: {
          [OPENAPI]: spec(
            {
              '/api/a': { get: op('a') },
              '/api/b': { get: op('b', 'Other') },
              '/api/gone': { delete: op('x') },
            },
            { Page: { type: 'object' }, Other: { type: 'string' } },
          ),
        },
        [HEAD]: {
          [OPENAPI]: spec(
            {
              '/api/a': { get: op('a') },
              '/api/b': { get: op('b', 'Other') },
              '/api/new': { post: op('n') },
            },
            { Page: { type: 'object' }, Other: { type: 'number' } },
          ),
        },
      },
      [OPENAPI],
    );
    const read = await shippedBetween(host, BASE, HEAD);
    expect(read).toMatchObject({
      state: 'read',
      contracts: ['added POST /api/new', 'changed GET /api/b', 'removed DELETE /api/gone'],
    });
  });

  it('says nothing changed in a contract whose operations are the same', async () => {
    const same = spec({ '/api/a': { get: op('a') } });
    const read = await shippedBetween(
      repo({ [BASE]: { [OPENAPI]: same }, [HEAD]: { [OPENAPI]: same } }, [OPENAPI]),
      BASE,
      HEAD,
    );
    expect(read).toMatchObject({ state: 'read', contracts: [] });
  });

  it('names a dependency added, moved and removed in a package.json', async () => {
    const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
      JSON.stringify({ dependencies: deps, devDependencies: dev });
    const host = repo(
      {
        [BASE]: { [PKG]: pkg({ hono: '4.1.0', lodash: '4.0.0' }, { vitest: '5.0.0' }) },
        [HEAD]: { [PKG]: pkg({ hono: '4.2.0', zod: '4.6.5' }, { vitest: '5.0.0' }) },
      },
      [PKG],
    );
    const read = await shippedBetween(host, BASE, HEAD);
    expect(read).toMatchObject({
      state: 'read',
      dependencies: [
        'packages/core: added zod 4.6.5',
        'packages/core: hono 4.1.0 -> 4.2.0',
        'packages/core: removed lodash',
      ],
    });
  });

  it('names an environment setting a deployment file gains, required where it refuses to start without it', async () => {
    const compose = (...lines: string[]) =>
      `services:\n  core:\n    environment:\n${lines.map((l) => `      ${l}`).join('\n')}\n`;
    const host = repo(
      {
        [BASE]: { [COMPOSE]: compose(`DATABASE_URL: \${DATABASE_URL:?set it}`) },
        [HEAD]: {
          [COMPOSE]: compose(
            `DATABASE_URL: \${DATABASE_URL:?set it}`,
            `PREVIEW_DOMAIN: \${PREVIEW_DOMAIN:-}`,
            `VAULT_KEY: \${VAULT_KEY:?a key}`,
          ),
        },
      },
      [COMPOSE],
    );
    const read = await shippedBetween(host, BASE, HEAD);
    expect(read).toMatchObject({
      state: 'read',
      settings: [
        { name: 'PREVIEW_DOMAIN', required: false },
        { name: 'VAULT_KEY', required: true },
      ],
    });
  });

  it('reads a range that touches none of them as shipping none of them', async () => {
    const read = await shippedBetween(repo({}, ['packages/web-v2/src/a.tsx']), BASE, HEAD);
    expect(read).toEqual({
      state: 'read',
      base: BASE,
      head: HEAD,
      migrations: [],
      contracts: [],
      dependencies: [],
      settings: [],
    });
  });

  it('refuses by name where the files the range changed cannot be named, never reading it as empty', async () => {
    const read = await shippedBetween(
      repo({}, [], { why: '3000 or more files differ' }),
      BASE,
      HEAD,
    );
    expect(read).toEqual({
      state: 'unread',
      why: expect.stringContaining('3000 or more files differ'),
    });
  });

  it('refuses by name a file it cannot parse, with the path and the commit', async () => {
    const host = repo(
      { [BASE]: { [JOURNAL]: journal('0475_a') }, [HEAD]: { [JOURNAL]: '{not json' } },
      [JOURNAL],
    );
    const read = await shippedBetween(host, BASE, HEAD);
    expect(read.state).toBe('unread');
    expect(read.state === 'unread' && read.why).toContain(JOURNAL);
  });
});

describe('which changed files the run sends the reader (rangeReads)', () => {
  it('names the journal, the generated contract, each package.json and each compose file, once, in order', () => {
    expect(
      rangeReads([
        { path: 'packages/core/src/index.ts', change: 'changed' },
        { path: PKG, change: 'changed' },
        { path: COMPOSE, change: 'added' },
        { path: JOURNAL, change: 'changed' },
        { path: OPENAPI, change: 'changed' },
        { path: 'packages/web-v2/package.json', change: 'removed' },
        { path: 'docs/package.json.md', change: 'added' },
      ]),
    ).toEqual([COMPOSE, OPENAPI, JOURNAL, PKG, 'packages/web-v2/package.json'].sort());
  });

  it('names none for a range that touches none of them', () => {
    expect(rangeReads([{ path: 'README.md', change: 'changed' }])).toEqual([]);
  });
});
