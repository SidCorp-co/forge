import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mocks (must come before import of outbox-worker) ----

interface FakeRow {
  id: string;
  issue_id: string;
  project_id: string;
  from_status: string;
  to_status: string;
  actor_id: string | null;
  actor_type: string | null;
  reason: string | null;
  attempts: number;
  created_at: Date;
}

// cm:why claimQueue backs the UPDATE...RETURNING branch of dbExecute; updateCalls captures every subsequent processed/failed UPDATE so tests can assert outcomes without a real DB
const claimQueue: FakeRow[][] = [];
const updateCalls: Array<{ kind: 'processed' | 'failed' | 'unknown'; chunks: unknown[] }> = [];

function sqlTextOf(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? [];
  let text = '';
  for (const c of chunks) {
    if (typeof c !== 'object' || c === null) continue;
    // cm:why nested sql.raw(...) calls surface as their own SQL wrapper (with its own queryChunks) rather than a flat StringChunk — recurse into it
    if ('queryChunks' in c) {
      text += sqlTextOf(c);
      continue;
    }
    if ('value' in c) {
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

const dbExecute = vi.fn(async (q: unknown) => {
  const text = sqlTextOf(q);
  if (/UPDATE\s+pipeline_outbox\s+o/i.test(text) && /RETURNING/i.test(text)) {
    return claimQueue.shift() ?? [];
  }
  if (/SET\s+processed_at\s*=\s*now/i.test(text)) {
    updateCalls.push({
      kind: 'processed',
      chunks: (q as { queryChunks?: unknown[] }).queryChunks ?? [],
    });
    return [];
  }
  if (/SET\s+claimed_at\s*=\s*NULL,\s*attempts/i.test(text)) {
    updateCalls.push({
      kind: 'failed',
      chunks: (q as { queryChunks?: unknown[] }).queryChunks ?? [],
    });
    return [];
  }
  updateCalls.push({
    kind: 'unknown',
    chunks: (q as { queryChunks?: unknown[] }).queryChunks ?? [],
  });
  return [];
});

const transactionMock = vi.fn();

vi.mock('../db/client.js', () => ({
  db: { execute: dbExecute, transaction: transactionMock },
}));

// cm:why the regression guard: emitMock asserts no transaction is ever opened while a hook is in flight — fails against pre-ISS-678 code, which awaits hooks.emit from inside an open db.transaction
const emitMock = vi.fn(async () => {
  expect(transactionMock).not.toHaveBeenCalled();
});
vi.mock('./hooks.js', () => ({
  hooks: { emit: emitMock, on: vi.fn() },
}));

vi.mock('../observability/sentry.js', () => ({
  Sentry: { addBreadcrumb: vi.fn() },
  isSentryEnabled: () => false,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { drainOutboxOnce } = await import('./outbox-worker.js');

function row(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    issue_id: '22222222-2222-4222-8222-222222222222',
    project_id: '33333333-3333-4333-8333-333333333333',
    from_status: 'open',
    to_status: 'confirmed',
    actor_id: 'u-1',
    actor_type: 'user',
    reason: null,
    attempts: 0,
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  claimQueue.length = 0;
  updateCalls.length = 0;
  dbExecute.mockClear();
  emitMock.mockClear();
  emitMock.mockImplementation(async () => {
    expect(transactionMock).not.toHaveBeenCalled();
  });
  transactionMock.mockClear();
});

describe('outbox-worker', () => {
  it('never opens a db.transaction — claim and emit both run outside one', async () => {
    const r = row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    claimQueue.push([r]);

    await drainOutboxOnce();

    expect(transactionMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it('marks a successfully dispatched row as processed and clears the lease', async () => {
    const r = row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    claimQueue.push([r]);

    const result = await drainOutboxOnce();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(emitMock).toHaveBeenCalledWith(
      'transition',
      expect.objectContaining({
        issueId: r.issue_id,
        projectId: r.project_id,
        from: 'open',
        to: 'confirmed',
        actor: expect.objectContaining({ type: 'user', id: 'u-1' }),
      }),
    );
    expect(updateCalls).toEqual([expect.objectContaining({ kind: 'processed' })]);
  });

  it('on subscriber failure, clears the lease, bumps attempts, and records last_error', async () => {
    const r = row({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    claimQueue.push([r]);
    emitMock.mockImplementationOnce(async () => {
      throw new Error('subscriber boom');
    });

    const result = await drainOutboxOnce();

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect(updateCalls).toEqual([expect.objectContaining({ kind: 'failed' })]);
  });

  it('processes a batch of rows from a single claim call', async () => {
    const rA = row({ id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', issue_id: 'iss-A' });
    const rB = row({ id: 'bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb', issue_id: 'iss-B' });
    claimQueue.push([rA, rB]);

    const result = await drainOutboxOnce();

    expect(result.processed).toBe(2);
    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(updateCalls.filter((c) => c.kind === 'processed')).toHaveLength(2);
  });

  it('claim query filters expired leases via a CLAIM_LEASE_MS-based interval', async () => {
    claimQueue.push([]);

    await drainOutboxOnce();

    const claimCall = dbExecute.mock.calls.find(([q]) => /RETURNING/i.test(sqlTextOf(q)));
    expect(claimCall).toBeDefined();
    const text = sqlTextOf(claimCall?.[0]);
    expect(text).toMatch(/claimed_at IS NULL OR claimed_at < now\(\)/i);
    expect(text).toMatch(/120000 milliseconds/);
  });

  it('routes actor_type=device through the device actor branch', async () => {
    const r = row({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      actor_type: 'device',
      actor_id: 'dev-1',
    });
    claimQueue.push([r]);

    await drainOutboxOnce();

    expect(emitMock).toHaveBeenCalledWith(
      'transition',
      expect.objectContaining({
        actor: expect.objectContaining({ type: 'device', id: 'dev-1' }),
      }),
    );
  });

  it('falls back to type=device for system rows so Actor union stays valid', async () => {
    const r = row({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      actor_type: 'system',
      actor_id: null,
    });
    claimQueue.push([r]);

    await drainOutboxOnce();

    expect(emitMock).toHaveBeenCalledWith(
      'transition',
      expect.objectContaining({
        actor: expect.objectContaining({ type: 'device' }),
      }),
    );
  });

  it('passes reason through when present', async () => {
    const r = row({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', reason: 'manual override' });
    claimQueue.push([r]);

    await drainOutboxOnce();

    expect(emitMock).toHaveBeenCalledWith(
      'transition',
      expect.objectContaining({ reason: 'manual override' }),
    );
  });

  it('is a no-op when no rows are claimed', async () => {
    claimQueue.push([]);

    const result = await drainOutboxOnce();

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(emitMock).not.toHaveBeenCalled();
  });
});
