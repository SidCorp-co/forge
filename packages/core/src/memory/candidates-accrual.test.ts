import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => selectMock(),
        }),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => insertMock(v),
    }),
    update: () => ({
      set: (s: unknown) => ({
        where: () => updateMock(s),
      }),
    }),
  },
}));

vi.mock('../db/schema.js', () => ({
  memoryCandidates: {
    id: 'id',
    projectId: 'project_id',
    signalType: 'signal_type',
    signalKey: 'signal_key',
  },
}));

const {
  upsertCandidate,
  CONFIDENCE_INIT,
  CONFIDENCE_INCREMENT,
  CONFIDENCE_CAP,
  GRADUATE_CONFIDENCE,
  GRADUATE_EVIDENCE_COUNT,
} = await import('./candidates-accrual.js');

const CANDIDATE = {
  signalType: 'reopen_loop',
  signalKey: 'reopen_loop:bug',
  summary: 'Test summary',
  evidence: { runId: 'run-1', issueId: 'issue-1', at: '2026-01-01T00:00:00.000Z' },
};

function makeExisting(overrides: Record<string, unknown> = {}) {
  return [
    {
      id: 'cand-1',
      status: 'accruing',
      confidence: '0.30',
      evidenceCount: 1,
      evidence: [{ runId: 'run-0', issueId: 'issue-0', at: '2026-01-01T00:00:00.000Z' }],
      summary: 'Old summary',
      graduatedAt: null,
      archivedAt: null,
      ...overrides,
    },
  ];
}

beforeEach(() => {
  vi.resetAllMocks();
  updateMock.mockResolvedValue(undefined);
  insertMock.mockResolvedValue(undefined);
});

describe('accrual constants', () => {
  it('has correct threshold values', () => {
    expect(CONFIDENCE_INIT).toBe(0.3);
    expect(CONFIDENCE_INCREMENT).toBe(0.15);
    expect(CONFIDENCE_CAP).toBe(0.9);
    expect(GRADUATE_CONFIDENCE).toBe(0.6);
    expect(GRADUATE_EVIDENCE_COUNT).toBe(2);
  });
});

describe('upsertCandidate — new row', () => {
  it('inserts with init confidence when no existing row', async () => {
    selectMock.mockResolvedValue([]);
    await upsertCandidate('proj-1', CANDIDATE);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const values = insertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values?.['confidence']).toBe('0.30');
    expect(values?.['evidenceCount']).toBe(1);
  });
});

describe('upsertCandidate — existing accruing row', () => {
  it('increments confidence and evidence_count for a new runId', async () => {
    selectMock.mockResolvedValue(makeExisting({ confidence: '0.30', evidenceCount: 1 }));
    await upsertCandidate('proj-1', CANDIDATE);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const updateSet = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateSet?.['confidence']).toBe('0.45');
    expect(updateSet?.['evidenceCount']).toBe(2);
  });

  it('does NOT double-count the same runId', async () => {
    selectMock.mockResolvedValue(
      makeExisting({
        confidence: '0.45',
        evidenceCount: 2,
        evidence: [{ runId: 'run-1', issueId: 'issue-1', at: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    await upsertCandidate('proj-1', CANDIDATE);
    const updateSet = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateSet?.['confidence']).toBe('0.45');
    expect(updateSet?.['evidenceCount']).toBe(2);
  });

  it('graduates when confidence >= 0.60 and evidence_count >= 2', async () => {
    selectMock.mockResolvedValue(makeExisting({ confidence: '0.45', evidenceCount: 1 }));
    await upsertCandidate('proj-1', CANDIDATE);
    const updateSet = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    // 0.45 + 0.15 = 0.60 >= 0.60, count 2 >= 2 → graduate
    expect(updateSet?.['status']).toBe('graduated');
  });

  it('does not graduate when evidence_count < 2', async () => {
    selectMock.mockResolvedValue(makeExisting({ confidence: '0.45', evidenceCount: 0, evidence: [] }));
    await upsertCandidate('proj-1', CANDIDATE);
    const updateSet = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateSet?.['status']).toBe('accruing');
  });

  it('caps confidence at 0.90', async () => {
    selectMock.mockResolvedValue(
      makeExisting({
        confidence: '0.90',
        evidenceCount: 4,
        evidence: [{ runId: 'run-0', issueId: 'issue-0', at: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    await upsertCandidate('proj-1', CANDIDATE);
    const updateSet = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Number(updateSet?.['confidence'])).toBeLessThanOrEqual(CONFIDENCE_CAP);
  });

  it('does not re-accrue accepted/rejected rows', async () => {
    selectMock.mockResolvedValue(
      makeExisting({ status: 'accepted', confidence: '0.75', evidenceCount: 3, evidence: [] }),
    );
    await upsertCandidate('proj-1', CANDIDATE);
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });
});
