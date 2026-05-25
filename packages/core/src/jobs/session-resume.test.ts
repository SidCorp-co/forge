import { describe, expect, it, vi, beforeEach } from 'vitest';

const limitResults: unknown[][] = [];
const limit = vi.fn(() => Promise.resolve(limitResults.shift() ?? []));
const orderBy = vi.fn(() => ({ limit }));
const whereArgs: unknown[] = [];
const where = vi.fn((arg: unknown) => {
  whereArgs.push(arg);
  return { orderBy };
});
const from = vi.fn(() => ({ where }));

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

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from })) },
}));

const { findPriorSessionInGroup } = await import('./session-resume.js');

beforeEach(() => {
  limitResults.length = 0;
  whereArgs.length = 0;
  limit.mockClear();
  where.mockClear();
});

describe('findPriorSessionInGroup', () => {
  it('returns null when no prior completed session has the (issue, group) pair', async () => {
    limitResults.push([]);
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toBeNull();
  });

  it('returns the most recent claudeSessionId + deviceId when one exists', async () => {
    limitResults.push([
      { claudeSessionId: 'cli-abc123', deviceId: 'd-1' },
    ]);
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toEqual({ claudeSessionId: 'cli-abc123', deviceId: 'd-1' });
  });

  it('swallows DB errors and returns null', async () => {
    limit.mockRejectedValueOnce(new Error('db down'));
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toBeNull();
  });

  it('returns null when row exists but claudeSessionId is missing', async () => {
    limitResults.push([{ claudeSessionId: null, deviceId: 'd-1' }]);
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
    limitResults.push([]);
    await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(whereArgs).toHaveLength(1);
    const fragments = serializeSqlFragments(whereArgs[0]);
    expect(fragments).toContain('completed');
    expect(fragments).not.toContain('running');
  });
});
