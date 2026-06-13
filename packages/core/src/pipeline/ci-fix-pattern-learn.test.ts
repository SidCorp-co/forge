import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
const dbDelete = vi.fn();
const nextSelect = vi.fn();

function makeWhereChain() {
  let consumed = false;
  const resolver = async () => {
    if (consumed) return [];
    consumed = true;
    return nextSelect();
  };
  const chain: Record<string, unknown> = {};
  chain.then = (onFulfilled: (v: unknown) => unknown) => resolver().then(onFulfilled);
  chain.limit = (_n: number) => resolver();
  return chain;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => makeWhereChain() }) }),
    delete: dbDelete,
    execute: (...args: unknown[]) => dbExecute(...(args as [])),
  },
}));

const indexMemoryMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../memory/indexer.js', () => ({
  indexMemory: (...a: unknown[]) => indexMemoryMock(...(a as [])),
}));

const {
  MAX_PATTERNS_PER_ERROR_TYPE,
  extractFixPattern,
  registerCiFixPatternLearner,
  resetCiFixPatternLearnerRegistration,
  storeCiFixPattern,
} = await import('./ci-fix-pattern-learn.js');
const { HooksBus } = await import('./hooks.js');

beforeEach(() => {
  vi.clearAllMocks();
  nextSelect.mockReset();
  resetCiFixPatternLearnerRegistration();
});

describe('extractFixPattern', () => {
  it('returns null when ciFixContext is null', () => {
    expect(extractFixPattern(null)).toBeNull();
  });

  it('returns null when there are no errors', () => {
    expect(extractFixPattern({ errors: [] })).toBeNull();
    expect(extractFixPattern({ errors: [{ type: null }] })).toBeNull();
  });

  it('extracts unique sorted errorTypes and fileTypes', () => {
    const pattern = extractFixPattern({
      errors: [{ type: 'module_not_found' }, { type: 'type_error' }, { type: 'module_not_found' }],
      files: ['src/a.ts', 'src/b.ts', 'README.md', 'no-ext'],
      diffSummary: 'fix imports',
    });
    expect(pattern).not.toBeNull();
    expect(pattern?.errorTypes).toEqual(['module_not_found', 'type_error']);
    expect(pattern?.fileTypes).toEqual(['md', 'ts']);
    expect(pattern?.diffSummary).toBe('fix imports');
  });

  it('truncates a >1KB diffSummary', () => {
    const big = 'x'.repeat(2048);
    const pattern = extractFixPattern({ errors: [{ type: 'module_not_found' }], diffSummary: big });
    expect(pattern?.diffSummary.length).toBe(1024);
  });

  it('preserves branch when present', () => {
    const pattern = extractFixPattern({
      errors: [{ type: 'lint' }],
      branch: 'ISS-99',
    });
    expect(pattern?.branch).toBe('ISS-99');
  });
});

describe('storeCiFixPattern', () => {
  it('upserts via indexMemory with deterministic sourceRef + kind metadata', async () => {
    dbExecute.mockResolvedValue({ rows: [] });
    await storeCiFixPattern({
      projectId: 'proj-1',
      pattern: {
        errorTypes: ['module_not_found'],
        fileTypes: ['ts'],
        diffSummary: 'fix imports',
      },
    });
    expect(indexMemoryMock).toHaveBeenCalledTimes(1);
    const call = indexMemoryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.projectId).toBe('proj-1');
    expect(call.source).toBe('note');
    expect(call.sourceRef).toBe('ci_fix_pattern:module_not_found:ts');
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.kind).toBe('ci_fix_pattern');
    expect(meta.errorTypes).toEqual(['module_not_found']);
  });

  it('runs the cap-enforcement DELETE for each errorType', async () => {
    dbExecute.mockResolvedValue({ rows: [] });
    await storeCiFixPattern({
      projectId: 'proj-1',
      pattern: {
        errorTypes: ['a', 'b'],
        fileTypes: [],
        diffSummary: '',
      },
    });
    expect(dbExecute).toHaveBeenCalledTimes(2);
  });

  it('cap DELETE evicts least-recently-updated extras (ORDER BY updated_at DESC + OFFSET)', async () => {
    // Locks in two invariants:
    //   1. Direction is DESC + OFFSET (ASC would evict the just-stored row).
    //   2. Sort key is `updated_at`, not `created_at` — `indexMemory`'s
    //      onConflictDoUpdate refreshes updated_at on every re-store, so
    //      `created_at` would evict frequently-updated high-signal rows
    //      while preserving stale ones (round-4 review #1).
    dbExecute.mockResolvedValue({ rows: [] });
    await storeCiFixPattern({
      projectId: 'proj-1',
      pattern: {
        errorTypes: ['module_not_found'],
        fileTypes: ['ts'],
        diffSummary: '',
      },
    });
    expect(dbExecute).toHaveBeenCalledTimes(1);
    const sqlArg = dbExecute.mock.calls[0]?.[0];
    const serialized = JSON.stringify(sqlArg);
    expect(serialized).toContain('DELETE FROM memories');
    expect(serialized).toContain('ORDER BY updated_at DESC');
    expect(serialized).not.toContain('ORDER BY updated_at ASC');
    expect(serialized).not.toContain('ORDER BY created_at');
    expect(serialized).toContain('OFFSET ');
  });

  it('cap defaults to 5 patterns/errorType', () => {
    expect(MAX_PATTERNS_PER_ERROR_TYPE).toBe(5);
  });
});

describe('registerCiFixPatternLearner', () => {
  it('skips when reopenCount === 0 (UC-6)', async () => {
    const bus = new HooksBus();
    registerCiFixPatternLearner(bus);
    await bus.emit('transition', {
      issueId: 'iss-1',
      projectId: 'proj-1',
      actor: { type: 'user', id: 'u-1' },
      from: 'testing',
      to: 'developed',
      reopenCount: 0,
    } as never);
    // queueMicrotask flush
    await new Promise((r) => setImmediate(r));
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('skips when target status is not developed', async () => {
    const bus = new HooksBus();
    registerCiFixPatternLearner(bus);
    await bus.emit('transition', {
      issueId: 'iss-1',
      projectId: 'proj-1',
      actor: { type: 'user', id: 'u-1' },
      from: 'developed',
      to: 'released',
      reopenCount: 2,
    } as never);
    await new Promise((r) => setImmediate(r));
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('skips silently when sessionContext lacks ciFixContext (edge)', async () => {
    nextSelect.mockResolvedValueOnce([{ sessionContext: { other: 'data' } }]);
    const bus = new HooksBus();
    registerCiFixPatternLearner(bus);
    await bus.emit('transition', {
      issueId: 'iss-1',
      projectId: 'proj-1',
      actor: { type: 'user', id: 'u-1' },
      from: 'reopen',
      to: 'developed',
      reopenCount: 1,
    } as never);
    await new Promise((r) => setImmediate(r));
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('stores pattern on reopen→developed with ciFixContext (UC-1)', async () => {
    nextSelect.mockResolvedValueOnce([
      {
        sessionContext: {
          ciFixContext: {
            errors: [{ type: 'module_not_found' }],
            files: ['src/foo.ts'],
            diffSummary: 'add missing import',
          },
        },
      },
    ]);
    dbExecute.mockResolvedValue({ rows: [] });
    const bus = new HooksBus();
    registerCiFixPatternLearner(bus);
    await bus.emit('transition', {
      issueId: 'iss-1',
      projectId: 'proj-1',
      actor: { type: 'user', id: 'u-1' },
      from: 'reopen',
      to: 'developed',
      reopenCount: 1,
    } as never);
    await new Promise((r) => setImmediate(r));
    expect(indexMemoryMock).toHaveBeenCalledTimes(1);
    const call = indexMemoryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((call.metadata as Record<string, unknown>).kind).toBe('ci_fix_pattern');
  });
});
