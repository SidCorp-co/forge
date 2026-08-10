import { describe, expect, it, vi, beforeEach } from 'vitest';

// ISS-580 — the mock must support three call shapes used by the three exported
// functions in session-resume.ts:
//  1. db.select({...}).from(...).where(...).orderBy(...).limit(1)   ← findPriorSessionInGroup
//  2. db.select({...}).from(...).where(...).limit(1)                ← loadResumeBounds
//  3. db.execute(sql`...`)                                          ← estimateGroupContextTokens

const selectLimitResults: unknown[][] = [];
const executeLimitResults: unknown[][] = [];

const limitSpy = vi.fn(() => Promise.resolve(selectLimitResults.shift() ?? []));
const orderBy = vi.fn(() => ({ limit: limitSpy }));
const whereArgs: unknown[] = [];
const where = vi.fn((arg: unknown) => {
  whereArgs.push(arg);
  return { orderBy, limit: limitSpy };
});
const from = vi.fn(() => ({ where }));
const executeSpy = vi.fn(() => Promise.resolve(executeLimitResults.shift() ?? []));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from })),
    execute: executeSpy,
  },
}));

function serializeSqlFragments(node: unknown): string {
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (n === null || n === undefined) return;
    if (typeof n === 'string' || typeof n === 'number' || typeof n === 'boolean') {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (typeof n === 'object') {
      const obj = n as Record<string, unknown>;
      if ('value' in obj) visit(obj.value);
      if ('queryChunks' in obj) visit(obj.queryChunks);
      if ('left' in obj) visit(obj.left);
      if ('right' in obj) visit(obj.right);
      if ('column' in obj) visit(obj.column);
      if ('name' in obj && typeof obj.name === 'string') out.push(obj.name);
    }
  };
  visit(node);
  return out.join(' ');
}

const { findPriorSessionInGroup, loadResumeBounds, estimateGroupContextTokens } = await import('./session-resume.js');

beforeEach(() => {
  selectLimitResults.length = 0;
  executeLimitResults.length = 0;
  whereArgs.length = 0;
  limitSpy.mockClear();
  where.mockClear();
  executeSpy.mockClear();
});

describe('findPriorSessionInGroup', () => {
  it('returns null when no prior completed session has the (issue, group) pair', async () => {
    selectLimitResults.push([]);
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toBeNull();
  });

  it('returns the most recent claudeSessionId + deviceId when one exists', async () => {
    selectLimitResults.push([{ claudeSessionId: 'cli-abc123', deviceId: 'd-1' }]);
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toEqual({ claudeSessionId: 'cli-abc123', deviceId: 'd-1' });
  });

  it('swallows DB errors and returns null', async () => {
    limitSpy.mockRejectedValueOnce(new Error('db down'));
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toBeNull();
  });

  it('returns null when row exists but claudeSessionId is missing', async () => {
    selectLimitResults.push([{ claudeSessionId: null, deviceId: 'd-1' }]);
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toBeNull();
  });

  // ISS-226 — regression guard: the SQL filter must stay strict on
  // status='completed'. A future contributor that widens the filter to
  // `IN ('running','completed')` would re-introduce the resume-from-poisoned
  // session bug ISS-226 closed by enforcing lifecycle ordering via the
  // dispatch-time barrier (`dispatch-gates.ts#hasNonTerminalPriorSession`).
  // If you find yourself relaxing this filter, read ISS-226's plan first.
  it('ISS-226: filters strictly on status=completed (never widens to running)', async () => {
    selectLimitResults.push([]);
    await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(whereArgs).toHaveLength(1);
    const fragments = serializeSqlFragments(whereArgs[0]);
    expect(fragments).toContain('completed');
    expect(fragments).not.toContain('running');
  });
});

describe('loadResumeBounds (ISS-580)', () => {
  it('returns defaults when project has no pipelineConfig', async () => {
    selectLimitResults.push([{ agentConfig: null }]);
    const bounds = await loadResumeBounds('p-1');
    expect(bounds).toEqual({ maxResumeTokens: 150_000, maxResumeReopenCycles: 3 });
  });

  it('returns defaults when pipelineConfig is missing the new fields', async () => {
    selectLimitResults.push([{ agentConfig: { pipelineConfig: { enabled: true } } }]);
    const bounds = await loadResumeBounds('p-1');
    expect(bounds).toEqual({ maxResumeTokens: 150_000, maxResumeReopenCycles: 3 });
  });

  it('returns configured values when both fields are present', async () => {
    selectLimitResults.push([{
      agentConfig: {
        pipelineConfig: { maxResumeTokens: 200_000, maxResumeReopenCycles: 5 },
      },
    }]);
    const bounds = await loadResumeBounds('p-1');
    expect(bounds).toEqual({ maxResumeTokens: 200_000, maxResumeReopenCycles: 5 });
  });

  it('treats 0 as a valid (gate-disabled) value', async () => {
    selectLimitResults.push([{
      agentConfig: {
        pipelineConfig: { maxResumeTokens: 0, maxResumeReopenCycles: 0 },
      },
    }]);
    const bounds = await loadResumeBounds('p-1');
    expect(bounds).toEqual({ maxResumeTokens: 0, maxResumeReopenCycles: 0 });
  });

  it('falls back to defaults on DB error', async () => {
    limitSpy.mockRejectedValueOnce(new Error('db down'));
    const bounds = await loadResumeBounds('p-1');
    expect(bounds).toEqual({ maxResumeTokens: 150_000, maxResumeReopenCycles: 3 });
  });
});

describe('estimateGroupContextTokens (ISS-580)', () => {
  it('returns 0 when no usage_records rows exist for the group', async () => {
    executeLimitResults.push([{ peak: null }]);
    const tokens = await estimateGroupContextTokens({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(tokens).toBe(0);
  });

  it('returns 0 when query returns no rows', async () => {
    executeLimitResults.push([]);
    const tokens = await estimateGroupContextTokens({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(tokens).toBe(0);
  });

  it('returns the numeric peak value from the MAX aggregate', async () => {
    executeLimitResults.push([{ peak: '363342' }]);
    const tokens = await estimateGroupContextTokens({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(tokens).toBe(363342);
  });

  it('returns 0 on DB error (fail-safe — never blocks dispatch)', async () => {
    executeSpy.mockRejectedValueOnce(new Error('db down'));
    const tokens = await estimateGroupContextTokens({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(tokens).toBe(0);
  });
});
