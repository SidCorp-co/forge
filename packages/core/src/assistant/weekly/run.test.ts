// ISS-17 — the weekly reading is the assistant's own, so it is posted as the project's assistant
// handle, and never as the project's creator, whether the week is read or fails.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));

const { runAssistantWeeklyForProject } = await import('./run.js');

const PROJECT = {
  projectId: 'proj-1',
  slug: 'demo',
  config: { pinnedIssue: 'ISS-9', judgeProviderId: 'p', judgeModel: 'judge' },
};

function deps(read: () => Promise<never> | Promise<unknown>) {
  return {
    listProjects: vi.fn(),
    resolveIssue: vi.fn(async () => 'issue-9'),
    author: vi.fn(async () => 'handle-user'),
    provider: vi.fn(() => ({}) as never),
    hasReport: vi.fn(async () => false),
    read: vi.fn(read) as never,
    compare: vi.fn(async () => null),
    harvest: vi.fn(() => ({ candidates: [], skipped: [] })),
    post: vi.fn(async () => undefined),
    postFailure: vi.fn(async () => undefined),
    makeJudge: vi.fn(() => ({}) as never),
    lock: (async (_p: string, _w: string, run: () => Promise<unknown>) => ({
      acquired: true,
      value: await run(),
    })) as never,
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

describe('who the weekly reading is posted as', () => {
  it('posts a failed week as the project’s assistant handle', async () => {
    const d = deps(async () => {
      throw new Error('judge down');
    });
    const outcome = await runAssistantWeeklyForProject(PROJECT as never, d as never, new Date());
    expect(outcome.outcome).toBe('failed');
    expect(d.author).toHaveBeenCalledWith('proj-1');
    expect(d.postFailure).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'issue-9', authorId: 'handle-user' }),
    );
  });
});
