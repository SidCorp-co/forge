import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Parallel integration workers are safe only because every test FILE gets a database of its own
// (`tests/helpers/db.ts`). This runs two real files through that path in a nested vitest — the
// second depends on a row the first wrote — and holds that the dependent file fails, whether the
// two overlap at two workers or run writer-first at one. A shared database would let it pass.

const CONFIG = fileURLToPath(
  new URL('../helpers/file-isolation/vitest.config.ts', import.meta.url),
);
const VITEST = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

interface FileResult {
  name: string;
  status: string;
  assertionResults: { status: string; failureMessages: string[] }[];
}

interface Nested {
  files: Record<'writer' | 'reader', FileResult>;
  writerDb: string;
  readerDb: string;
}

async function runNested(workers: number): Promise<Nested> {
  const dir = mkdtempSync(join(tmpdir(), 'file-isolation-'));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VITEST') && k !== 'NODE_V8_COVERAGE') env[k] = v;
  }
  Object.assign(env, {
    ISOLATION_DIR: dir,
    ISOLATION_WORKERS: String(workers),
    ISOLATION_OVERLAP: workers > 1 ? '1' : '0',
    ISOLATION_MARKER: `${workers}-${Date.now().toString(36)}`,
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
    const find = (suffix: string): FileResult => {
      const hit = report.testResults.find((r) => r.name.endsWith(suffix));
      if (!hit) throw new Error(`the nested run reported no ${suffix}: ${JSON.stringify(report)}`);
      return hit;
    };
    return {
      files: { writer: find('/writer.fixture.ts'), reader: find('/reader.fixture.ts') },
      writerDb: readFileSync(join(dir, 'writer-db'), 'utf8'),
      readerDb: readFileSync(join(dir, 'reader-db'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a test file cannot see a row another test file wrote', () => {
  it.each([
    [2, 'overlapping at two workers'],
    [1, 'at one worker, the writing file first'],
  ])(
    'fails the dependent file at %i worker(s) — %s',
    async (workers) => {
      const nested = await runNested(workers);

      expect(nested.files.writer.status, 'the writing file').toBe('passed');
      expect(nested.files.reader.status, 'the dependent file').toBe('failed');
      expect(nested.files.reader.assertionResults[0]?.failureMessages.join('\n')).toContain(
        'the row the writer file wrote',
      );
      expect(nested.writerDb).toMatch(/^test_w_/);
      expect(nested.readerDb).toMatch(/^test_w_/);
      expect(nested.readerDb).not.toBe(nested.writerDb);
    },
    120_000,
  );
});
