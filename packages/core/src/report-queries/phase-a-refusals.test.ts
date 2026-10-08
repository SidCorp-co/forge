import { beforeEach, describe, expect, it, vi } from 'vitest';

// A query refuses by name where it cannot answer, and never answers a different question.

const list = vi.fn();
const health = vi.fn();
vi.mock('../requirements/index.js', () => ({ listRequirementsAs: list }));
vi.mock('../workflows/index.js', () => ({ projectHealthAs: health }));
vi.mock('../project-status/index.js', () => ({ readProjectStatus: vi.fn() }));

const viewer = { userId: 'u1' };
const ctx = { projectId: 'p1', viewer } as never;

beforeEach(() => {
  list.mockReset();
  health.mockReset();
});

describe('criteria-coverage run', () => {
  it('refuses a requirement the project does not hold, by key', async () => {
    list.mockResolvedValue([{ key: 'REQ-1', title: 't', standing: { coverage: [] } }]);
    const { criteriaCoverage } = await import('./criteria-coverage.js');
    await expect(criteriaCoverage.run(ctx, { requirement: 'REQ-9' })).rejects.toThrow(
      /holds no requirement REQ-9/,
    );
  });

  it('refuses a malformed requirement key at the params', async () => {
    const { criteriaCoverage } = await import('./criteria-coverage.js');
    const { parseReportParams } = await import('@forge/contracts/report-queries');
    expect(() => parseReportParams(criteriaCoverage.descriptor, { requirement: 'twelve' })).toThrow(
      /requirement: a requirement key like REQ-12/,
    );
    expect(() => parseReportParams(criteriaCoverage.descriptor, { req: 'REQ-1' })).toThrow(
      /params refused/,
    );
  });
});

describe('workflow-status run', () => {
  it('refuses a design the project does not hold, by flow', async () => {
    health.mockResolvedValue(new Map());
    const { workflowStatus } = await import('./workflow-status.js');
    await expect(workflowStatus.run(ctx, { flow: 'nope' })).rejects.toThrow(
      /holds no workflow design nope/,
    );
  });
});

describe('release-readiness run', () => {
  it('reads the status as the asker and answers its nextRelease', async () => {
    const { readProjectStatus } = await import('../project-status/index.js');
    vi.mocked(readProjectStatus).mockResolvedValue({
      nextRelease: {
        version: '0.4.0',
        state: 'draft',
        progress: { total: 1, shipped: 0, awaitingRelease: 0, toDo: 1 },
        requirements: [],
        turn: null,
        behind: null,
      },
    } as never);
    const { releaseReadiness } = await import('./release-readiness.js');
    const frame = await releaseReadiness.run(ctx, {});
    expect(readProjectStatus).toHaveBeenCalledWith('p1', viewer, 1);
    expect(frame.rows[0]).toMatchObject({ release: '0.4.0', state: 'draft', toDo: 1 });
  });
});
