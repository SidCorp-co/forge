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

/**
 * `resolveProjectCap` (re-added) does ONE `db.select().from().where().limit()`
 * to read `projects.agent_config` before the picker/asserter runs its
 * `db.execute` SQL. Queue the project row this lookup should return: pass an
 * `agentConfig`-shaped object (e.g. `{ pipelineConfig: { maxConcurrentIssues: 3 } }`),
 * or `null` to simulate a missing project (→ DEFAULT cap). Each
 * `pickNextDispatchableJobForProject` / `assertDispatchable` call consumes
 * exactly one queued row, so it never leaks into later `dbSelect`-based tests.
 */

// cm:why the cap read and the CASE row are queued ONLY when `job` is non-null, mirroring the asserter's short-circuit to not_found — queueing them unconditionally leaves two stubs unconsumed, and vitest carries a `mockResolvedValueOnce` queue across tests
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
  // cm:guard ISS-258 — a job under a TERMINAL parent run must not count toward a runner's load; an orphan that still counts burns a slot nothing will ever free.
  it('joins pipeline_runs and filters to running|paused parents', async () => {
    dbExecute.mockResolvedValueOnce([{ n: '0' }]);
    await countInFlightForRunner('r1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/LEFT\s+JOIN\s+pipeline_runs\s+pr\s+ON\s+pr\.id\s*=\s*j\.pipeline_run_id/);
    expect(text).toMatch(/pr\.status\s+IN\s*\(\s*'running'\s*,\s*'paused'\s*\)/);
  });
});

describe('the `held` asymmetry (RFC 0002)', () => {
  // cm:guard assert BOTH arms together, never one alone — `held` in the issue-busy arm only stops a second job for the same issue, while `held` absent from `device_load` is the entire reason it may wait indefinitely; add it to that CTE and one held job burns a runner slot forever, which is the `waiting` park RFC 0002 deletes, moved one axis down
  // cm:edge lockstep -> packages/core/src/devices/claim.ts — L1 there lists the same three statuses, and it is the arm that actually REFUSES rather than merely explains; a status added here and not there reports a block the claim does not enforce
  it('sits in the issue-busy arm but NOT in device_load', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await gateReasonsForQueuedJobs('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    const issueBusy = text.match(
      /FROM\s+jobs\s+other[\s\S]*?other\.status\s+IN\s*\(([^)]*)\)/,
    )?.[1];
    const deviceLoad = text.match(/device_load\s+AS\s*\(([\s\S]*?)\)\s*,/)?.[1];

    // cm:guard keep these positive assertions — a regex that stopped matching leaves the slice `undefined`, and the `not.toContain` below then passes on nothing, so the test would go green precisely when the SQL it guards was rewritten
    expect(issueBusy).toBeTruthy();
    expect(deviceLoad).toBeTruthy();
    expect(deviceLoad).toContain("'dispatched'");

    expect(issueBusy).toContain("'held'");
    expect(deviceLoad).not.toContain("'held'");
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
      caseResult: { reason: 'project_cap' },
    });
    expect(await assertDispatchable('j1')).toEqual({ ok: false, reason: 'project_cap' });
  });

  it('returns not_found when the CASE query returns 0 rows (race: job vanished mid-call)', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      caseResult: undefined,
    });
    expect(await assertDispatchable('j1')).toEqual({ ok: false, reason: 'not_found', hint: 'j1' });
  });

  // cm:guard every reason must appear in the SQL text, because `dispatch_barrier_skips_total{reason}` is keyed by it — an arm renamed without this test going red silently splits one metric series into two.
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
    expect(text).toMatch(/'stale_trigger'/);
    // cm:why asserting the ABSENCE of these two is the point: `blocked_by` and `project_cap` were the gates this design deleted, and a CASE arm reappearing under either name is a routing decision moving back into the kernel
    expect(text).not.toMatch(/'blocked_by'/);
    expect(text).not.toMatch(/'project_cap'/);
    // cm:why asserting the ABSENCE of `release_decompose_pending` is the only way this stays fixed — it sat in `GateSkipReason` for months naming an arm the CASE never had, and `assertDispatchable` casts the raw reason into that union, so tsc cannot tell a member from a fiction
    expect(text).not.toMatch(/'release_decompose_pending'/);
    // cm:why the decompose parent gate was removed with the lifecycle in 2026-09; a CASE arm reappearing under either name is a mechanism nobody decided to bring back
    expect(text).not.toMatch(/'decompose_children_pending'/);
    expect(text).toMatch(/'runner_stale'/);
    expect(text).toMatch(/'runner_full'/);
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

  // cm:guard capture BOTH readers in one run and compare — they inherit their CTEs and EXISTS predicates from `buildBarrierFragments`, so this is what stops a fragment edited for one of them silently leaving the other behind.
  it('parity: both readers share the same CTEs + EXISTS predicates', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await gateReasonsForQueuedJobs('p-parity');
    const reasonsSql = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    vi.clearAllMocks();
    mockAssertChain({ job: { projectId: 'p-parity' }, caseResult: { reason: null } });
    await assertDispatchable('j-parity');
    const asserterSql = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    const signatures = [
      /device_load\s+AS\s*\(/,
      /fresh_capable_runners\s+AS\s*\(/,
      /r\.last_seen_at\s*>\s*now\(\)/,
      /FROM\s+agent_sessions\s+s/,
      /FROM\s+jobs\s+other/,
      /payload->>'stageStatus'/,
    ];
    for (const re of signatures) {
      expect(reasonsSql, `reasons reader missing ${re}`).toMatch(re);
      expect(asserterSql, `asserter missing ${re}`).toMatch(re);
    }

    // cm:guard assert the ABSENCE of `running_ids` on both sides — that CTE existed only to count a project's concurrent issues against a cap, and the cap is what this design removed; a reader that reintroduces it has put the ceiling back where the master cannot see it
    expect(reasonsSql).not.toMatch(/running_ids/);
    expect(asserterSql).not.toMatch(/running_ids/);
  });
});

// cm:guard this and `assertDispatchable` MUST take their CASE from the one builder — the arm ORDER is the answer they return, so two copies report a different "most specific reason" for the same job and the surfaces that read them start contradicting each other
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

  // cm:guard the batch query must stay scoped to `status='queued'` — a dispatched or running job has no gate to report, and including one would label live work with the reason it passed on its way out of the queue
  it('scopes the scan to the project and to queued jobs', async () => {
    dbExecute.mockResolvedValueOnce([]);

    await gateReasonsForQueuedJobs('proj-x');

    const rendered = JSON.stringify(dbExecute.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain('proj-x');
    expect(rendered).toContain('queued');
  });
});

describe('freshRunnerAvailability', () => {
  it('returns the two runner counts', async () => {
    dbExecute.mockResolvedValueOnce([{ total: 3, with_capacity: 1 }]);

    expect(await freshRunnerAvailability('p1')).toEqual({ total: 3, withCapacity: 1 });
  });

  // cm:guard an empty pool must read as 0/0, never as an absent row the caller coerces to "available" — pipelineHealth turns total>0 into "waiting for a slot" and total===0 into "no runner is online", opposite verdicts
  it('reads an empty result as no runners at all', async () => {
    dbExecute.mockResolvedValueOnce([]);

    expect(await freshRunnerAvailability('p1')).toEqual({ total: 0, withCapacity: 0 });
  });

  // cm:guard it must read `fresh_capable_runners`, not a local copy of the availability WHERE — a second copy is how pipelineHealth came to disagree with the gate and report nothing for 11 jobs stuck behind dead runners
  it('counts from the barrier builder’s CTE, scoped to the project', async () => {
    dbExecute.mockResolvedValueOnce([{ total: 0, with_capacity: 0 }]);

    await freshRunnerAvailability('proj-y');

    const rendered = JSON.stringify(dbExecute.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain('fresh_capable_runners');
    expect(rendered).toContain('proj-y');
  });
});
