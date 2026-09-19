import { cpus } from 'node:os';

export function testWorkers({ share = 3, cap = Number.POSITIVE_INFINITY, min = 1 } = {}) {
  const override = Number(process.env.VITEST_MAX_WORKERS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const cores = cpus().length || 1;
  return Math.max(min, Math.min(cap, Math.floor(cores / share) || 1));
}
