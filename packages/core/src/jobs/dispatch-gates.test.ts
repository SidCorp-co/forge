/**
 * ISS-162 — Stateless Gates picker tests. The picker evaluates L1/L2/L3/L4/L5
 * inline via SQL. ISS-198 added L4 (runner_load CTE) and L5
 * (fresh_capable_runners' last_seen_at predicate) to the same query; the
 * `checkLayer4RunnerFull` + `checkLayer5RunnerHeartbeat` helpers remain for
 * telemetry parity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async () => [] as unknown[]);
const dbSelect = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    execute: dbExecute,
    select: dbSelect,
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  checkLayer4RunnerFull,
  checkLayer5RunnerHeartbeat,
  pickNextDispatchableJobForProject,
  countInFlightForRunner,
  DEFAULT_MAX_CONCURRENT_ISSUES,
} = await import('./dispatch-gates.js');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

function collectSqlFragments(sqlArg: unknown): string {
  const fragments: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      fragments.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node && typeof node === 'object') {
      const value = (node as { value?: unknown }).value;
      if (typeof value === 'string') fragments.push(value);
      else if (Array.isArray(value)) visit(value);
      const chunks = (node as { queryChunks?: unknown }).queryChunks;
      if (chunks) visit(chunks);
    }
  };
  visit(sqlArg);
  return fragments.join(' ');
}

function selectChainOnce(rows: unknown[]): void {
  dbSelect.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({ limit: async () => rows }),
    }),
  }));
}

function mockProjectAgentConfigOnce(value: Record<string, unknown> | null): void {
  selectChainOnce([{ agentConfig: value }]);
}

describe('checkLayer4RunnerFull', () => {
  function runnerCapsOnce(value: { type: string; capabilities: Record<string, unknown> } | null): void {
    selectChainOnce(value ? [value] : []);
  }

  it('passes when runner row vanished (race)', async () => {
    runnerCapsOnce(null);
    const r = await checkLayer4RunnerFull('r-x');
    expect(r.pass).toBe(true);
  });

  it('passes when in-flight < cap', async () => {
    runnerCapsOnce({ type: 'claude-code', capabilities: { maxConcurrent: 3 } });
    dbExecute.mockResolvedValueOnce([{ count: '1' }]);
    const r = await checkLayer4RunnerFull('r1');
    expect(r.pass).toBe(true);
  });

  it('fails when in-flight reaches cap', async () => {
    runnerCapsOnce({ type: 'claude-code', capabilities: { maxConcurrent: 2 } });
    dbExecute.mockResolvedValueOnce([{ count: '2' }]);
    const r = await checkLayer4RunnerFull('r1');
    expect(r).toMatchObject({ pass: false, reason: 'runner_full' });
  });

  it('uses antigravity default of 5 when capability missing', async () => {
    runnerCapsOnce({ type: 'antigravity', capabilities: {} });
    dbExecute.mockResolvedValueOnce([{ count: '4' }]);
    const r = await checkLayer4RunnerFull('r1');
    expect(r.pass).toBe(true);
  });
});

describe('countInFlightForRunner', () => {
  it('returns 0 when no rows match', async () => {
    dbExecute.mockResolvedValueOnce([{ count: '0' }]);
    expect(await countInFlightForRunner('r1')).toBe(0);
  });
  it('coerces text count to number', async () => {
    dbExecute.mockResolvedValueOnce([{ count: '7' }]);
    expect(await countInFlightForRunner('r1')).toBe(7);
  });
});

describe('pickNextDispatchableJobForProject', () => {
  it('returns null when no rows', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    expect(await pickNextDispatchableJobForProject('p1')).toBeNull();
  });

  it('returns the first row when present', async () => {
    mockProjectAgentConfigOnce({ pipelineConfig: { maxConcurrentIssues: 3 } });
    dbExecute.mockResolvedValueOnce([
      { id: 'j1', projectId: 'p1', issueId: 'i1', status: 'queued' },
    ]);
    const r = await pickNextDispatchableJobForProject('p1');
    expect(r).toMatchObject({ id: 'j1' });
  });

  it('falls back to DEFAULT_MAX_CONCURRENT_ISSUES when config is missing', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    // The cap is passed as a parameter, so the literal won't appear in the SQL
    // string itself — but the default is exposed as a constant for callers.
    // Default is 1 so unconfigured projects serialize jobs by default and
    // can't race two in-flight code sessions into merge conflicts.
    expect(DEFAULT_MAX_CONCURRENT_ISSUES).toBe(1);
    expect(text).toMatch(/SELECT\s+j\.\*/);
  });

  // Snapshot the generated SQL so each gate clause is provably inline.
  it('SQL inlines L1 (issue_busy + manual_hold), L2 (blocks + decomposes), L3 (project cap)', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    // L1 — issue_busy via session + sibling-job NOT EXISTS, manual_hold inline
    expect(text).toMatch(/i\.manual_hold\s+IS\s+NOT\s+TRUE/);
    expect(text).toMatch(/FROM\s+agent_sessions\s+s/);
    expect(text).toMatch(/s\.metadata->>'issueId'/);
    expect(text).toMatch(/FROM\s+jobs\s+other/);
    expect(text).toMatch(/other\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);

    // L2 — blocks parents non-terminal AND decompose parent non-released
    expect(text).toMatch(/d\.kind\s*=\s*'blocks'/);
    expect(text).toMatch(/d2\.kind\s*=\s*'decomposes'/);
    expect(text).toMatch(/p\.status\s+NOT\s+IN\s*\(\s*'released'\s*,\s*'closed'\s*\)/);

    // L3 — running_ids CTE + cap comparison
    expect(text).toMatch(/WITH\s+running_ids/i);
    expect(text).toMatch(/SELECT\s+COUNT\(\*\)\s+FROM\s+running_ids/);
    expect(text).toMatch(/j\.issue_id::text\s+IN\s*\(\s*SELECT\s+issue_id\s+FROM\s+running_ids\s*\)/);
  });

  // Cohesion + ISS-102 defence: pause/resume/cancel ride on `r.status='running'`.
  it('JOINs pipeline_runs, filters running, and orders by run.started_at then queued_at (cohesion)', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/JOIN\s+pipeline_runs\s+r\s+ON\s+r\.id\s*=\s*j\.pipeline_run_id/);
    expect(text).toMatch(/r\.status\s*=\s*'running'/);
    const priorityIdx = text.search(/CASE\s+COALESCE\(i\.priority/);
    const runStartedIdx = text.search(/r\.started_at\s+ASC/);
    const queuedAtIdx = text.search(/j\.queued_at\s+ASC/);
    expect(priorityIdx).toBeGreaterThanOrEqual(0);
    expect(runStartedIdx).toBeGreaterThan(priorityIdx);
    expect(queuedAtIdx).toBeGreaterThan(runStartedIdx);
  });

  it('only running pipeline_runs feed the picker — never paused/cancelled/failed/completed (ISS-102)', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/r\.status\s*=\s*'running'/);
    // `\b` rules out substrings like `other.status IN ...` which would
    // otherwise match `r.status IN` via the trailing `r` in `other`.
    expect(text).not.toMatch(/\br\.status\s*<>/);
    expect(text).not.toMatch(/\br\.status\s+IN/i);
  });

  // ISS-162 acceptance: the picker must contain NO time-based debouncer.
  // The only legitimate temporal predicates are:
  //   • `valid_until > now()` on dependency edges (edge expiry)
  //   • `retry_after_at <= now()` on jobs (ISS-197 cooldown gate — the
  //     retry engine sets a future timestamp to honour provider
  //     Retry-After; the DB-side gate hides the row until it lapses).
  //   • `last_seen_at > now() - liveness_seconds` (ISS-198 Gate L5 —
  //     runner heartbeat freshness in fresh_capable_runners).
  // A future contributor adding `gate_at + N seconds` or a generic
  // "seen N seconds ago" exclusion should trip this assertion deliberately.
  it('contains no time-based debouncer beyond dependency-edge expiry, retry_after_at, and L5 heartbeat', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    expect(text).not.toMatch(/gate_at/);
    expect(text).not.toMatch(/gate_reason/);

    // Strip the dependency-edge valid_until, retry_after_at cooldown, the
    // L5 heartbeat clauses, and the running_ids cooldown-pending union
    // (added so an issue in retry cooldown holds the cap slot); whatever
    // remains must not contain any `now() - interval` or `seconds` predicate.
    const stripped = text
      .replace(/valid_until\s+IS\s+NULL\s+OR\s+valid_until\s*>\s*now\(\)/g, '')
      .replace(/j\.retry_after_at\s+IS\s+NULL\s+OR\s+j\.retry_after_at\s*<=\s*now\(\)/g, '')
      .replace(/retry_after_at\s+IS\s+NOT\s+NULL\s+AND\s+retry_after_at\s*>\s*now\(\)/g, '')
      .replace(/r\.last_seen_at\s*>\s*now\(\)[^)]+/g, '');
    expect(stripped).not.toMatch(/now\(\)\s*-\s*interval/);
    expect(stripped).not.toMatch(/seconds/i);
  });

  // ISS-198 — L4 (runner_load) + L5 (fresh_capable_runners) inline.
  it('SQL inlines L4 runner_load CTE and L5 fresh_capable_runners heartbeat filter', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    expect(text).toMatch(/runner_load/);
    expect(text).toMatch(/fresh_capable_runners/);
    expect(text).toMatch(/r\.last_seen_at\s*>\s*now\(\)/);
    expect(text).toMatch(/fcr\.in_flight\s*<\s*fcr\.cap/);
  });

  // Strict per-cap serialization: an issue in retry cooldown must hold its
  // cap slot, so an unrelated issue's queued job can't slip in during the
  // cooldown window. Without this, a worker-wide failure (session/usage
  // limit, provider 429 with long Retry-After) lets the next queued issue
  // hit the same limit and fail too.
  it('running_ids CTE includes cooldown-pending retries so other issues are gated', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    // The CTE must UNION cooldown-pending rows alongside the agent_session
    // membership rows; the cooldown-pending branch reads from `jobs`
    // (scoped to the same project as the surrounding picker query) and
    // selects rows whose `retry_after_at` is still in the future.
    expect(text).toMatch(/WITH\s+running_ids\s+AS[\s\S]+UNION[\s\S]+FROM\s+jobs[\s\S]+retry_after_at\s+IS\s+NOT\s+NULL[\s\S]+retry_after_at\s*>\s*now\(\)/i);
  });
});

describe('checkLayer5RunnerHeartbeat', () => {
  it('passes when the runner row is absent (race tolerant)', async () => {
    selectChainOnce([]);
    const r = await checkLayer5RunnerHeartbeat('r-x');
    expect(r.pass).toBe(true);
  });

  it('fails when last_seen_at is NULL (never pinged)', async () => {
    selectChainOnce([{ lastSeenAt: null }]);
    const r = await checkLayer5RunnerHeartbeat('r1');
    expect(r).toMatchObject({ pass: false, reason: 'runner_stale' });
  });

  it('fails when last_seen_at is older than the liveness window', async () => {
    const ancient = new Date(Date.now() - 5 * 60_000);
    selectChainOnce([{ lastSeenAt: ancient }]);
    const r = await checkLayer5RunnerHeartbeat('r1');
    expect(r).toMatchObject({ pass: false, reason: 'runner_stale' });
  });

  it('passes when last_seen_at is fresh', async () => {
    selectChainOnce([{ lastSeenAt: new Date() }]);
    const r = await checkLayer5RunnerHeartbeat('r1');
    expect(r.pass).toBe(true);
  });

  // ISS-197 — verify the picker emits the retry_after_at cooldown gate.
  it('SQL inlines the retry_after_at cooldown gate (ISS-197)', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(
      /j\.retry_after_at\s+IS\s+NULL\s+OR\s+j\.retry_after_at\s*<=\s*now\(\)/,
    );
  });
});
