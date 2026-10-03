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
  (await import('./forge-agent-report.fixture.js')).makeAgentReportDbMocks(),
);
vi.mock('../../db/client.js', () => ({ db: h.db }));

const { ISSUE_ID, JOB_ID, makeCtx, PROJECT_ID, RUN_ID } = await import(
  './forge-agent-report.fixture.js'
);
const { forgeAgentReportTool, forgeFeedbackAliasTool, FORGE_FEEDBACK_DEPRECATION } = await import(
  './forge-agent-report.js'
);

const REPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** One `submit`'s reads and its insert, queued so either tool name walks the same path. */
function queueSubmit(): void {
  h.queueMemberOnly();
  h.selectLimit.mockResolvedValueOnce([
    {
      jobId: JOB_ID,
      runId: RUN_ID,
      issueId: ISSUE_ID,
      stage: 'code',
      deviceId: null,
      agentSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
  ]);
  h.selectLimit.mockResolvedValueOnce([{ n: 0 }]);
  h.insertReturning.mockResolvedValueOnce([{ id: REPORT_ID }]);
}

const SUBMIT = {
  action: 'submit',
  projectId: PROJECT_ID,
  kind: 'friction',
  target: 'skill',
  targetRef: 'plan-skill',
  summary: 'The plan skill was ambiguous about the approach',
};

beforeEach(() => {
  vi.resetAllMocks();
  h.install();
});

describe('forge_agent_report and its forge_feedback alias', () => {
  it('files a report under the new name and says nothing about deprecation', async () => {
    queueSubmit();
    const result = await forgeAgentReportTool(makeCtx()).handler(SUBMIT);
    expect(result).toEqual({
      ok: true,
      id: REPORT_ID,
      signalKey: 'self_report:skill:plan-skill:friction',
    });
    expect(result).not.toHaveProperty('deprecation');
  });

  it('runs the same handler under the old name and names its replacement on the result', async () => {
    queueSubmit();
    const deprecations = new Set<string>();
    const result = await forgeFeedbackAliasTool({ ...makeCtx(), deprecations }).handler(SUBMIT);
    expect(result).toMatchObject({ ok: true, id: REPORT_ID });
    expect(result).toHaveProperty('deprecation', FORGE_FEEDBACK_DEPRECATION);
    expect(FORGE_FEEDBACK_DEPRECATION.replacement).toBe('forge_agent_report');
    expect([...deprecations]).toEqual(['forge_feedback']);
    expect(h.insertValues).toHaveBeenCalledOnce();
  });

  it('keeps one grant and one schema across both names, and marks only the alias deprecated', () => {
    const current = forgeAgentReportTool(makeCtx());
    const alias = forgeFeedbackAliasTool(makeCtx());
    expect(current.name).toBe('forge_agent_report');
    expect(alias.name).toBe('forge_feedback');
    expect(alias.grant).toEqual(current.grant);
    expect(alias.inputSchema).toEqual(current.inputSchema);
    expect(alias.description.startsWith('[DEPRECATED alias')).toBe(true);
    expect(current.description).not.toContain('DEPRECATED');
  });
});
