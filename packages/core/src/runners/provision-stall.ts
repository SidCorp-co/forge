import type { RunnerProvisionStatus } from '../db/schema.js';

/** A provision no box report has touched for `provisionStallMs()` is stalled (ISS-1359). */
export const PROVISION_IN_FLIGHT: readonly RunnerProvisionStatus[] = [
  'queued',
  'cloning',
  'syncing_skills',
  'writing_mcp',
];

const DEFAULT_STALL_MS = 30 * 60_000;

/** `PROVISION_STALL_MS` moves it; no clone reported step by step takes this long. */
export function provisionStallMs(): number {
  const n = Number.parseInt(process.env.PROVISION_STALL_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_MS;
}

export function isInFlight(status: string | null): boolean {
  return status !== null && (PROVISION_IN_FLIGHT as readonly string[]).includes(status);
}

/** Stalled from exactly one window, as the SQL reads it with `<=`; `null` for a settled or recent row. */
export function provisionStalledSeconds(
  status: string | null,
  statusAt: Date,
  now: Date,
  stallMs: number = provisionStallMs(),
): number | null {
  if (!isInFlight(status)) return null;
  const age = now.getTime() - statusAt.getTime();
  return age >= stallMs ? Math.round(age / 1000) : null;
}
