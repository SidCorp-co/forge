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
  // cm:guard assert BOTH halves together, never one alone — `held` in the issue-busy arm only stops a second job for the same issue, while NO load count existing anywhere in this builder is the entire reason a held job may wait indefinitely; reintroduce a load CTE that counts `held` and one held job occupies a box forever, which is the `waiting` park RFC 0002 deletes, moved one axis down
  // cm:edge lockstep -> packages/core/src/devices/claim.ts — L1 there lists the same three statuses, and it is the arm that actually REFUSES rather than merely explains; a status added here and not there reports a block the claim does not enforce
  it('sits in the issue-busy arm, and no CTE counts load at all', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await gateReasonsForQueuedJobs('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    const issueBusy = text.match(
      /FROM\s+jobs\s+other[\s\S]*?other\.status\s+IN\s*\(([^)]*)\)/,
    )?.[1];

    // cm:guard keep this positive assertion — a regex that stopped matching leaves the slice `undefined`, and the `toContain` below then passes on nothing, so the test would go green precisely when the SQL it guards was rewritten
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
    // cm:why `runner_full` belongs with these two: core enforces no job ceiling since the master began claiming from the pool, so the arm could only report a hold nothing applies — an operator sent to wait for a slot that was never occupied. A capacity arm reappearing here is the kernel deciding capacity again.
    expect(text).not.toMatch(/'runner_full'/);
    expect(text).toMatch(/'runner_stale'/);
    expect(text).toMatch(/'runner_too_old'/);
  });

  // cm:guard the ORDER is the assertion, not the presence. `runner_stale` matches whenever the CTE is empty, and a below-floor box IS in the CTE — so an arm placed after it would be dead code, and every too-old fleet would keep reporting "no runner is online" about hosts whose heartbeats are green. Measured 2026-09-05: dev1 served 20 projects at 0.10.5 against a 0.11.0 floor.
  it('reports a too-old fleet as too old rather than as no fleet at all', async () => {
    mockAssertChain({ job: { projectId: 'p1' }, caseResult: { reason: null } });
    await assertDispatchable('j1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text.indexOf("'runner_stale'")).toBeLessThan(text.indexOf("'runner_too_old'"));
    // cm:guard the CTE must carry NO capacity column at all. `cap` and `in_flight` were the two the deleted arm read, and re-adding either is how a capacity arm gets written back: the column arrives first, looking harmless, and the CASE follows.
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
    // cm:guard `device_load` goes with `running_ids` for the same reason one axis over — it counted a box's jobs against a cap core no longer enforces, so a reader that brings it back has put a ceiling where neither the master nor the runner can see it
    expect(reasonsSql).not.toMatch(/device_load/);
    expect(asserterSql).not.toMatch(/device_load/);
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
  it('returns the claim-capable runner count and nothing else', async () => {
    dbExecute.mockResolvedValueOnce([{ total: 3 }]);

    expect(await freshRunnerAvailability('p1')).toEqual({ total: 3 });
  });

  // cm:guard an empty pool must read as 0, never as an absent row the caller coerces to "available" — pipelineHealth turns total===0 into "no runner is online" and anything else into no reason at all, opposite verdicts
  it('reads an empty result as no runners at all', async () => {
    dbExecute.mockResolvedValueOnce([]);

    expect(await freshRunnerAvailability('p1')).toEqual({ total: 0 });
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
