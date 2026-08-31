/**
 * Shared fake for the reconciler's four raw-SQL passes.
 *
 * `runReconcilerOnce` issues its queries through `db.execute` with no way to
 * name them, so the fake routes on the SQL text and each pass gets its own
 * queue. Two test files drive the same tick from opposite ends — the staged
 * passes and the autonomous ones — and duplicating this router would let the
 * two copies disagree about which pass a query belongs to.
 */

import { vi } from 'vitest';

export interface StuckRow {
  id: string;
  project_id: string;
  status: string;
  created_by: string | null;
  mode: string | null;
  reopen_count: number;
}

export interface WedgeRow {
  id: string;
  project_id: string;
  status: string;
  reopen_count: number;
  created_by: string | null;
  job_type: string;
}

export interface AutonomousWedgeRow {
  id: string;
  project_id: string;
  status: string;
  reopen_count: number;
  created_by: string | null;
}

export const stuckQueue: StuckRow[][] = [];
export const staleCountQueue: Array<Array<{ count: string | number }>> = [];
export const wedgeQueue: WedgeRow[][] = [];
export const autonomousWedgeQueue: AutonomousWedgeRow[][] = [];
export const jobsQueue: Array<Array<{ one: number }>> = [];

function templateText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  let text = '';
  for (const c of chunks) {
    if (typeof c === 'object' && c !== null && 'value' in c) {
      const v = (c as { value?: unknown }).value;
      if (Array.isArray(v)) {
        text += v.filter((p): p is string => typeof p === 'string').join(' ');
      } else if (typeof v === 'string') {
        text += v;
      }
    }
  }
  return text;
}

export const dbExecute = vi.fn(async (q: unknown) => {
  const firstSql = templateText(q);
  // cm:guard match on agent_config AND lateral together, never either alone: the stuck-issue query reads `agent_config` too (it carries the project's mode) and the ISS-598 wedge query has its own LATERAL, so a single-key router swallows one of the three and its tests then assert on rows the pass never saw. Only the ISS-890 query has both.
  if (/agent_config/i.test(firstSql) && /lateral/i.test(firstSql)) {
    return autonomousWedgeQueue.shift() ?? [];
  }
  // cm:guard the ISS-598 wedge query also selects FROM issues, so it must be routed off its pipeline_runs / LATERAL join BEFORE the generic issues check below, or the stuck-issue branch swallows it.
  if (/pipeline_runs/i.test(firstSql) || /lateral/i.test(firstSql)) {
    return wedgeQueue.shift() ?? [];
  }
  if (/from\s+issues/i.test(firstSql)) {
    return stuckQueue.shift() ?? [];
  }
  if (/from\s+pipeline_outbox/i.test(firstSql)) {
    return staleCountQueue.shift() ?? [{ count: 0 }];
  }
  // cm:guard this branch must stay BELOW the `from issues` one: the stuck-issue query carries `FROM jobs j` inside its NOT EXISTS, so a jobs-first router swallows it and every test sees an empty stuck list. Default is "a job appeared", the successful-rescue case.
  if (/from\s+jobs/i.test(firstSql)) {
    return jobsQueue.shift() ?? [{ one: 1 }];
  }
  return [];
});

export const reEnqueueMock = vi.fn(async () => undefined);
export const stallGuardMock = vi.fn(async () => ({ stalled: false }));
export const capMock = vi.fn(async () => ({
  capped: false,
  runId: 'run-a1' as string | null,
}));
export const recordRescueMock = vi.fn(async () => undefined);
export const applyStatusTransitionMock = vi.fn(async () => undefined);
export const sentryAddBreadcrumb = vi.fn();

export function resetHarness(): void {
  stuckQueue.length = 0;
  staleCountQueue.length = 0;
  wedgeQueue.length = 0;
  autonomousWedgeQueue.length = 0;
  jobsQueue.length = 0;
  dbExecute.mockClear();
  reEnqueueMock.mockReset();
  reEnqueueMock.mockResolvedValue(undefined);
  stallGuardMock.mockReset();
  stallGuardMock.mockResolvedValue({ stalled: false });
  capMock.mockReset();
  capMock.mockResolvedValue({ capped: false, runId: 'run-a1' });
  recordRescueMock.mockReset();
  recordRescueMock.mockResolvedValue(undefined);
  applyStatusTransitionMock.mockReset();
  applyStatusTransitionMock.mockResolvedValue(undefined);
  sentryAddBreadcrumb.mockClear();
}

/** Every pass idle but the one under test, so a tick reaches it with no noise. */
export function seedIdle(): void {
  stuckQueue.push([]);
  staleCountQueue.push([{ count: 0 }]);
  wedgeQueue.push([]);
  autonomousWedgeQueue.push([]);
}
