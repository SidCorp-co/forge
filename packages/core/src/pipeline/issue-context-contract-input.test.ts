/**
 * ISS-1133 — a step handoff is no contract input. `work-evidence.ts` reads the issue's own row and
 * no handoff, so neither a handoff written nor one deleted can move the `work_evidence` criterion,
 * and announcing either would wake every contract reader for an answer that cannot have changed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

let upsertRows: unknown[] = [{ id: 'ctx-1', createdAt: new Date(), updatedAt: new Date() }];
let deletedRows: unknown[] = [{ id: 'ctx-1' }];

const insert = vi.fn(() => ({
  values: () => ({
    onConflictDoUpdate: () => ({ returning: async () => upsertRows }),
  }),
}));
const del = vi.fn(() => ({ where: () => ({ returning: async () => deletedRows }) }));
let issueRows: unknown[] = [{ id: '11111111-1111-4111-8111-111111111111' }];
const select = vi.fn(() => ({
  from: () => ({
    where: () => ({ limit: async () => issueRows }),
  }),
}));
vi.mock('../db/client.js', () => ({ db: { insert, delete: del, select } }));

const refreshModuleKnowledgeForIssue = vi.fn(async () => undefined);
vi.mock('../labels/module-knowledge-refresh.js', () => ({
  refreshModuleKnowledgeForIssue: () => refreshModuleKnowledgeForIssue(),
}));

const { hooks } = await import('./hooks.js');
const { deleteIssueContext, IssueNotInProject, writeIssueContext } = await import(
  './issue-context-store.js'
);

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

beforeEach(() => {
  heard.length = 0;
  vi.clearAllMocks();
  upsertRows = [{ id: 'ctx-1', createdAt: new Date(), updatedAt: new Date() }];
  deletedRows = [{ id: 'ctx-1' }];
  issueRows = [{ id: '11111111-1111-4111-8111-111111111111' }];
});

describe('writing a handoff', () => {
  it('writes the row and announces no contract input', async () => {
    await writeIssueContext(handoff as never);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
  });
});

describe('writing a handoff against an issue of another project', () => {
  it('is refused by name before any row is written or announced', async () => {
    issueRows = [];
    await expect(writeIssueContext(handoff as never)).rejects.toBeInstanceOf(IssueNotInProject);
    expect(insert).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });
});

describe('deleting a handoff', () => {
  it('removes the row and announces no contract input', async () => {
    const removed = await deleteIssueContext({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      kind: 'handoff',
      step: 'code',
      attempt: 1,
    });
    expect(removed).toBe(1);
    expect(heard).toEqual([]);
  });

  it('announces nothing when the delete matched no row', async () => {
    deletedRows = [];
    expect(
      await deleteIssueContext({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        kind: 'handoff',
        step: 'code',
        attempt: 9,
      }),
    ).toBe(0);
    expect(heard).toEqual([]);
  });
});
