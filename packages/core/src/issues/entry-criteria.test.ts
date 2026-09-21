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
const missingWorkEvidenceStrictMock = vi.fn<(...args: unknown[]) => Promise<string | null>>(
  async () => null,
);
vi.mock('../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: (...args: unknown[]) => findMissingWorkEvidenceMock(...args),
  missingWorkEvidenceStrict: (...args: unknown[]) => missingWorkEvidenceStrictMock(...args),
}));

const readPipelineConfigMock = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null);
vi.mock('../pipeline/autonomous-project.js', () => ({
  readPipelineConfig: (...args: unknown[]) => readPipelineConfigMock(...args),
}));

const { ENTRY_CRITERION_KEYS } = await import('./entry-criteria-keys.js');
const { findUnmetEntryCriteria, readEntryCriteriaStrict, resolveDeclaredEntryCriteria } =
  await import('./entry-criteria.js');

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
  missingWorkEvidenceStrictMock.mockResolvedValue(null);
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

  it('declares nothing when the config read THROWS, so a broken read cannot freeze every status write on the project', async () => {
    readPipelineConfigMock.mockRejectedValue(new Error('connection terminated'));
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

/**
 * ISS-1072 — the strict reader, which publishes its answer instead of gating on
 * it. Everything below is a difference from the pair above, and every one of
 * those differences is the same sentence: a value that is right to swallow in a
 * gate is a lie on a pull request.
 */
describe('readEntryCriteriaStrict', () => {
  it('reads the declaration for the status the issue is standing in', async () => {
    readPipelineConfigMock.mockResolvedValue({
      statusEntryCriteria: { developed: ['plan', 'merged_mark'], testing: ['release_note'] },
    });
    const reading = await readEntryCriteriaStrict({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'developed',
    });
    expect(reading.declared).toEqual(['plan', 'merged_mark']);
  });

  it('names the criteria the issue DOES hold, which the gate never returns', async () => {
    readPipelineConfigMock.mockResolvedValue({
      statusEntryCriteria: { developed: ['plan', 'acceptance_criteria', 'merged_mark'] },
    });
    row = { ...complete, mergedAt: null };
    const reading = await readEntryCriteriaStrict({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'developed',
    });
    expect(reading.met).toEqual(['plan', 'acceptance_criteria']);
    expect(reading.unmet.map((u) => u.key)).toEqual(['merged_mark']);
  });

  it('carries the SAME remedy sentence the gate writes, from the one map', async () => {
    readPipelineConfigMock.mockResolvedValue({ statusEntryCriteria: { developed: ['plan'] } });
    row = { ...complete, plan: null };
    const strict = await readEntryCriteriaStrict({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'developed',
    });
    const gate = await findUnmetEntryCriteria({ issueId: ISSUE_ID, declared: ['plan'] });
    expect(strict.unmet[0]?.detail).toBe(gate?.unmet[0]?.detail);
  });

  it('declares nothing, and judges nothing, for a status the project did not name', async () => {
    readPipelineConfigMock.mockResolvedValue({ statusEntryCriteria: { closed: ['plan'] } });
    const reading = await readEntryCriteriaStrict({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'developed',
    });
    expect(reading).toEqual({ declared: [], met: [], unmet: [] });
    expect(select).not.toHaveBeenCalled();
  });

  it('refuses a config that could not be read, where the gate reads it as `[]`', async () => {
    readPipelineConfigMock.mockResolvedValue(null);
    await expect(
      readEntryCriteriaStrict({ projectId: PROJECT_ID, issueId: ISSUE_ID, status: 'developed' }),
    ).rejects.toThrow('could not be read');
    expect(await resolveDeclaredEntryCriteria(PROJECT_ID, 'developed')).toEqual([]);
  });

  it('still answers "nothing declared" for a VALID config that declares nothing', async () => {
    readPipelineConfigMock.mockResolvedValue({ enabled: true });
    expect(
      await readEntryCriteriaStrict({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        status: 'developed',
      }),
    ).toEqual({ declared: [], met: [], unmet: [] });
  });

  it('reads the declaration through the executor it was given', async () => {
    const executor = { select } as never;
    readPipelineConfigMock.mockResolvedValue({ statusEntryCriteria: { developed: ['plan'] } });
    await readEntryCriteriaStrict({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'developed',
      executor,
    });
    expect(readPipelineConfigMock).toHaveBeenCalledWith(PROJECT_ID, executor);
  });

  it('lets a failed config read OUT, where the gate turns it into `[]`', async () => {
    readPipelineConfigMock.mockRejectedValue(new Error('connection terminated'));
    await expect(
      readEntryCriteriaStrict({ projectId: PROJECT_ID, issueId: ISSUE_ID, status: 'developed' }),
    ).rejects.toThrow('connection terminated');
    expect(await resolveDeclaredEntryCriteria(PROJECT_ID, 'developed')).toEqual([]);
  });

  it('lets a criterion that RAISES out, rather than reporting it met', async () => {
    readPipelineConfigMock.mockResolvedValue({
      statusEntryCriteria: { developed: ['work_evidence'] },
    });
    missingWorkEvidenceStrictMock.mockRejectedValue(new Error('evidence query failed'));
    await expect(
      readEntryCriteriaStrict({ projectId: PROJECT_ID, issueId: ISSUE_ID, status: 'developed' }),
    ).rejects.toThrow('evidence query failed');
  });

  it('runs `work_evidence` through the STRICT reader and never the fail-open one', async () => {
    readPipelineConfigMock.mockResolvedValue({
      statusEntryCriteria: { developed: ['work_evidence'] },
    });
    missingWorkEvidenceStrictMock.mockResolvedValue('no branch, commit or code handoff');
    const reading = await readEntryCriteriaStrict({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'developed',
    });
    expect(missingWorkEvidenceStrictMock).toHaveBeenCalledWith(ISSUE_ID, expect.anything());
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
    expect(reading.unmet).toEqual([
      { key: 'work_evidence', detail: 'no branch, commit or code handoff' },
    ]);
  });

  it('refuses an issue row that is gone, where the gate skips it', async () => {
    readPipelineConfigMock.mockResolvedValue({ statusEntryCriteria: { developed: ['plan'] } });
    row = undefined;
    await expect(
      readEntryCriteriaStrict({ projectId: PROJECT_ID, issueId: ISSUE_ID, status: 'developed' }),
    ).rejects.toThrow(`no issue row for ${ISSUE_ID}`);
  });
});
