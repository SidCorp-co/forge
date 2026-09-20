/**
 * ISS-1123 criteria 1 to 7 and 9 — what the agent face hands the projection, and what it refuses.
 *
 * The writer is a recorder rather than a stub, because half of what is asserted here is the SHAPE
 * of the payload: a stub that answered without recording would let every case pass with the fields
 * the merge route resolves on deleted. `updated_at` is asserted for the same reason it is carried —
 * the writer treats an absent one as always-wins, so dropping it is a silent overwrite of a newer
 * delivery rather than a compile error.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenedPullRequest } from './agent-ops.js';

const applied: Array<{ ctx: unknown; payload: Record<string, unknown> }> = [];
let written = 1;

vi.mock('./projection.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    applyPullRequestEvent: async (ctx: unknown, payload: Record<string, unknown>) => {
      applied.push({ ctx, payload });
      return written;
    },
  };
});

let storedRows: Array<{ issueId: string | null }> = [{ issueId: 'issue-9' }];
/** Set to make the READBACK fail, which says nothing about the write that already committed. */
let readbackError: Error | null = null;
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (readbackError) throw readbackError;
            return storedRows;
          },
        }),
      }),
    }),
  },
}));

const { OpenedPullRequestIncomplete, projectOpenedPullRequest } = await import(
  './opened-pull-request.js'
);

const OPENED: OpenedPullRequest = {
  number: 534,
  url: 'https://github.com/SidCorp-co/forge/pull/534',
  title: 'the projection has a second writer',
  state: 'open',
  draft: false,
  headRef: 'ISS-1123-projection',
  headSha: 'a'.repeat(40),
  baseRef: 'main',
  baseSha: 'b'.repeat(40),
  updatedAt: '2026-09-20T15:04:05Z',
};

const project = (over: Partial<OpenedPullRequest> = {}) =>
  projectOpenedPullRequest({
    projectId: 'project-1',
    bindingId: 'binding-1',
    repository: 'SidCorp-co/forge',
    opened: { ...OPENED, ...over },
  });

function payload(): Record<string, unknown> {
  const last = applied.at(-1);
  if (!last) throw new Error('the writer was never called');
  return last.payload;
}

function pullRequest(): Record<string, unknown> {
  return payload().pull_request as Record<string, unknown>;
}

beforeEach(() => {
  applied.length = 0;
  written = 1;
  storedRows = [{ issueId: 'issue-9' }];
  readbackError = null;
});

describe('a pull request the agent face opened reaches the projection writer', () => {
  it('hands the writer the number, both refs and both SHAs the merge route resolves on', async () => {
    await project();
    expect(pullRequest()).toMatchObject({
      number: 534,
      head: { ref: 'ISS-1123-projection', sha: 'a'.repeat(40) },
      base: { ref: 'main', sha: 'b'.repeat(40) },
    });
    expect(payload().repository).toEqual({ full_name: 'SidCorp-co/forge' });
    expect(applied.at(-1)?.ctx).toEqual({ projectId: 'project-1', bindingId: 'binding-1' });
  });

  it("carries GitHub's own updated_at, which is what the writer orders deliveries on", async () => {
    await project();
    expect(pullRequest().updated_at).toBe('2026-09-20T15:04:05Z');
  });

  it('says the request is open and carries no merge evidence, because opening is not landing', async () => {
    await project();
    expect(pullRequest()).toMatchObject({
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
    });
  });

  it('reports the issue the head branch resolved to on the row the writer wrote', async () => {
    expect(await project()).toEqual({ outcome: 'recorded', issueId: 'issue-9', reason: null });
  });

  it('reports a null issue where the row links to none, which is an ordinary answer', async () => {
    storedRows = [{ issueId: null }];
    expect(await project()).toMatchObject({ outcome: 'recorded', issueId: null });
  });
});

describe('what it will not write', () => {
  it.each([
    ['head sha', { headSha: null }],
    ['base sha', { baseSha: null }],
    ['number', { number: 0 }],
    ['head ref', { headRef: '' }],
    // The writer reads an absent `updated_at` as always-wins, so this one is not a lesser row —
    // it is the one that overwrites a merged row's evidence with `open`. Refused with the rest.
    ['updated at', { updatedAt: null }],
  ])('refuses by naming the missing %s rather than writing a partial row', async (name, over) => {
    await expect(project(over as Partial<OpenedPullRequest>)).rejects.toThrow(
      OpenedPullRequestIncomplete,
    );
    await expect(project(over as Partial<OpenedPullRequest>)).rejects.toThrow(name);
    expect(applied).toHaveLength(0);
  });

  it('names every missing field at once rather than one per attempt', async () => {
    await expect(project({ headSha: null, baseSha: null })).rejects.toThrow(
      /head sha, no base sha/,
    );
  });

  it('says the pull request exists, so a caller does not open a second one', async () => {
    await expect(project({ headSha: null })).rejects.toThrow(/EXISTS on\s+GitHub/);
  });
});

describe('what the writer refusing to overwrite means', () => {
  it('reports superseded, not success, where a newer record of that number already stood', async () => {
    written = 0;
    const result = await project();
    expect(result.outcome).toBe('superseded');
    expect(result.issueId).toBe('issue-9');
    expect(result.reason).toMatch(/newer/);
  });

  it('reports not-recorded where nothing was written and no row is there', async () => {
    written = 0;
    storedRows = [];
    const result = await project();
    expect(result.outcome).toBe('not-recorded');
    expect(result.reason).toMatch(/EXISTS/);
  });
});

/**
 * F1 — the readback happens AFTER the write has committed, so its failure is not the write's.
 *
 * Letting it escape reported `not-recorded` and logged that the projection row never landed, for a
 * row that was there and mergeable: the one claim known to be false. The linkage it could not read
 * is reported as unread instead.
 */
describe('a readback that fails does not unsay a write that committed', () => {
  it('still reports recorded, and says the issue link is what it could not read', async () => {
    readbackError = new Error('connection terminated');
    const result = await project();
    expect(result.outcome).toBe('recorded');
    expect(result.issueId).toBeNull();
    expect(result.reason).toMatch(/could not be read back/);
    expect(result.reason).toMatch(/The row itself was written/);
  });

  it('says it cannot tell superseded from unwritten where nothing was written either', async () => {
    written = 0;
    readbackError = new Error('connection terminated');
    const result = await project();
    expect(result.outcome).toBe('not-recorded');
    expect(result.reason).toMatch(/could not be read/);
  });
});

/**
 * F3 — one recovery instruction, not two that contradict.
 *
 * The refusal used to suggest opening the pull request again while `forge_github`'s own wrapper
 * appended "Do NOT open it again", so a caller met both sentences in one reason string.
 */
describe('what the refusal tells a caller to do next', () => {
  it('never tells a caller to open the pull request again', async () => {
    await expect(project({ headSha: null })).rejects.toThrow(/Do NOT open it again/);
    await expect(project({ headSha: null })).rejects.not.toThrow(/opening it again after/);
  });
});
