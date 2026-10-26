import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { mintedBy, mintRunToken, retireScratchDb } from '../helpers/scratch-db.js';

// A worker slot hands its one database to every file it runs (`tests/helpers/slot-db.ts`), so what
// keeps one file's rows from the next is the reset between them, not a database apiece. This runs
// real files through that path in a nested vitest and holds the reset to what a fresh clone would
// be: no row the file before wrote, the template's seed rows back, every sequence where it was, and
// no schema the file before created — that file refused for creating it.

const CONFIG = fileURLToPath(
  new URL('../helpers/file-isolation/vitest.config.ts', import.meta.url),
);
const VITEST = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

interface Assertion {
  title: string;
  status: string;
  failureMessages: string[];
}

interface FileResult {
  name: string;
  status: string;
  message?: string;
  assertionResults: Assertion[];
}

interface Nested {
  file(name: string): FileResult;
  left(name: string): string;
}

async function runNested(
  files: string[],
  workers: number,
  { inherit = false } = {},
): Promise<Nested> {
  const dir = mkdtempSync(join(tmpdir(), 'file-isolation-'));
  const token = mintRunToken();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VITEST') && k !== 'NODE_V8_COVERAGE') env[k] = v;
  }
  Object.assign(env, {
    ISOLATION_DIR: dir,
    ISOLATION_FILES: files.join(','),
    ISOLATION_WORKERS: String(workers),
    ISOLATION_OVERLAP: workers > 1 ? '1' : '0',
    ISOLATION_MARKER: String(1000 + Math.floor(Math.random() * 1_000_000)),
    ISOLATION_INHERIT: inherit ? '1' : '0',
    ISOLATION_TOKEN: token,
  });
  const out = join(dir, 'report.json');
  try {
    await new Promise<void>((resolve) => {
      execFile(
        process.execPath,
        [VITEST, 'run', '--config', CONFIG, '--reporter=json', `--outputFile=${out}`],
        { env, timeout: 90_000 },
        () => resolve(),
      );
    });
    const report = JSON.parse(readFileSync(out, 'utf8')) as { testResults: FileResult[] };
    const left = new Map<string, string>();
    for (const name of files) {
      const path = join(dir, `${name}-db`);
      if (existsSync(path)) left.set(name, readFileSync(path, 'utf8'));
    }
    return {
      file(name) {
        const hit = report.testResults.find((r) => r.name.endsWith(`/${name}.fixture.ts`));
        if (!hit) throw new Error(`the nested run reported no ${name}: ${JSON.stringify(report)}`);
        return hit;
      },
      left(name) {
        const db = left.get(name);
        if (db === undefined) throw new Error(`${name} left no database name`);
        return db;
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await giveBack(token);
  }
}

/** Hand the drain whatever the nested run's teardown left under its token, e.g. when it was killed. */
async function giveBack(token: string): Promise<void> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL as string;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE strpos(datname, ${token}) > 0
    `;
    for (const { datname } of rows)
      if (mintedBy(datname, token)) retireScratchDb(adminUrl, datname);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function assertion(file: FileResult, title: string): Assertion {
  const hit = file.assertionResults.find((a) => a.title === title);
  if (!hit) throw new Error(`${file.name} reported no "${title}": ${JSON.stringify(file)}`);
  return hit;
}

const SLOW = 120_000;

describe('a test file cannot see what another test file left behind', () => {
  it(
    'fails the dependent file at two workers, each file in a slot database of its own',
    async () => {
      const nested = await runNested(['writer', 'reader'], 2);

      expect(nested.file('writer').status, 'the writing file').toBe('passed');
      const row = assertion(nested.file('reader'), 'depends on the row the writer file wrote');
      expect(row.status).toBe('failed');
      expect(row.failureMessages.join('\n')).toContain('the row the writer file wrote');
      expect(nested.left('writer')).toMatch(/^test_w_[12]_/);
      expect(nested.left('reader')).toMatch(/^test_w_[12]_/);
      expect(nested.left('reader')).not.toBe(nested.left('writer'));
    },
    SLOW,
  );

  it(
    'hands the next file in one slot the same database, reset to the clone it was',
    async () => {
      const nested = await runNested(['writer', 'reader'], 1);
      const reader = nested.file('reader');

      expect(nested.file('writer').status, 'the writing file').toBe('passed');
      expect(nested.left('reader')).toBe(nested.left('writer'));
      expect(nested.left('reader')).toMatch(/^test_w_1_/);
      const row = assertion(reader, 'depends on the row the writer file wrote');
      expect(row.status).toBe('failed');
      expect(row.failureMessages.join('\n')).toContain('the row the writer file wrote');
      expect(assertion(reader, 'finds the template seed row the writer file deleted').status).toBe(
        'passed',
      );
      expect(assertion(reader, 'finds no queue schema the writer file started').status).toBe(
        'passed',
      );
      expect(
        assertion(
          reader,
          'reads the sequence the writer file advanced at the value the writer found',
        ).status,
      ).toBe('passed');
    },
    SLOW,
  );

  it(
    'refuses a file that changed its slot database schema, and hands the next file a clean one',
    async () => {
      const nested = await runNested(['schema-writer', 'after-schema'], 1);
      const writer = nested.file('schema-writer');
      const said = JSON.stringify(writer);

      expect(writer.status, 'the file that wrote schema undeclared').toBe('failed');
      expect(said).toContain('schema-writer.fixture.ts changed the schema of the slot database');
      expect(said).toContain('added relation public.isolation_probe');
      expect(said).toContain('changed relation drizzle.__drizzle_migrations_id_seq');
      expect(said).toContain('own:');
      expect(nested.file('after-schema').status, 'the file after it').toBe('passed');
    },
    SLOW,
  );

  it(
    'gives a file that declared its own database one no slot shares',
    async () => {
      const nested = await runNested(['own-writer', 'second-slot'], 1);

      expect(nested.file('own-writer').status, 'the declaring file').toBe('passed');
      expect(nested.left('own-writer')).toMatch(/^test_own_/);
      expect(nested.left('second-slot')).toMatch(/^test_w_1_/);
      expect(nested.file('second-slot').status, 'the file asking twice').toBe('passed');
    },
    SLOW,
  );

  it(
    'refuses a vitest launched apart that inherited this run’s token',
    async () => {
      const nested = await runNested(['after-schema'], 1, { inherit: true });
      const said = JSON.stringify(nested.file('after-schema'));

      expect(nested.file('after-schema').status).toBe('failed');
      expect(said).toContain(`was minted by process ${process.env.TEST_PG_RUN_OWNER}`);
    },
    SLOW,
  );
});
