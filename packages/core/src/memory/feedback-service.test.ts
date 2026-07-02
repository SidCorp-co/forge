import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimitMock = vi.fn();
const updateSetMock = vi.fn();
const updateWhereMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => selectLimitMock() }) }),
    }),
    update: () => ({
      set: (s: unknown) => {
        updateSetMock(s);
        return { where: (w: unknown) => updateWhereMock(w) };
      },
    }),
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  FEEDBACK_HISTORY_CAP,
  FEEDBACK_SOURCES,
  MemoryFeedbackValidationError,
  memoryFeedbackInputSchema,
  runMemoryFeedback,
} = await import('./feedback-service.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const base = {
  projectId: PROJECT_ID,
  source: 'knowledge' as const,
  sourceRef: 'k-1',
};

beforeEach(() => {
  selectLimitMock.mockReset();
  updateSetMock.mockReset();
  updateWhereMock.mockReset();
  updateWhereMock.mockResolvedValue(undefined);
});

describe('memoryFeedbackInputSchema', () => {
  it('accepts confirmed without evidence', () => {
    const r = memoryFeedbackInputSchema.safeParse({ ...base, verdict: 'confirmed' });
    expect(r.success).toBe(true);
  });

  it('covers only agent-curated sources — lifecycle mirrors are rejected', () => {
    expect(FEEDBACK_SOURCES).toEqual(['note', 'knowledge']);
    const r = memoryFeedbackInputSchema.safeParse({
      ...base,
      source: 'decision',
      verdict: 'confirmed',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown verdict', () => {
    const r = memoryFeedbackInputSchema.safeParse({ ...base, verdict: 'maybe' });
    expect(r.success).toBe(false);
  });
});

describe('runMemoryFeedback', () => {
  it('throws when outdated has no evidence (before touching the DB)', async () => {
    await expect(runMemoryFeedback({ ...base, verdict: 'outdated' })).rejects.toBeInstanceOf(
      MemoryFeedbackValidationError,
    );
    expect(selectLimitMock).not.toHaveBeenCalled();
  });

  it('returns found:false noop for a missing row', async () => {
    selectLimitMock.mockResolvedValue([]);
    const r = await runMemoryFeedback({ ...base, verdict: 'confirmed' });
    expect(r).toEqual({ found: false, action: 'noop' });
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('noops on an already-archived row instead of resurrecting it', async () => {
    selectLimitMock.mockResolvedValue([{ id: 'm-1', metadata: {}, archivedAt: new Date() }]);
    const r = await runMemoryFeedback({
      ...base,
      verdict: 'outdated',
      evidence: 'routes.ts no longer exports this',
    });
    expect(r).toEqual({ found: true, action: 'noop' });
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('confirmed stamps last_verified_at only', async () => {
    selectLimitMock.mockResolvedValue([{ id: 'm-1', metadata: {}, archivedAt: null }]);
    const r = await runMemoryFeedback({ ...base, verdict: 'confirmed' });
    expect(r).toEqual({ found: true, action: 'verified' });
    expect(updateSetMock).toHaveBeenCalledTimes(1);
    const set = updateSetMock.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(set)).toEqual(['lastVerifiedAt']);
  });

  it('outdated archives the row and appends capped feedback history', async () => {
    const existing = Array.from({ length: FEEDBACK_HISTORY_CAP }, (_, i) => ({
      verdict: 'outdated',
      evidence: `old-${i}`,
      at: '2026-01-01T00:00:00.000Z',
    }));
    selectLimitMock.mockResolvedValue([
      { id: 'm-1', metadata: { keep: true, feedback: existing }, archivedAt: null },
    ]);

    const r = await runMemoryFeedback({
      ...base,
      verdict: 'outdated',
      evidence: 'schema.ts: column was dropped in migration 0120',
    });
    expect(r).toEqual({ found: true, action: 'archived' });

    const set = updateSetMock.mock.calls[0][0] as {
      archivedAt: unknown;
      metadata: { keep: boolean; feedback: Array<{ evidence: string }> };
    };
    expect(set.archivedAt).toBeDefined();
    // Existing metadata keys survive; history capped, newest entry last.
    expect(set.metadata.keep).toBe(true);
    expect(set.metadata.feedback).toHaveLength(FEEDBACK_HISTORY_CAP);
    expect(set.metadata.feedback.at(-1)?.evidence).toBe(
      'schema.ts: column was dropped in migration 0120',
    );
  });
});
