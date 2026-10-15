/**
 * ISS-1133 — the handoff store over the run journal, against a mocked database.
 *
 * A handoff is no contract input: `work-evidence.ts` reads the issue's own row and no handoff, so
 * a handoff written cannot move the `work_evidence` criterion and announces nothing. A handoff is
 * written once onto its attempt's row; a second one, and every delete, is refused by name.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

/** What each guarded statement answers, set per case; selects are served in order. */
let filledRows: unknown[] = [];
let appendedRows: unknown[] = [];
let selects: unknown[][] = [];

const update = vi.fn(() => ({
  set: () => ({ where: () => ({ returning: async () => filledRows }) }),
}));
const insert = vi.fn(() => ({
  values: () => ({ onConflictDoNothing: () => ({ returning: async () => appendedRows }) }),
}));
const select = vi.fn(() => ({
  from: () => ({ where: () => ({ limit: async () => selects.shift() ?? [] }) }),
}));
vi.mock('../db/client.js', () => ({ db: { insert, update, select } }));

const refreshModuleKnowledgeForIssue = vi.fn(async () => undefined);
vi.mock('../labels/module-knowledge-refresh.js', () => ({
  refreshModuleKnowledgeForIssue: () => refreshModuleKnowledgeForIssue(),
}));

const { hooks } = await import('./hooks.js');
const {
  deleteIssueContext,
  HandoffDeleteRefused,
  HandoffRefused,
  IssueNotInProject,
  writeIssueContext,
} = await import('./issue-context-store.js');

/** Every `contractInputChanged` this suite heard, on the one bus the writer emits to. */
const heard: { projectId: string; issueId?: string; reason: string }[] = [];
hooks.on(
  'contractInputChanged',
  async (payload) => {
    heard.push(payload);
  },
  { name: 'issue-context-store-test-listener' },
);

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '55555555-5555-4555-8555-555555555555';

const handoff = {
  projectId: PROJECT_ID,
  issueId: ISSUE_ID,
  pipelineRunId: RUN_ID,
  kind: 'handoff' as const,
  step: 'code',
  attempt: 1,
  actor: {
    type: 'device' as const,
    id: '66666666-6666-4666-8666-666666666666',
    agency: 'agent' as const,
  },
  payload: {
    step: 'code' as const,
    schema_version: 1 as const,
    filesModified: [
      { path: 'packages/core/src/integrations/github/check-run.ts', op: 'create' as const },
    ],
    decisions: [{ what: 'find-then-write', why: 'the Checks API has no upsert' }],
    verificationCommands: ['pnpm test'],
    knownLimitations: [],
    commitSha: 'a'.repeat(40),
  },
};

const ISSUE_ROW = [{ id: ISSUE_ID }];
const RUN_ROW = [{ id: RUN_ID }];
const AT = new Date('2026-10-15T07:00:00Z');

beforeEach(() => {
  heard.length = 0;
  vi.clearAllMocks();
  filledRows = [{ id: 'row-1', startedAt: AT, at: AT }];
  appendedRows = [];
  selects = [ISSUE_ROW, RUN_ROW];
});

describe('writing a handoff', () => {
  it('fills the attempt the run declared, appends nothing and announces no contract input', async () => {
    const written = await writeIssueContext(handoff as never);
    expect(written).toEqual({ id: 'row-1', createdAt: AT, updatedAt: AT });
    expect(update).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });

  it('appends a closed attempt where the run never declared one', async () => {
    filledRows = [];
    appendedRows = [{ id: 'row-2', startedAt: AT, at: AT }];
    expect((await writeIssueContext(handoff as never)).id).toBe('row-2');
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('refuses a second handoff for the attempt by name, naming when the first was written (criterion 11)', async () => {
    filledRows = [];
    selects = [ISSUE_ROW, RUN_ROW, [{ issueId: ISSUE_ID, handoffAt: AT }]];
    const refused = await writeIssueContext(handoff as never).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HandoffRefused);
    expect((refused as InstanceType<typeof HandoffRefused>).code).toBe('HANDOFF_ALREADY_WRITTEN');
    expect((refused as Error).message).toContain(AT.toISOString());
  });

  it("refuses by name a handoff onto another issue's attempt", async () => {
    filledRows = [];
    selects = [ISSUE_ROW, RUN_ROW, [{ issueId: 'other-issue', handoffAt: null }]];
    const refused = await writeIssueContext(handoff as never).catch((e: unknown) => e);
    expect((refused as InstanceType<typeof HandoffRefused>).code).toBe('HANDOFF_NOT_THIS_ISSUE');
    expect((refused as Error).message).toContain('other-issue');
  });
});

describe('writing a handoff against an issue of another project', () => {
  it('is refused by name before any row is written', async () => {
    selects = [[]];
    await expect(writeIssueContext(handoff as never)).rejects.toBeInstanceOf(IssueNotInProject);
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('deleting a handoff', () => {
  it('is refused by name and touches no row', async () => {
    const refused = await deleteIssueContext({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      kind: 'handoff',
      step: 'code',
      attempt: 1,
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HandoffDeleteRefused);
    expect((refused as InstanceType<typeof HandoffDeleteRefused>).code).toBe('HANDOFF_IS_JOURNAL');
    expect(update).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });
});
