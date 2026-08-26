/**
 * ISS-789 — the L1b `stale_trigger` gate's SQL shape and its position in the
 * gate CASE. Split from `dispatch-gates.test.ts` because the two files answer
 * different questions about the same builder: that one covers the gates that
 * clear by waiting, this one covers the gate that never does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
const dbSelect = vi.fn();

vi.mock('../db/client.js', () => ({ db: { execute: dbExecute, select: dbSelect } }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { assertDispatchable, pickNextDispatchableJobForProject } = await import(
  './dispatch-gates.js'
);
const { WORKING_STATUS_BY_STATUS } = await import('../pipeline/registry.js');

// cm:edge contract -> packages/core/src/jobs/dispatch-gates.test.ts — the same fragment walker as the sibling suite; drizzle nests `sql` templates as queryChunks, so a shallow read of the template returns none of the gate text
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
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  }));
}

/** The picker's one `projects.agent_config` read (cap + baseStampable). */
function mockProjectAgentConfigOnce(value: Record<string, unknown> | null): void {
  selectChainOnce(value ? [{ agentConfig: value }] : []);
}

/** The asserter's three round-trips: jobs lookup, agent_config, then the CASE. */
function mockAssertChain(opts: {
  job: { projectId: string } | null;
  cap?: Record<string, unknown> | null;
  caseResult: { reason: string | null } | null | undefined;
}): void {
  selectChainOnce(opts.job ? [opts.job] : []);
  if (!opts.job) return;
  selectChainOnce(opts.cap ? [{ agentConfig: opts.cap }] : []);
  dbExecute.mockResolvedValueOnce(opts.caseResult ? [opts.caseResult] : []);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('L1b stale_trigger gate (ISS-789)', () => {
  async function pickerSql(): Promise<string> {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    return collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
  }

  async function asserterSql(): Promise<string> {
    mockAssertChain({ job: { projectId: 'p1' }, cap: null, caseResult: { reason: null } });
    await assertDispatchable('j1');
    return collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
  }

  it('compares the declared trigger against the live issue status, scoped to jobs that declared one', async () => {
    const text = await pickerSql();
    expect(text).toMatch(/i\.status::text\s*<>\s*\(j\.payload->>'stageStatus'\)/);
    expect(text).toMatch(/\(j\.payload->>'stageStatus'\)\s+IS\s+NOT\s+NULL/);
    // cm:why the issue_id clause is what keeps the smoke canaries out — skills/smoke-verify.ts stamps a stageStatus but inserts with a null issue, so without it every canary reads as stale the moment its stage is not some issue's live status
    expect(text).toMatch(/j\.issue_id\s+IS\s+NOT\s+NULL/);
  });

  // cm:guard assert the allowance pairs come from WORKING_STATUS_BY_STATUS by VALUE, not that some allowance exists — an empty or wrongly-keyed map still produces valid SQL, and the failure it produces is silent: every retry of a code/fix job gets discarded instead of running.
  it('exempts each step from its own in-flight working status, sourced from the registry', async () => {
    const text = await pickerSql();
    for (const [trigger, working] of Object.entries(WORKING_STATUS_BY_STATUS)) {
      expect(Object.keys(WORKING_STATUS_BY_STATUS).length).toBeGreaterThan(0);
      expect(text).toContain(trigger);
      expect(text).toContain(working as string);
    }
    expect(WORKING_STATUS_BY_STATUS.approved).toBe('in_progress');
    expect(WORKING_STATUS_BY_STATUS.reopen).toBe('in_progress');
  });

  // cm:guard this ordering assertion is the whole safety property — read before issue_busy, the gate would call a job stale during the one window where a non-trigger status is legitimate (a sibling step mid-flight flipped it), and discard the step queued behind the one doing the work
  it('is judged only after both issue_busy arms, and before blocked_by', async () => {
    const text = await asserterSql();
    const busy = text.lastIndexOf("'issue_busy'");
    const stale = text.indexOf("'stale_trigger'");
    const blocked = text.indexOf("'blocked_by'");
    expect(busy).toBeGreaterThan(-1);
    expect(stale).toBeGreaterThan(busy);
    expect(blocked).toBeGreaterThan(stale);
  });

  it('is negated in the picker WHERE, so a stale job is never handed out', async () => {
    const text = await pickerSql();
    expect(text).toMatch(/AND\s+NOT\s*\(\s*j\.issue_id\s+IS\s+NOT\s+NULL/);
  });

  it('reports stale_trigger through assertDispatchable', async () => {
    mockAssertChain({
      job: { projectId: 'p1' },
      cap: null,
      caseResult: { reason: 'stale_trigger' },
    });
    expect(await assertDispatchable('j1')).toEqual({ ok: false, reason: 'stale_trigger' });
  });
});
