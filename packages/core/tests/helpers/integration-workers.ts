import { cpus } from 'node:os';

export interface WorkerCount {
  count: number;
  rule: string;
}

type Env = Readonly<Record<string, string | undefined>>;

// Probed 2026-09-29, ubuntu-24.04 4 vCPU, mean job wall of two runs at 1/2/4/6/8 workers:
// 1236/750/630/496/592s (run 36619530249). Rule and re-probe: tests/README.md.
export const HOSTED_WORKERS_PER_CORE = 1.5;

const POSITIVE_WHOLE = /^[1-9][0-9]*$/;

/** Files at once on the machine this run is on; why each machine gets what: tests/README.md. */
export function integrationWorkers(
  env: Env = process.env,
  cores = cpus().length || 1,
): WorkerCount {
  const override = env.VITEST_MAX_WORKERS;
  if (override !== undefined && override !== '') {
    if (!POSITIVE_WHOLE.test(override)) {
      throw new Error(
        `VITEST_MAX_WORKERS="${override}" is not a worker count. It takes a positive whole ` +
          'number such as 4, or is left unset so the machine this run is on decides.',
      );
    }
    return { count: Number(override), rule: `VITEST_MAX_WORKERS=${override}` };
  }
  if (env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted') {
    return {
      count: Math.max(1, Math.round(cores * HOSTED_WORKERS_PER_CORE)),
      rule: `a GitHub-hosted runner, ${HOSTED_WORKERS_PER_CORE} per core`,
    };
  }
  return {
    count: Math.max(1, Math.min(3, Math.floor(cores / 4))),
    rule: 'a shared machine, a quarter of the cores and at most 3',
  };
}
