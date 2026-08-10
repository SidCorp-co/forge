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

// Worker call order inside `db.transaction`:
//   1. tx.execute(SELECT ... pipeline_outbox ... LIMIT N) → batch rows
//   2. for each row:
//        await hooks.emit('transition', ...)
//        on success → tx.execute(UPDATE ... SET processed_at = now())
//        on failure → tx.execute(UPDATE ... SET attempts = attempts + 1)
//
// We program the first execute call to return the seeded batch and capture
// every subsequent execute call so the test can inspect what got marked
// processed vs failed.
const selectQueue: FakeRow[][] = [];
const updateCalls: Array<{ kind: 'processed' | 'failed' | 'unknown'; chunks: unknown[] }> = [];

const txExecute = vi.fn(async (q: unknown) => {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  // drizzle StringChunk stores its fragments on `.value` as a string[] (one
  // per template-literal piece). Concatenate all fragments so the kind
  // matcher below sees the full SQL body, not just the leading piece.
  let firstSql = '';
  for (const c of chunks) {
    if (typeof c === 'object' && c !== null && 'value' in c) {
      const v = (c as { value?: unknown }).value;
      if (Array.isArray(v)) {
        firstSql += v.filter((p): p is string => typeof p === 'string').join(' ');
      } else if (typeof v === 'string') {
        firstSql += v;
      }
    }
  }
  if (/select/i.test(firstSql) && /pipeline_outbox/i.test(firstSql)) {
    return selectQueue.shift() ?? [];
  }
  if (/processed_at\s*=\s*now/i.test(firstSql) || /SET processed_at/i.test(firstSql)) {
    updateCalls.push({ kind: 'processed', chunks });
    return [];
  }
  if (/attempts\s*=\s*attempts\s*\+\s*1/i.test(firstSql) || /SET\s+attempts/i.test(firstSql)) {
    updateCalls.push({ kind: 'failed', chunks });
    return [];
  }
  updateCalls.push({ kind: 'unknown', chunks });
  return [];
});

const transactionMock = vi.fn(
  async (cb: (tx: { execute: typeof txExecute }) => Promise<unknown>) =>
    cb({ execute: txExecute }),
);

vi.mock('../db/client.js', () => ({
  db: { transaction: transactionMock },
}));

const emitMock = vi.fn(async () => undefined);
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
  selectQueue.length = 0;
  updateCalls.length = 0;
  txExecute.mockClear();
  emitMock.mockReset();
  emitMock.mockResolvedValue(undefined);
  transactionMock.mockClear();
});

describe('outbox-worker', () => {
  it('marks a successfully dispatched row as processed', async () => {
    const r = row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    selectQueue.push([r]);

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
    expect(updateCalls).toEqual([
      expect.objectContaining({ kind: 'processed' }),
    ]);
  });

  it('on subscriber failure, leaves row unprocessed and records last_error', async () => {
    const r = row({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    selectQueue.push([r]);
    emitMock.mockRejectedValueOnce(new Error('subscriber boom'));

    const result = await drainOutboxOnce();

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect(updateCalls).toEqual([
      expect.objectContaining({ kind: 'failed' }),
    ]);
  });

  it('processes a batch of rows in a single tx', async () => {
    const rA = row({ id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', issue_id: 'iss-A' });
    const rB = row({ id: 'bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb', issue_id: 'iss-B' });
    selectQueue.push([rA, rB]);

    const result = await drainOutboxOnce();

    expect(result.processed).toBe(2);
    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(updateCalls.filter((c) => c.kind === 'processed')).toHaveLength(2);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('routes actor_type=device through the device actor branch', async () => {
    const r = row({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      actor_type: 'device',
      actor_id: 'dev-1',
    });
    selectQueue.push([r]);

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
    selectQueue.push([r]);

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
    selectQueue.push([r]);

    await drainOutboxOnce();

    expect(emitMock).toHaveBeenCalledWith(
      'transition',
      expect.objectContaining({ reason: 'manual override' }),
    );
  });

  it('is a no-op when no rows are unprocessed', async () => {
    selectQueue.push([]);

    const result = await drainOutboxOnce();

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(emitMock).not.toHaveBeenCalled();
  });
});
