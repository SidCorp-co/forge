import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

type IssueRecord = {
  plan: string | null;
  acceptanceCriteria: string | null;
  releaseNotes: unknown;
  mergedAt: Date | null;
};

let row: IssueRecord | undefined;

const selectLimit = vi.fn(async () => (row ? [row] : []));
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const select = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({ db: { select } }));

const findMissingWorkEvidenceMock = vi.fn<(...args: unknown[]) => Promise<string | null>>(
  async () => null,
);
vi.mock('../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: (...args: unknown[]) => findMissingWorkEvidenceMock(...args),
}));

const readPipelineConfigMock = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null);
vi.mock('../pipeline/autonomous-project.js', () => ({
  readPipelineConfig: (...args: unknown[]) => readPipelineConfigMock(...args),
}));

const { ENTRY_CRITERION_KEYS } = await import('./entry-criteria-keys.js');
const { findUnmetEntryCriteria, resolveDeclaredEntryCriteria } = await import(
  './entry-criteria.js'
);

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

const complete: IssueRecord = {
  plan: 'the plan',
  acceptanceCriteria: '1. it works',
  releaseNotes: { section: 'Skip', userFacing: '-' },
  mergedAt: new Date('2026-09-07T00:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  row = { ...complete };
  findMissingWorkEvidenceMock.mockResolvedValue(null);
  readPipelineConfigMock.mockResolvedValue(null);
});

describe('resolveDeclaredEntryCriteria', () => {
  it('declares nothing when the project has no pipeline config', async () => {
    expect(await resolveDeclaredEntryCriteria(PROJECT_ID, 'closed')).toEqual([]);
  });

  it('declares nothing when the config sets no statusEntryCriteria', async () => {
    readPipelineConfigMock.mockResolvedValue({ enabled: true });
    expect(await resolveDeclaredEntryCriteria(PROJECT_ID, 'closed')).toEqual([]);
  });

  it('returns what the project declared for the status being entered', async () => {
    readPipelineConfigMock.mockResolvedValue({
      statusEntryCriteria: { closed: ['plan', 'release_note'], open: ['plan'] },
    });
    expect(await resolveDeclaredEntryCriteria(PROJECT_ID, 'closed')).toEqual([
      'plan',
      'release_note',
    ]);
  });

  it('declares nothing for a status the project did not name', async () => {
    readPipelineConfigMock.mockResolvedValue({ statusEntryCriteria: { closed: ['plan'] } });
    expect(await resolveDeclaredEntryCriteria(PROJECT_ID, 'open')).toEqual([]);
  });

  it('declares nothing when the stored config did not parse — `readPipelineConfig` answers null there, and null declares nothing', async () => {
    readPipelineConfigMock.mockResolvedValue(null);
    expect(await resolveDeclaredEntryCriteria(PROJECT_ID, 'closed')).toEqual([]);
  });
});

describe('findUnmetEntryCriteria', () => {
  it('is null when nothing was declared, and reads no row at all', async () => {
    const shortfall = await findUnmetEntryCriteria({ issueId: ISSUE_ID, declared: [] });
    expect(shortfall).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it('is null when every declared criterion is met', async () => {
    const shortfall = await findUnmetEntryCriteria({
      issueId: ISSUE_ID,
      declared: [...ENTRY_CRITERION_KEYS],
    });
    expect(shortfall).toBeNull();
  });

  it('names ONLY the unmet criteria, never every criterion the status declares', async () => {
    row = { ...complete, plan: null };
    const shortfall = await findUnmetEntryCriteria({
      issueId: ISSUE_ID,
      declared: ['plan', 'acceptance_criteria', 'merged_mark'],
    });
    expect(shortfall?.unmet.map((u) => u.key)).toEqual(['plan']);
  });

  it('keeps declaration order when several are unmet', async () => {
    row = { plan: null, acceptanceCriteria: null, releaseNotes: null, mergedAt: null };
    const shortfall = await findUnmetEntryCriteria({
      issueId: ISSUE_ID,
      declared: ['merged_mark', 'plan', 'release_note'],
    });
    expect(shortfall?.unmet.map((u) => u.key)).toEqual(['merged_mark', 'plan', 'release_note']);
  });

  it('names the record to write in each detail', async () => {
    row = { plan: '   ', acceptanceCriteria: null, releaseNotes: null, mergedAt: null };
    const shortfall = await findUnmetEntryCriteria({
      issueId: ISSUE_ID,
      declared: ['plan', 'acceptance_criteria', 'release_note', 'merged_mark'],
    });
    expect(shortfall?.unmet.find((u) => u.key === 'plan')?.detail).toContain('`plan`');
    expect(shortfall?.unmet.find((u) => u.key === 'acceptance_criteria')?.detail).toContain(
      '`acceptanceCriteria`',
    );
    expect(shortfall?.unmet.find((u) => u.key === 'release_note')?.detail).toContain(
      '`releaseNotes`',
    );
    expect(shortfall?.unmet.find((u) => u.key === 'merged_mark')?.detail).toContain('merged mark');
  });

  it('treats whitespace-only prose as no record at all', async () => {
    row = { ...complete, acceptanceCriteria: '\n\t  ' };
    const shortfall = await findUnmetEntryCriteria({
      issueId: ISSUE_ID,
      declared: ['acceptance_criteria'],
    });
    expect(shortfall?.unmet.map((u) => u.key)).toEqual(['acceptance_criteria']);
  });

  it('delegates `work_evidence` to the work-evidence reader and carries its detail through', async () => {
    findMissingWorkEvidenceMock.mockResolvedValue('no branch, commit or code handoff is recorded');
    const shortfall = await findUnmetEntryCriteria({
      issueId: ISSUE_ID,
      declared: ['work_evidence'],
    });
    expect(findMissingWorkEvidenceMock).toHaveBeenCalledWith(ISSUE_ID, expect.anything());
    expect(shortfall?.unmet).toEqual([
      { key: 'work_evidence', detail: 'no branch, commit or code handoff is recorded' },
    ]);
  });

  it('is null for an issue id that has no row — a missing issue is not an unmet criterion', async () => {
    row = undefined;
    const shortfall = await findUnmetEntryCriteria({ issueId: ISSUE_ID, declared: ['plan'] });
    expect(shortfall).toBeNull();
  });
});
