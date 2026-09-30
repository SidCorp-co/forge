import { availableParallelism } from 'node:os';

export interface WorkerCount {
  count: number;
  cores: number;
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
  cores = availableParallelism(),
): WorkerCount {
  const override = env.VITEST_MAX_WORKERS;
  if (override !== undefined && override !== '') {
    if (!POSITIVE_WHOLE.test(override)) {
      throw new Error(
        `VITEST_MAX_WORKERS="${override}" is not a worker count. It takes a positive whole ` +
          'number such as 4, or is left unset so the machine this run is on decides.',
      );
    }
    return { count: Number(override), cores, rule: `VITEST_MAX_WORKERS=${override}` };
  }
  if (env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted') {
    return {
      count: Math.max(1, Math.round(cores * HOSTED_WORKERS_PER_CORE)),
      cores,
      rule: `a GitHub-hosted runner, ${HOSTED_WORKERS_PER_CORE} per core`,
    };
  }
  return {
    count: Math.max(1, Math.min(3, Math.floor(cores / 4))),
    cores,
    rule: 'a shared machine, a quarter of the cores and at most 3',
  };
}

/** The run's own account of its count, or a refusal where vitest would drop `--maxWorkers` unsaid. */
export function workerLine(
  chosen: WorkerCount,
  resolved: number,
  flag: string | number | undefined,
  env: Env = process.env,
): string {
  const variable = env.VITEST_MAX_WORKERS;
  if (flag !== undefined && variable !== undefined && variable !== '') {
    throw new Error(
      `--maxWorkers=${flag} and VITEST_MAX_WORKERS=${variable} both set a worker count, and ` +
        'vitest takes the variable and drops the flag. Give one: unset VITEST_MAX_WORKERS for ' +
        'the flag to decide, or leave --maxWorkers off.',
    );
  }
  const by = flag === undefined ? 'something outside that rule' : `--maxWorkers=${flag}`;
  const overruled =
    resolved === chosen.count ? '' : `; ${by} overrode the ${chosen.count} that rule gives`;
  return `[integration] ${resolved} worker(s) on ${chosen.cores} core(s) — ${chosen.rule}${overruled}`;
}
