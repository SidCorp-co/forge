/**
 * Which events republish, which fans out, and what happens to the rows past the
 * bound.
 *
 * `contract-check.js` is mocked because the question here is routing, not
 * publishing: which pull requests each topic asks for, and whether the ones the
 * cap excludes leave a record. The publishing itself is proved against a real
 * database in `tests/integration/github-contract-check-e2e.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HooksBus } from '../../pipeline/hooks.js';

vi.mock('./contract-check.js', () => ({
  publishForStoredPullRequest: vi.fn(async () => null),
  noteNotPublished: vi.fn(async () => null),
  openPullRequestsForIssue: vi.fn(async () => [] as string[]),
  openPullRequestsForProject: vi.fn(async () => [] as string[]),
}));

const mod = await import('./contract-check.js');
const { PROJECT_REPUBLISH_CAP, registerContractCheckSubscribers } = await import(
  './contract-check-subscribers.js'
);

const published = vi.mocked(mod.publishForStoredPullRequest);
const noted = vi.mocked(mod.noteNotPublished);
const forIssue = vi.mocked(mod.openPullRequestsForIssue);
const forProject = vi.mocked(mod.openPullRequestsForProject);

const actor = { id: 'u1', type: 'user', agency: 'human' } as never;

function bus(): HooksBus {
  const b = new HooksBus();
  registerContractCheckSubscribers(b);
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  forIssue.mockResolvedValue([]);
  forProject.mockResolvedValue([]);
});

describe('the events that change the answer', () => {
  it('republishes an issue`s open pull requests when its status moves', async () => {
    forIssue.mockResolvedValue(['pr-1', 'pr-2']);
    await bus().emit('transition', {
      issueId: 'i1',
      projectId: 'p1',
      actor,
      from: 'in_progress',
      to: 'developed',
      reopenCount: 0,
    });
    expect(forIssue).toHaveBeenCalledWith('i1');
    expect(published.mock.calls.map((c) => c[0])).toEqual(['pr-1', 'pr-2']);
  });

  it('republishes one issue when a record on it moved', async () => {
    forIssue.mockResolvedValue(['pr-9']);
    await bus().emit('contractInputChanged', {
      projectId: 'p1',
      issueId: 'i1',
      reason: 'fields written: plan',
    });
    expect(forIssue).toHaveBeenCalledWith('i1');
    expect(forProject).not.toHaveBeenCalled();
    expect(published).toHaveBeenCalledWith('pr-9');
  });

  it('republishes an issue`s pull requests when a dependency edge on it changed', async () => {
    forIssue.mockResolvedValue(['pr-3']);
    await bus().emit('dependencyChanged', {
      projectId: 'p1',
      edgeId: 'e1',
      fromIssueId: 'i1',
      toIssueId: 'i2',
      kind: 'blocks',
    });
    // The waiver a work_evidence criterion reads is an edge FROM the issue it
    // waives, so that is the end whose checks move.
    expect(forIssue).toHaveBeenCalledWith('i1');
    expect(published).toHaveBeenCalledWith('pr-3');
  });
});

describe('the declaration moving is the one case that fans out', () => {
  it('takes the whole project when no issue is named', async () => {
    forProject.mockResolvedValue(['a', 'b']);
    await bus().emit('contractInputChanged', {
      projectId: 'p1',
      reason: 'the project changed which records a status entry requires',
    });
    expect(forProject).toHaveBeenCalledWith('p1');
    expect(forIssue).not.toHaveBeenCalled();
    expect(published).toHaveBeenCalledTimes(2);
  });

  it('publishes up to the cap and RECORDS every row past it', async () => {
    const ids = Array.from({ length: PROJECT_REPUBLISH_CAP + 3 }, (_, i) => `pr-${i}`);
    forProject.mockResolvedValue(ids);
    await bus().emit('contractInputChanged', { projectId: 'p1', reason: 'declaration moved' });

    expect(published).toHaveBeenCalledTimes(PROJECT_REPUBLISH_CAP);
    // The cap bounds the REQUESTS. A row past it is in the same state as one
    // nobody could publish for, so it gets the same row saying so — dropping it
    // is the silent truncation the bound exists to avoid.
    expect(noted).toHaveBeenCalledTimes(3);
    expect(noted.mock.calls.map((c) => c[0])).toEqual(ids.slice(PROJECT_REPUBLISH_CAP));
    expect(noted.mock.calls[0]?.[1]).toContain(String(ids.length));
    expect(noted.mock.calls[0]?.[1]).toContain('past that bound');
  });

  it('asks GitHub nothing when the project has no open pull requests', async () => {
    await bus().emit('contractInputChanged', { projectId: 'p1', reason: 'declaration moved' });
    expect(published).not.toHaveBeenCalled();
    expect(noted).not.toHaveBeenCalled();
  });
});

describe('a failure here does not become somebody else`s', () => {
  it('swallows its own throw so a co-subscriber on `transition` is unaffected', async () => {
    forIssue.mockRejectedValue(new Error('github is down'));
    const result = await bus().emit('transition', {
      issueId: 'i1',
      projectId: 'p1',
      actor,
      from: 'open',
      to: 'confirmed',
      reopenCount: 0,
    });
    // `outbox-worker.ts` keys its processed-vs-failed decision on `failures`,
    // and a GitHub outage must not put a red on an outbox row this does not own.
    expect(result.failures).toEqual([]);
  });
});
