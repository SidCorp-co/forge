import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { workerOverride } from './worker-override.mjs';

const CONFIG = 'packages/core/vitest.config.ts';
const MALFORMED = ['abc', '0', '-2', '2.5', ' 4', '4 ', '0x4', '1e1', 'NaN', 'Infinity'];

describe('workerOverride', () => {
  it('takes a positive whole number as given', () => {
    expect(workerOverride({ VITEST_MAX_WORKERS: '1' }, CONFIG)).toBe(1);
    expect(workerOverride({ VITEST_MAX_WORKERS: '12' }, CONFIG)).toBe(12);
  });

  it('reads unset and empty as no override', () => {
    expect(workerOverride({}, CONFIG)).toBeUndefined();
    expect(workerOverride({ VITEST_MAX_WORKERS: '' }, CONFIG)).toBeUndefined();
  });

  it.each(MALFORMED)('refuses %j by name, with the config and the valid shape', (value) => {
    expect(() => workerOverride({ VITEST_MAX_WORKERS: value }, CONFIG)).toThrow(
      `VITEST_MAX_WORKERS="${value}" is not a worker count for ${CONFIG}. It takes a positive ` +
        'whole number such as 4',
    );
  });
});

describe('each unit config, loaded by vitest with a malformed VITEST_MAX_WORKERS', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const vitest = join(
    dirname(createRequire(join(root, 'packages/core/package.json')).resolve('vitest/package.json')),
    'vitest.mjs',
  );

  it.each([
    ['packages/core', 'abc'],
    ['packages/core', '2.5'],
    ['packages/web-v2', 'abc'],
    ['packages/web-v2', '0'],
  ])(
    '%s refuses %j before any file runs',
    (pkg, value) => {
      // A filter no file matches: a config that stopped refusing exits at once, not after its suite.
      const env = { VITEST_MAX_WORKERS: value };
      for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VITEST')) env[k] ??= v;
      const run = spawnSync(
        process.execPath,
        [
          vitest,
          'run',
          '--config',
          'vitest.config.ts',
          '--passWithNoTests',
          'no-file-is-named-this',
        ],
        {
          cwd: join(root, pkg),
          env,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain(
        `VITEST_MAX_WORKERS="${value}" is not a worker count for ${pkg}/vitest.config.ts.`,
      );
      expect(out).not.toMatch(/Test Files/);
      expect(run.status).toBe(1);
    },
    90_000,
  );
});
