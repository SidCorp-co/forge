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
  assertDispatchable,
  checkLayer4RunnerFull,
  checkLayer5RunnerHeartbeat,
  pickNextDispatchableJobForProject,
  countInFlightForRunner,
  hasNonTerminalPriorSession,
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

/**
 * ISS-232 Phase 3 — `pickNextDispatchableJobForProject` and
 * `assertDispatchable` no longer do a project lookup to resolve the cap
 * (it's hardcoded). Keeping this helper as a no-op so existing call sites
 * still compile, but queueing a `selectChainOnce` here would leak past
 * its test and break subsequent `checkLayer5RunnerHeartbeat` tests that
 * share the same `dbSelect` mock queue.
 */
function mockProjectAgentConfigOnce(_value: Record<string, unknown> | null): void {
  // No-op since Phase 3 removed `resolveProjectCap`.
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

  it('passes when in-flight < cap=1', async () => {
    runnerCapsOnce({ type: 'claude-code', capabilities: {} });
    dbExecute.mockResolvedValueOnce([{ count: '0' }]);
    const r = await checkLayer4RunnerFull('r1');
    expect(r.pass).toBe(true);
  });

  it('fails when in-flight reaches cap=1', async () => {
    runnerCapsOnce({ type: 'claude-code', capabilities: {} });
    dbExecute.mockResolvedValueOnce([{ count: '1' }]);
    const r = await checkLayer4RunnerFull('r1');
    expect(r).toMatchObject({ pass: false, reason: 'runner_full' });
  });

  // ISS-232 Phase 2 — antigravity cap collapsed to 1 (was 5). The
  // capabilities.maxConcurrent override was also removed; cap is hardcoded.
  it('uses cap=1 for antigravity (no longer 5)', async () => {
    runnerCapsOnce({ type: 'antigravity', capabilities: { maxConcurrent: 9 } });
    dbExecute.mockResolvedValueOnce([{ count: '1' }]);
    const r = await checkLayer4RunnerFull('r1');
    expect(r).toMatchObject({ pass: false, reason: 'runner_full' });
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

    // L2 — git-aware (ISS-232). Replaces the prior status-based check with
    // `merged_at IS NULL` so the gate defers to the state-machine writer
    // (see `issues/merged-at.ts`).
    expect(text).toMatch(/d\.kind\s*=\s*'blocks'/);
    expect(text).toMatch(/d2\.kind\s*=\s*'decomposes'/);
    expect(text).toMatch(/p\.merged_at\s+IS\s+NULL/);
    expect(text).toMatch(/p2\.merged_at\s+IS\s+NULL/);
    expect(text).not.toMatch(/p\.status\s+NOT\s+IN\s*\(/);

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
  // ISS-232 Phase 2 — `running_ids` is now sourced exclusively from
  // `jobs`. Dispatched/running jobs hold the slot directly; queued jobs
  // with `retry_after_at` in the future also hold it so a worker-wide
  // failure (session/usage limit, provider 429) can't release the slot
  // for an unrelated issue during the cooldown window. The prior
  // `agent_sessions` UNION is dropped — the jobs table is the
  // authoritative ledger.
  it('running_ids CTE is sourced from jobs (queued retry-pending + dispatched + running) — no agent_sessions UNION', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    // Branch 1: dispatched/running jobs counted.
    expect(text).toMatch(
      /running_ids\s+AS\s*\([\s\S]+FROM\s+jobs[\s\S]+status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/,
    );
    // Branch 2: queued + retry_after_at in future still counted.
    expect(text).toMatch(
      /retry_after_at\s+IS\s+NOT\s+NULL[\s\S]+retry_after_at\s*>\s*now\(\)/,
    );
    // No agent_sessions in the CTE — the picker still uses agent_sessions
    // elsewhere (L1 issueBusySession), but not for running_ids.
    const cteMatch = text.match(/running_ids\s+AS\s*\(([\s\S]*?)\)\s*,/);
    expect(cteMatch).not.toBeNull();
    expect(cteMatch?.[1] ?? '').not.toMatch(/agent_sessions/);
  });

  // ISS-232 Phase 2 — runner cap unified to 1; `capabilities.maxConcurrent`
  // override + antigravity 5-slot CASE removed.
  it('fresh_capable_runners CTE uses cap=1 (no maxConcurrent override, no antigravity CASE)', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/fresh_capable_runners\s+AS\s*\([\s\S]+1\s+AS\s+cap/);
    expect(text).not.toMatch(/capabilities->>\s*'maxConcurrent'/);
    expect(text).not.toMatch(/CASE\s+r\.type/);
  });
});

describe('hasNonTerminalPriorSession', () => {
  it('returns false when no non-terminal sessions match the issue', async () => {
    dbExecute.mockResolvedValueOnce([]);
    expect(await hasNonTerminalPriorSession('iss-201')).toBe(false);
  });

  it('returns true when at least one running session exists for the issue', async () => {
    dbExecute.mockResolvedValueOnce([{ '?column?': 1 }]);
    expect(await hasNonTerminalPriorSession('iss-201')).toBe(true);
  });

  it('returns true when a queued session exists for the issue', async () => {
    dbExecute.mockResolvedValueOnce([{ '?column?': 1 }]);
    expect(await hasNonTerminalPriorSession('iss-201')).toBe(true);
  });

  it('SQL filters on status IN (queued, running) — never widens to terminal statuses', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await hasNonTerminalPriorSession('iss-201');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/status\s+IN\s*\(\s*'queued'\s*,\s*'running'\s*\)/);
    // Lockstep with picker L1 — must not include terminal statuses.
    expect(text).not.toMatch(/'completed'/);
    expect(text).not.toMatch(/'failed'/);
    expect(text).not.toMatch(/'completed_via_recovery'/);
    expect(text).not.toMatch(/'cancelled_stale'/);
    expect(text).toMatch(/metadata->>'issueId'/);
  });

  it('emits AND id <> $1 when excludeSessionId is provided', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await hasNonTerminalPriorSession('iss-201', 'sess-self');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/AND\s+id\s*<>/);
  });

  it('omits AND id <> when excludeSessionId is null/undefined', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await hasNonTerminalPriorSession('iss-201');
    const text1 = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text1).not.toMatch(/AND\s+id\s*<>/);

    dbExecute.mockResolvedValueOnce([]);
    await hasNonTerminalPriorSession('iss-201', null);
    const text2 = collectSqlFragments(dbExecute.mock.calls[1]?.[0]);
    expect(text2).not.toMatch(/AND\s+id\s*<>/);
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

// ISS-228 — assertDispatchable mirrors the picker's full gate set so the
// pg-boss-direct path (`handleDispatch` / `handlePmDispatch`) enforces the
// same invariants the picker does on every tick.
describe('assertDispatchable', () => {
  function mockAssertChain(opts: {
    job: { projectId: string } | null;
    /** Retained for source-compat with old call sites; ISS-232 Phase 3
     *  removed `resolveProjectCap`, so no second `db.select` happens
     *  inside the asserter and this knob is now ignored. */
    cap?: Record<string, unknown> | null;
    caseResult: { reason: string | null } | null | undefined;
  }): void {
    // 1) jobs lookup → returns [job] or []
    selectChainOnce(opts.job ? [opts.job] : []);
    if (opts.job) {
      // ISS-232 Phase 3 — only ONE select call now (the job lookup above).
      // The previous agentConfig lookup was dropped together with
      // `resolveProjectCap`; queueing a 2nd selectChainOnce here would
      // leak past this test and break unrelated checkLayer5RunnerHeartbeat
      // / parity assertions further down the file.
      // 2) the CASE-driven SQL — returns 0 or 1 row
      const rows = opts.caseResult === undefined ? [] : opts.caseResult === null ? [] : [opts.caseResult];
      dbExecute.mockResolvedValueOnce(rows);
    }
  }

  it('returns not_found when the job row is missing', async () => {
    mockAssertChain({ job: null, caseResult: undefined });
    const r = await assertDispatchable('missing');
    expect(r).toEqual({ ok: false, reason: 'not_found', hint: 'missing' });
  });

  it('returns ok:true when the CASE expression returns NULL (all gates pass)', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      cap: { pipelineConfig: { maxConcurrentIssues: 3 } },
      caseResult: { reason: null },
    });
    expect(await assertDispatchable('j1')).toEqual({ ok: true });
  });

  it('returns ok:false with the failing reason verbatim from the CASE', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      cap: null,
      caseResult: { reason: 'project_cap' },
    });
    expect(await assertDispatchable('j1')).toEqual({ ok: false, reason: 'project_cap' });
  });

  it('returns not_found when the CASE query returns 0 rows (race: job vanished mid-call)', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      cap: null,
      caseResult: undefined,
    });
    expect(await assertDispatchable('j1')).toEqual({ ok: false, reason: 'not_found', hint: 'j1' });
  });

  // Reasons enumerated in the CASE — surface in the SQL so the
  // `dispatch_barrier_skips_total{reason}` series stays stable.
  it('SQL enumerates every GateSkipReason in the CASE', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      cap: null,
      caseResult: { reason: null },
    });
    await assertDispatchable('j1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/'not_queued'/);
    expect(text).toMatch(/'pipeline_run_not_running'/);
    expect(text).toMatch(/'manual_hold'/);
    expect(text).toMatch(/'retry_cooldown'/);
    expect(text).toMatch(/'issue_busy'/);
    expect(text).toMatch(/'blocked_by'/);
    expect(text).toMatch(/'release_decompose_pending'/);
    expect(text).toMatch(/'project_cap'/);
    expect(text).toMatch(/'runner_stale'/);
    expect(text).toMatch(/'runner_full'/);
  });

  it('SQL joins jobs/issues/pipeline_runs the same way the picker does', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      cap: null,
      caseResult: { reason: null },
    });
    await assertDispatchable('j1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/FROM\s+jobs\s+j/);
    expect(text).toMatch(/LEFT\s+JOIN\s+issues\s+i\s+ON\s+i\.id\s*=\s*j\.issue_id/);
    expect(text).toMatch(/JOIN\s+pipeline_runs\s+r\s+ON\s+r\.id\s*=\s*j\.pipeline_run_id/);
    expect(text).toMatch(/WHERE\s+j\.id\s*=/);
  });

  // SSOT anti-drift — the running_ids CTE appears in EXACTLY ONE place in
  // the codebase (`buildBarrierFragments`); both the picker and the
  // asserter inherit it from that builder. This test captures the SQL of
  // BOTH queries in one run and asserts they share the same running_ids
  // CTE text, the same fresh_capable_runners CTE text, and the same
  // EXISTS sub-queries for the gate predicates.
  it('parity: picker and assertDispatchable share the same CTEs + EXISTS predicates', async () => {
    // Picker call
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p-parity');
    const pickerSql = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    // Asserter call (fresh mocks)
    vi.clearAllMocks();
    mockAssertChain({
      job: { projectId: 'p-parity' },
      cap: null,
      caseResult: { reason: null },
    });
    await assertDispatchable('j-parity');
    const asserterSql = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);

    // ISS-232 Phase 2 — `running_ids` is sourced from `jobs` only; the
    // prior `agent_sessions metadata->>'issueId'` membership UNION is gone.
    const cteSignatures = [
      /running_ids\s+AS\s*\(/,
      /SELECT\s+DISTINCT\s+issue_id::text\s+AS\s+issue_id\s+FROM\s+jobs/,
      /retry_after_at\s+IS\s+NOT\s+NULL\s+AND\s+retry_after_at\s*>\s*now\(\)/,
      /runner_load\s+AS\s*\(/,
      /fresh_capable_runners\s+AS\s*\(/,
      /r\.last_seen_at\s*>\s*now\(\)/,
    ];
    for (const re of cteSignatures) {
      expect(pickerSql, `picker missing CTE chunk ${re}`).toMatch(re);
      expect(asserterSql, `asserter missing CTE chunk ${re}`).toMatch(re);
    }

    // EXISTS predicate signatures (the bits most prone to drift)
    const predicateSignatures = [
      /FROM\s+agent_sessions\s+s/, // issueBusySession
      /FROM\s+jobs\s+other/, // issueBusyJob
      /d\.kind\s*=\s*'blocks'/, // blockedBy
      /d2\.kind\s*=\s*'decomposes'/, // releaseDecomposePending
    ];
    for (const re of predicateSignatures) {
      expect(pickerSql, `picker missing predicate ${re}`).toMatch(re);
      expect(asserterSql, `asserter missing predicate ${re}`).toMatch(re);
    }

    // Cap + fresh_capable_runners participation: both sides reference
    // running_ids for the cap check and fresh_capable_runners for runner
    // availability.
    expect(pickerSql).toMatch(/SELECT\s+COUNT\(\*\)\s+FROM\s+running_ids/);
    expect(asserterSql).toMatch(/SELECT\s+COUNT\(\*\)\s+FROM\s+running_ids/);
    expect(pickerSql).toMatch(/fresh_capable_runners/);
    expect(asserterSql).toMatch(/fresh_capable_runners/);
  });

  // Clean-break grep gate: the running_ids CTE must be defined exactly
  // once in dispatch-gates.ts (the builder), not duplicated between
  // picker and asserter call sites. This catches a future contributor
  // copy-pasting the CTE into one site without the other.
  it('source: `running_ids AS (` appears exactly once in dispatch-gates.ts (single builder)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('./dispatch-gates.ts', import.meta.url)),
      'utf8',
    );
    const matches = src.match(/running_ids\s+AS\s*\(/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
