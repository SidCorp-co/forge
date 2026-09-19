/**
 * ISS-162 — Stateless Gates picker tests. The picker evaluates L1/L2/L3/L4/L5
 * inline via SQL. ISS-198 added L4 (device_load CTE) and L5
 * (fresh_capable_runners' last_seen_at predicate) to the same query; the
 * `checkLayer4RunnerFull` + `checkLayer5RunnerHeartbeat` helpers remain for
 * telemetry parity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
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
  assertDispatchable,
  freshRunnerAvailability,
  gateReasonsForQueuedJobs,
  countInFlightForRunner,
} = await import('./queued-gates.js');

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
  const where = () => ({ limit: async () => rows });
  dbSelect.mockImplementationOnce(() => ({
    from: () => ({ where, innerJoin: () => ({ where }) }),
  }));
}

function mockAssertChain(opts: {
  job: { projectId: string } | null;
  caseResult: { reason: string | null } | null | undefined;
}): void {
  selectChainOnce(opts.job ? [opts.job] : []);
  if (!opts.job) return;
  dbExecute.mockResolvedValueOnce(opts.caseResult ? [opts.caseResult] : []);
}

describe('countInFlightForRunner', () => {
  it('returns 0 when no rows match', async () => {
    dbExecute.mockResolvedValueOnce([{ count: '0' }]);
    expect(await countInFlightForRunner('r1')).toBe(0);
  });
  it('coerces the count to a number', async () => {
    dbExecute.mockResolvedValueOnce([{ n: '7' }]);
    expect(await countInFlightForRunner('r1')).toBe(7);
  });
  it('joins pipeline_runs and filters to running|paused parents', async () => {
    dbExecute.mockResolvedValueOnce([{ n: '0' }]);
    await countInFlightForRunner('r1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/LEFT\s+JOIN\s+pipeline_runs\s+pr\s+ON\s+pr\.id\s*=\s*j\.pipeline_run_id/);
    expect(text).toMatch(/pr\.status\s+IN\s*\(\s*'running'\s*,\s*'paused'\s*\)/);
  });
});

describe('the `held` asymmetry (RFC 0002)', () => {
  it('sits in the issue-busy arm, and no CTE counts load at all', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await gateReasonsForQueuedJobs('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    const issueBusy = text.match(
      /FROM\s+jobs\s+other[\s\S]*?other\.status\s+IN\s*\(([^)]*)\)/,
    )?.[1];

    expect(issueBusy).toBeTruthy();
    expect(issueBusy).toContain("'held'");

    expect(text).not.toMatch(/device_load/);
    expect(text).not.toMatch(/\bin_flight\b/);
  });
});

describe('assertDispatchable', () => {
  it('returns not_found when the job row is missing', async () => {
    mockAssertChain({ job: null, caseResult: undefined });
    const r = await assertDispatchable('missing');
    expect(r).toEqual({ ok: false, reason: 'not_found', hint: 'missing' });
  });

  it('returns ok:true when the CASE expression returns NULL (all gates pass)', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      caseResult: { reason: null },
    });
    expect(await assertDispatchable('j1')).toEqual({ ok: true });
  });

  it('returns ok:false with the failing reason verbatim from the CASE', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      caseResult: { reason: 'issue_busy' },
    });
    expect(await assertDispatchable('j1')).toEqual({ ok: false, reason: 'issue_busy' });
  });

  it('returns not_found when the CASE query returns 0 rows (race: job vanished mid-call)', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      caseResult: undefined,
    });
    expect(await assertDispatchable('j1')).toEqual({ ok: false, reason: 'not_found', hint: 'j1' });
  });

  it('SQL enumerates every GateSkipReason in the CASE', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      caseResult: { reason: null },
    });
    await assertDispatchable('j1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/'not_queued'/);
    expect(text).toMatch(/'pipeline_run_not_running'/);
    expect(text).not.toMatch(/'manual_hold'/);
    expect(text).toMatch(/'retry_cooldown'/);
    expect(text).toMatch(/'issue_busy'/);
    expect(text).not.toMatch(/'stale_trigger'/);
    expect(text).not.toMatch(/'blocked_by'/);
    expect(text).not.toMatch(/'project_cap'/);
    expect(text).not.toMatch(/'release_decompose_pending'/);
    expect(text).not.toMatch(/'decompose_children_pending'/);
    expect(text).not.toMatch(/'runner_full'/);
    expect(text).toMatch(/'runner_stale'/);
    expect(text).toMatch(/'runner_too_old'/);
  });

  it('reports a too-old fleet as too old rather than as no fleet at all', async () => {
    mockAssertChain({ job: { projectId: 'p1' }, caseResult: { reason: null } });
    await assertDispatchable('j1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text.indexOf("'runner_stale'")).toBeLessThan(text.indexOf("'runner_too_old'"));
    expect(text).not.toMatch(/\bin_flight\b/);
    expect(text).not.toMatch(/\bAS cap\b/);
  });

  it('SQL joins jobs/issues/pipeline_runs the way both readers do', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      caseResult: { reason: null },
    });
    await assertDispatchable('j1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/FROM\s+jobs\s+j/);
    expect(text).toMatch(/LEFT\s+JOIN\s+issues\s+i\s+ON\s+i\.id\s*=\s*j\.issue_id/);
    expect(text).toMatch(/JOIN\s+pipeline_runs\s+r\s+ON\s+r\.id\s*=\s*j\.pipeline_run_id/);
    expect(text).toMatch(/WHERE\s+j\.id\s*=/);
  });

  it('parity: both readers share the same CTEs + EXISTS predicates', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await gateReasonsForQueuedJobs('p-parity');
    const reasonsSql = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    vi.clearAllMocks();
    mockAssertChain({ job: { projectId: 'p-parity' }, caseResult: { reason: null } });
    await assertDispatchable('j-parity');
    const asserterSql = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    const signatures = [
      /fresh_capable_runners\s+AS\s*\(/,
      /r\.last_seen_at\s*>\s*now\(\)/,
      /FROM\s+agent_sessions\s+s/,
      /FROM\s+jobs\s+other/,
    ];
    for (const re of signatures) {
      expect(reasonsSql, `reasons reader missing ${re}`).toMatch(re);
      expect(asserterSql, `asserter missing ${re}`).toMatch(re);
    }

    expect(reasonsSql).not.toMatch(/running_ids/);
    expect(asserterSql).not.toMatch(/running_ids/);
    expect(reasonsSql).not.toMatch(/device_load/);
    expect(asserterSql).not.toMatch(/device_load/);
  });
});

describe('gateReasonsForQueuedJobs', () => {
  it('maps only the gated jobs, leaving dispatchable ones out', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'j1', reason: 'issue_busy' },
      { id: 'j2', reason: null },
      { id: 'j3', reason: 'runner_stale' },
    ]);

    const gates = await gateReasonsForQueuedJobs('p1');

    expect(gates.get('j1')).toBe('issue_busy');
    expect(gates.get('j3')).toBe('runner_stale');
    expect(gates.has('j2')).toBe(false);
    expect(gates.size).toBe(2);
  });

  it('returns an empty map when the project has no queued jobs', async () => {
    dbExecute.mockResolvedValueOnce([]);

    expect((await gateReasonsForQueuedJobs('p1')).size).toBe(0);
  });

  it('scopes the scan to the project and to queued jobs', async () => {
    dbExecute.mockResolvedValueOnce([]);

    await gateReasonsForQueuedJobs('proj-x');

    const rendered = JSON.stringify(dbExecute.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain('proj-x');
    expect(rendered).toContain('queued');
  });
});

describe('freshRunnerAvailability', () => {
  it('returns the claim-capable runner count and nothing else', async () => {
    dbExecute.mockResolvedValueOnce([{ total: 3 }]);

    expect(await freshRunnerAvailability('p1')).toEqual({ total: 3 });
  });

  it('reads an empty result as no runners at all', async () => {
    dbExecute.mockResolvedValueOnce([]);

    expect(await freshRunnerAvailability('p1')).toEqual({ total: 0 });
  });

  it('counts from the barrier builder’s CTE, scoped to the project', async () => {
    dbExecute.mockResolvedValueOnce([{ total: 0, with_capacity: 0 }]);

    await freshRunnerAvailability('proj-y');

    const rendered = JSON.stringify(dbExecute.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain('fresh_capable_runners');
    expect(rendered).toContain('proj-y');
  });
});
