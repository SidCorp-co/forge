import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOSTED_WORKERS_PER_CORE, integrationWorkers, workerLine } from './integration-workers.js';

const HOSTED = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };

describe('integrationWorkers on a GitHub-hosted runner', () => {
  it('takes every core times the measured factor', () => {
    expect(integrationWorkers(HOSTED, 4).count).toBe(Math.round(4 * HOSTED_WORKERS_PER_CORE));
    expect(integrationWorkers(HOSTED, 16).count).toBe(Math.round(16 * HOSTED_WORKERS_PER_CORE));
  });

  it('runs more than one file at once on the 4-vCPU image', () => {
    expect(integrationWorkers(HOSTED, 4).count).toBeGreaterThan(1);
  });

  it('says which rule chose the count, and from how many cores', () => {
    expect(integrationWorkers(HOSTED, 4)).toMatchObject({
      cores: 4,
      rule: expect.stringMatching(/GitHub-hosted/),
    });
  });
});

describe('integrationWorkers anywhere GitHub has not declared a hosted runner', () => {
  it.each([
    [{}, 'no CI variables'],
    [{ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }, 'a self-hosted runner'],
    [{ RUNNER_ENVIRONMENT: 'github-hosted' }, 'the runner variable alone'],
    [{ GITHUB_ACTIONS: 'true' }, 'the actions variable alone'],
    [{ CI: 'true' }, 'a bare CI=true'],
  ])('keeps the shared-machine share with %o (%s)', (env, _why) => {
    expect(integrationWorkers(env, 56).count).toBe(3);
    expect(integrationWorkers(env, 12).count).toBe(3);
    expect(integrationWorkers(env, 8).count).toBe(2);
    expect(integrationWorkers(env, 4).count).toBe(1);
    expect(integrationWorkers(env, 2).count).toBe(1);
    expect(integrationWorkers(env, 1).count).toBe(1);
  });
});

describe('integrationWorkers under VITEST_MAX_WORKERS', () => {
  it('uses a positive whole number as given, on either kind of machine', () => {
    expect(integrationWorkers({ VITEST_MAX_WORKERS: '7' }, 56).count).toBe(7);
    expect(integrationWorkers({ ...HOSTED, VITEST_MAX_WORKERS: '1' }, 4).count).toBe(1);
  });

  it('reads an empty value as unset', () => {
    expect(integrationWorkers({ VITEST_MAX_WORKERS: '' }, 56).count).toBe(3);
  });

  it.each(['0', '-2', '2.5', 'abc', ' 4', '4 ', '0x4', '1e1'])(
    'refuses %j by name, with the shape that is valid',
    (value) => {
      expect(() => integrationWorkers({ VITEST_MAX_WORKERS: value }, 4)).toThrow(
        `VITEST_MAX_WORKERS="${value}" is not a worker count. It takes a positive whole number`,
      );
    },
  );
});

describe('workerLine, the account a run prints of its own count', () => {
  const shared = integrationWorkers({}, 56);

  it('names the count, the cores and the rule where nothing overrode it', () => {
    expect(workerLine(shared, 3, undefined, {})).toBe(
      '[integration] 3 worker(s) on 56 core(s) — a shared machine, a quarter of the cores and at most 3',
    );
  });

  it('names the flag that overrode the rule, and the count the rule gave', () => {
    expect(workerLine(shared, 5, 5, {})).toMatch(/^\[integration\] 5 worker\(s\) on 56 core\(s\)/);
    expect(workerLine(shared, 5, 5, {})).toMatch(
      /; --maxWorkers=5 overrode the 3 that rule gives$/,
    );
  });

  it('says so where something other than the flag moved the count', () => {
    expect(workerLine(shared, 7, undefined, {})).toMatch(
      /; something outside that rule overrode the 3 that rule gives$/,
    );
  });

  it('adds nothing where the flag asks for what the rule gives', () => {
    expect(workerLine(shared, 3, 3, {})).not.toMatch(/overrode/);
  });

  it.each([5, '5', '50%', 2])(
    'refuses --maxWorkers=%j beside VITEST_MAX_WORKERS=2, naming both',
    (flag) => {
      const env = { VITEST_MAX_WORKERS: '2' };
      expect(() => workerLine(integrationWorkers(env, 56), 2, flag, env)).toThrow(
        `--maxWorkers=${flag} and VITEST_MAX_WORKERS=2 both set a worker count, and vitest takes ` +
          'the variable and drops the flag. Give one:',
      );
    },
  );

  it('takes VITEST_MAX_WORKERS alone, and an empty one beside the flag, without refusing', () => {
    const env = { VITEST_MAX_WORKERS: '2' };
    expect(workerLine(integrationWorkers(env, 56), 2, undefined, env)).toMatch(
      /— VITEST_MAX_WORKERS=2$/,
    );
    expect(workerLine(shared, 5, 5, { VITEST_MAX_WORKERS: '' })).toMatch(/--maxWorkers=5 overrode/);
  });
});

describe('the integration config given both --maxWorkers and VITEST_MAX_WORKERS', () => {
  const core = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const vitest = join(
    dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
    'vitest.mjs',
  );

  it.each([
    [['--maxWorkers=5'], '5'],
    [['--maxWorkers', '5'], '5'],
    [['--max-workers=5'], '5'],
    [['--maxWorkers=50%'], '50%'],
  ])(
    'refuses %j before any file runs, naming both, off the flag vitest parsed',
    (flag, value) => {
      // An unreachable server: a run that got past the refusal fails at connect, not in a container.
      const env: NodeJS.ProcessEnv = {
        VITEST_MAX_WORKERS: '2',
        TEST_DATABASE_URL: 'postgres://forge:forge@127.0.0.1:1/unreachable',
      };
      for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VITEST')) env[k] ??= v;
      const run = spawnSync(
        process.execPath,
        [
          vitest,
          'run',
          '--config',
          'vitest.integration.config.ts',
          ...flag,
          'file-database-isolation',
        ],
        { cwd: core, env, encoding: 'utf8', timeout: 60_000 },
      );
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain(
        `--maxWorkers=${value} and VITEST_MAX_WORKERS=2 both set a worker count`,
      );
      expect(out).not.toMatch(/Test Files/);
      expect(run.status).toBe(1);
    },
    90_000,
  );
});
