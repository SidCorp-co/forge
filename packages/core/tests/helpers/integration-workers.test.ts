import { describe, expect, it } from 'vitest';
import { HOSTED_WORKERS_PER_CORE, integrationWorkers } from './integration-workers.js';

const HOSTED = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };

describe('integrationWorkers on a GitHub-hosted runner', () => {
  it('takes every core times the measured factor', () => {
    expect(integrationWorkers(HOSTED, 4).count).toBe(Math.round(4 * HOSTED_WORKERS_PER_CORE));
    expect(integrationWorkers(HOSTED, 16).count).toBe(Math.round(16 * HOSTED_WORKERS_PER_CORE));
  });

  it('runs more than one file at once on the 4-vCPU image', () => {
    expect(integrationWorkers(HOSTED, 4).count).toBeGreaterThan(1);
  });

  it('says which rule chose the count', () => {
    expect(integrationWorkers(HOSTED, 4).rule).toMatch(/GitHub-hosted/);
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
