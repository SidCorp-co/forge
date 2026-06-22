import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectExistingLimit = vi.fn();
const selectExistingWhere = vi.fn(() => ({ limit: selectExistingLimit }));
const selectFrom = vi.fn(() => ({ where: selectExistingWhere }));

const insertReturning = vi.fn();
const insertOnConflict = vi.fn(() => ({ returning: insertReturning }));
const insertValues = vi.fn(() => ({ onConflictDoNothing: insertOnConflict }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
  },
}));

vi.mock('../db/schema.js', () => ({
  improvementMessageDrafts: {
    id: 'id',
    key: 'key',
    candidateId: 'candidate_id',
    status: 'status',
    createdAt: 'created_at',
  },
  memoryCandidates: {},
}));

const { createImprovementMessageDraft } = await import('./drafts-service.js');

const INPUT = {
  candidateId: '11111111-1111-4111-8111-111111111111',
  signalKey: 'reopen_loop:bug',
  signalType: 'reopen_loop',
  summary: 'Recurring reopen pattern for bug issues.',
  projectId: '22222222-2222-4222-8222-222222222222',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createImprovementMessageDraft', () => {
  it('inserts and returns a new draft', async () => {
    const expectedRow = {
      id: '33333333-3333-4333-8333-333333333333',
      key: 'draft-reopen-loop-bug',
      title: 'Reduce recurring reopen patterns',
      message: expect.stringContaining('UNTRUSTED_DATA'),
      rationale: expect.stringContaining('reopen'),
      appliesWhen: expect.stringContaining('reopen'),
      appliesToSkills: [],
      category: 'pipeline-correctness',
      status: 'pending_review',
      source: 'bottom_up',
      candidateId: INPUT.candidateId,
      signalKey: INPUT.signalKey,
      sourceProjectId: INPUT.projectId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    insertReturning.mockResolvedValue([expectedRow]);

    const result = await createImprovementMessageDraft(INPUT);
    expect(result.key).toBe('draft-reopen-loop-bug');
    expect(result.status).toBe('pending_review');
    expect(result.source).toBe('bottom_up');
    expect(result.candidateId).toBe(INPUT.candidateId);

    const insertedValues = (insertValues.mock.calls as unknown as [Record<string, unknown>][])[0]?.[0];
    expect(insertedValues?.key).toBe('draft-reopen-loop-bug');
    expect(insertedValues?.message).toContain('UNTRUSTED_DATA');
    expect(insertedValues?.candidateId).toBe(INPUT.candidateId);
    expect(insertedValues?.signalKey).toBe(INPUT.signalKey);
    expect(insertedValues?.sourceProjectId).toBe(INPUT.projectId);
  });

  it('is idempotent — returns existing draft on key conflict', async () => {
    const existingDraft = {
      id: '44444444-4444-4444-8444-444444444444',
      key: 'draft-reopen-loop-bug',
      status: 'pending_review',
    };
    // INSERT ON CONFLICT DO NOTHING returns empty → conflict occurred.
    insertReturning.mockResolvedValueOnce([]);
    // Fallback SELECT returns the existing draft.
    selectExistingLimit.mockResolvedValueOnce([existingDraft]);

    const result = await createImprovementMessageDraft(INPUT);
    expect(result.id).toBe(existingDraft.id);
    // Insert WAS called but returned no rows (conflict).
    expect(insertValues).toHaveBeenCalled();
  });

  it('derives correct key from signalKey', async () => {
    insertReturning.mockResolvedValue([{ key: 'draft-reopen-loop-bug' }]);

    await createImprovementMessageDraft(INPUT);
    const inserted = (insertValues.mock.calls as unknown as [Record<string, unknown>][])[0]?.[0];
    expect(inserted?.key).toBe('draft-reopen-loop-bug');
  });

  it('derives skill-specific appliesWhen for agent_self_report', async () => {
    insertReturning.mockResolvedValue([{ key: 'draft-self-report-skill-forge-test-friction' }]);

    await createImprovementMessageDraft({
      ...INPUT,
      signalType: 'agent_self_report',
      signalKey: 'self_report:skill:forge-test:friction',
    });

    const inserted = (insertValues.mock.calls as unknown as [Record<string, unknown>][])[0]?.[0];
    expect(inserted?.appliesToSkills).toEqual(['forge-test']);
    expect(inserted?.appliesWhen).toContain('forge-test');
  });
});
