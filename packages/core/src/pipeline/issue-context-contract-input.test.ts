/**
 * ISS-1072 — a step handoff moves the `work_evidence` criterion with nothing on
 * the `issues` row changing.
 *
 * `work-evidence.ts` reads a branch, a commit and a file list out of the handoff,
 * so a handoff arriving can turn that criterion from unmet to met, and a handoff
 * deleted can turn it back, without a single field write anywhere an
 * `issueUpdated` subscriber would see. Both directions announce, and the delete
 * is the one that matters most: a check left saying `success` on evidence that
 * has been removed is a green that is now a claim about nothing.
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
vi.mock('../db/client.js', () => ({ db: { insert, delete: del } }));

const refreshModuleKnowledgeForIssue = vi.fn(async () => undefined);
vi.mock('../labels/module-knowledge-refresh.js', () => ({
  refreshModuleKnowledgeForIssue: () => refreshModuleKnowledgeForIssue(),
}));

const { hooks } = await import('./hooks.js');
const { deleteIssueContext, writeIssueContext } = await import('./issue-context-store.js');

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
});

describe('writing a handoff', () => {
  it('announces the write, naming the issue and its project', async () => {
    await writeIssueContext(handoff as never);
    expect(heard).toEqual([
      { projectId: PROJECT_ID, issueId: ISSUE_ID, reason: 'step handoff written' },
    ]);
  });
});

describe('deleting a handoff', () => {
  it('announces the delete in its own words', async () => {
    const removed = await deleteIssueContext({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      kind: 'handoff',
      step: 'code',
      attempt: 1,
    });
    expect(removed).toBe(1);
    expect(heard).toEqual([
      { projectId: PROJECT_ID, issueId: ISSUE_ID, reason: 'step handoff deleted' },
    ]);
  });

  // cm:guard an idempotent delete that removed nothing announces nothing. Every announcement costs one GitHub request per open pull request on the issue, and a delete that matched no row moved no evidence.
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
