import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    FEEDBACK_MAX_PER_JOB: 5,
  },
}));

const h = await vi.hoisted(async () =>
  (await import('./forge-feedback.fixture.js')).makeFeedbackDbMocks(),
);
vi.mock('../../db/client.js', () => ({ db: h.db }));

const { makeCtx, PROJECT_ID } = await import('./forge-feedback.fixture.js');
const {
  insertReturning,
  insertValues,
  queueMemberOnly,
  queueSlugAndMember,
  selectLimit,
  selectOrderBy,
} = h;

const { forgeFeedbackTool } = await import('./forge-feedback.js');

beforeEach(() => {
  vi.resetAllMocks();
  h.install();
});

describe('forge_feedback submit refuses to guess the project (ISS-992)', () => {
  it('refuses an omitted projectId, naming the field', async () => {
    const tool = forgeFeedbackTool(makeCtx());

    await expect(
      tool.handler({
        action: 'submit',
        kind: 'friction',
        target: 'skill',
        summary: 'A defect about some other project',
      }),
    ).rejects.toThrow(/projectId is required for submit/);
  });

  it('says where the id comes from, so the refusal is a way forward', async () => {
    const tool = forgeFeedbackTool(makeCtx());

    await expect(
      tool.handler({ action: 'submit', kind: 'friction', target: 'skill', summary: 'x' }),
    ).rejects.toThrow(/forge_projects action=list/);
  });

  it('writes NOTHING when it refuses — the whole point, a row filed somewhere plausible', async () => {
    const tool = forgeFeedbackTool(makeCtx());

    await expect(
      tool.handler({ action: 'submit', kind: 'friction', target: 'skill', summary: 'x' }),
    ).rejects.toThrow();
    expect(insertValues).not.toHaveBeenCalled();
  });

  // cm:why The bound on the change: a read that looks at the wrong feed is visibly empty, so the three reading arms keep resolving the caller's project and are NOT refused.
  it("leaves list resolving the caller's project with no projectId", async () => {
    const tool = forgeFeedbackTool(makeCtx());

    queueSlugAndMember();
    selectOrderBy.mockReturnValueOnce({
      limit: vi.fn().mockResolvedValueOnce([]),
    } as unknown as ReturnType<typeof selectOrderBy>);

    const out = (await tool.handler({ action: 'list' })) as { reports: unknown[] };
    expect(out.reports).toEqual([]);
  });

  // cm:why The context resolves one project and the caller names another: the row must land where the CALLER said. Before ISS-992 this call filed against the context's project and said nothing.
  it('files into the project the caller named, not the one the context resolves', async () => {
    const tool = forgeFeedbackTool(makeCtx('some-other-project'));

    queueMemberOnly();
    selectLimit.mockResolvedValueOnce([]);
    insertReturning.mockResolvedValueOnce([
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', signalKey: 'self_report:skill:-:friction' },
    ]);

    await tool.handler({
      action: 'submit',
      projectId: PROJECT_ID,
      kind: 'friction',
      target: 'skill',
      summary: 'A defect observed while working somewhere else',
    });

    const inserted = (insertValues.mock.calls[0] as unknown[])?.[0] as Record<string, unknown>;
    expect(inserted.projectId).toBe(PROJECT_ID);
    // cm:why and the slug the context carries was never looked up — `queueMemberOnly` queued no row for it
    expect(selectLimit).toHaveBeenCalledTimes(2);
  });
});

describe('the forge_feedback tool description (ISS-992)', () => {
  it('names projectId among the fields submit requires', () => {
    const tool = forgeFeedbackTool(makeCtx());
    expect(tool.description).toMatch(/Required fields: projectId/);
  });

  it('says the id names the project the report is ABOUT', () => {
    const tool = forgeFeedbackTool(makeCtx());
    expect(tool.description).toContain('the report is ABOUT');
  });
});
