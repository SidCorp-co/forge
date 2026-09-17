/**
 * `forge_github`: which action reaches which verb, who has to be who, and the two things a caller
 * must be told rather than left to infer — that a binding exists and no agent may use it, and that
 * merging is not here and will not become here.
 *
 * ISS-1074 criteria 3, 13, 14, 16 and 19.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const resultQueue: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal chainable drizzle stub
function makeThenable(): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const p: any = {
    from: () => p,
    innerJoin: () => p,
    leftJoin: () => p,
    where: () => p,
    orderBy: () => p,
    limit: () => p,
    then: (resolve: (v: unknown) => void) => resolve(resultQueue.shift() ?? []),
  };
  return p;
}

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => makeThenable()) },
}));

const bindingsSpy = vi.fn();
const clientSpy = vi.fn();
vi.mock('../../integrations/github/agent-client.js', async () => {
  const real = await vi.importActual<typeof import('../../integrations/github/agent-client.js')>(
    '../../integrations/github/agent-client.js',
  );
  return {
    ...real,
    githubAgentBindings: (...a: unknown[]) => bindingsSpy(...(a as [])),
    githubAgentClient: (...a: unknown[]) => clientSpy(...(a as [])),
  };
});

const diffSpy = vi.fn();
const logSpy = vi.fn();
const commentSpy = vi.fn();
const openSpy = vi.fn();
const requestSpy = vi.fn();
const reviewSpy = vi.fn();
vi.mock('../../integrations/github/agent-ops.js', async () => {
  const real = await vi.importActual<typeof import('../../integrations/github/agent-ops.js')>(
    '../../integrations/github/agent-ops.js',
  );
  return {
    ...real,
    readPullRequestDiff: (...a: unknown[]) => diffSpy(...(a as [])),
    readCheckRunLog: (...a: unknown[]) => logSpy(...(a as [])),
    writePullRequestComment: (...a: unknown[]) => commentSpy(...(a as [])),
    openPullRequest: (...a: unknown[]) => openSpy(...(a as [])),
    requestReview: (...a: unknown[]) => requestSpy(...(a as [])),
    submitReview: (...a: unknown[]) => reviewSpy(...(a as [])),
  };
});

const noteSpy = vi.fn();
vi.mock('../../integrations/github/review-note.js', () => ({
  noteReviewOnIssue: (...a: unknown[]) => noteSpy(...(a as [])),
}));

const { forgeGithubTool } = await import('./forge-github.js');
const { GitHubAgentRefusal } = await import('../../integrations/github/agent-client.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

function tool() {
  return forgeGithubTool({ principal: fakePrincipal, projectSlug: null });
}

function pushMemberOk() {
  resultQueue.push([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

function pushAdminOk() {
  resultQueue.push([{ orgId: 'org-1', memberRole: 'admin', orgRole: null }]);
}

const FAKE_CLIENT = { bindingId: 'b', owner: 'o', repo: 'r', fullName: 'o/r' };

beforeEach(() => {
  vi.clearAllMocks();
  resultQueue.length = 0;
  clientSpy.mockResolvedValue(FAKE_CLIENT);
});

describe('forge_github routing', () => {
  it('list reads the project s bindings and never builds a client', async () => {
    pushMemberOk();
    bindingsSpy.mockResolvedValue([]);
    await tool().handler({ action: 'list', projectId: PROJECT_ID });
    expect(bindingsSpy).toHaveBeenCalledWith(PROJECT_ID);
    expect(clientSpy).not.toHaveBeenCalled();
  });

  it('diff reaches the diff read with the pull request number', async () => {
    pushMemberOk();
    diffSpy.mockResolvedValue({ number: 481 });
    await tool().handler({ action: 'diff', projectId: PROJECT_ID, pullRequest: 481 });
    expect(diffSpy).toHaveBeenCalledWith(FAKE_CLIENT, { number: 481 });
  });

  it('check-log passes lines through, and omits it when the caller named none', async () => {
    pushMemberOk();
    logSpy.mockResolvedValue({ log: null });
    await tool().handler({
      action: 'check-log',
      projectId: PROJECT_ID,
      checkRunId: 77,
      lines: 250,
    });
    expect(logSpy).toHaveBeenCalledWith(FAKE_CLIENT, { checkRunId: 77, lines: 250 });

    pushMemberOk();
    await tool().handler({ action: 'check-log', projectId: PROJECT_ID, checkRunId: 77 });
    expect(logSpy).toHaveBeenLastCalledWith(FAKE_CLIENT, { checkRunId: 77 });
  });

  it('comment, open-pull-request and request-review reach their own verb', async () => {
    pushAdminOk();
    commentSpy.mockResolvedValue({ commentId: 1 });
    await tool().handler({
      action: 'comment',
      projectId: PROJECT_ID,
      pullRequest: 481,
      body: 'b',
    });
    expect(commentSpy).toHaveBeenCalledWith(FAKE_CLIENT, { number: 481, body: 'b' });

    pushAdminOk();
    openSpy.mockResolvedValue({ number: 490 });
    await tool().handler({
      action: 'open-pull-request',
      projectId: PROJECT_ID,
      head: 'ISS-1074',
      base: 'main',
      title: 'T',
    });
    expect(openSpy).toHaveBeenCalledWith(FAKE_CLIENT, {
      head: 'ISS-1074',
      base: 'main',
      title: 'T',
    });

    pushAdminOk();
    requestSpy.mockResolvedValue({ number: 481 });
    await tool().handler({
      action: 'request-review',
      projectId: PROJECT_ID,
      pullRequest: 481,
      reviewers: ['junixlabs'],
    });
    expect(requestSpy).toHaveBeenCalledWith(FAKE_CLIENT, {
      number: 481,
      reviewers: ['junixlabs'],
    });
  });
});

describe('a review through this tool is the same one record', () => {
  // ISS-1074 criterion 19 — the tool does not write its own comment; it calls the writer a human's
  // review arriving by webhook calls, so there is one of them and not two.
  it('hands the submitted review to the one writer, with the head branch it came back on', async () => {
    pushAdminOk();
    reviewSpy.mockResolvedValue({
      reviewId: 9001,
      state: 'approved',
      url: 'https://gh/r/9001',
      submittedAt: '2026-09-17T10:00:00Z',
      reviewer: 'forge[bot]',
      headRef: 'ISS-1074-mcp-face',
      number: 481,
      repository: 'SidCorp-co/forge-dev',
    });
    noteSpy.mockResolvedValue({ outcome: 'written', issueId: 'i-1', commentId: 'c-1' });

    const answered = (await tool().handler({
      action: 'review',
      projectId: PROJECT_ID,
      pullRequest: 481,
      verdict: 'APPROVE',
      body: 'ship it',
    })) as { issueComment: { outcome: string } };

    expect(noteSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      headRef: 'ISS-1074-mcp-face',
      repository: 'SidCorp-co/forge-dev',
      number: 481,
      review: expect.objectContaining({ id: '9001', body: 'ship it', reviewer: 'forge[bot]' }),
    });
    expect(answered.issueComment.outcome).toBe('written');
  });

  it('reports the verdict even when GitHub named no head branch to resolve an issue from', async () => {
    pushAdminOk();
    reviewSpy.mockResolvedValue({
      reviewId: 9002,
      headRef: '',
      number: 481,
      repository: 'SidCorp-co/forge-dev',
    });
    const answered = (await tool().handler({
      action: 'review',
      projectId: PROJECT_ID,
      pullRequest: 481,
      verdict: 'COMMENT',
      body: 'note',
    })) as { reviewId: number; issueComment: { outcome: string } };
    expect(answered.reviewId).toBe(9002);
    expect(answered.issueComment.outcome).toBe('no-issue');
    expect(noteSpy).not.toHaveBeenCalled();
  });
});

describe('what a caller is told rather than left to infer', () => {
  // ISS-1074 criterion 16. The assertion is on the SENTENCE, not on the rejection: a `z.enum` that
  // simply omits `merge` also rejects, with a list of seven strings and no reason.
  it('answers merge with where the merge lives, before the schema is consulted', async () => {
    await expect(
      tool().handler({ action: 'merge', projectId: PROJECT_ID, pullRequest: 481 }),
    ).rejects.toThrow(/ISS-1073/);
    await expect(
      tool().handler({ action: 'delete-branch', projectId: PROJECT_ID }),
    ).rejects.toThrow(/kernel transition/);
    expect(clientSpy).not.toHaveBeenCalled();
  });

  // ISS-1074 criterion 14 — the refusal reaches the caller as a sentence naming the binding and the
  // switch, rather than as a bare failure.
  it('passes an ungranted binding s refusal through, naming the binding', async () => {
    pushMemberOk();
    clientSpy.mockRejectedValue(
      new GitHubAgentRefusal('not_granted', 'binding bind-7 (github) is connected but…', 'bind-7'),
    );
    await expect(
      tool().handler({ action: 'diff', projectId: PROJECT_ID, pullRequest: 481 }),
    ).rejects.toThrow(/BAD_REQUEST: binding bind-7 \(github\)/);
  });

  it('refuses a request-review that names nobody rather than requesting nobody', async () => {
    pushAdminOk();
    await expect(
      tool().handler({ action: 'request-review', projectId: PROJECT_ID, pullRequest: 481 }),
    ).rejects.toThrow(/needs `reviewers`/);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('refuses a diff with no pull request named rather than picking one', async () => {
    pushMemberOk();
    await expect(tool().handler({ action: 'diff', projectId: PROJECT_ID })).rejects.toThrow(
      /needs `pullRequest`/,
    );
    expect(diffSpy).not.toHaveBeenCalled();
  });

  it('rejects a lines value outside 1..1000 rather than clamping it', async () => {
    pushMemberOk();
    await expect(
      tool().handler({ action: 'check-log', projectId: PROJECT_ID, checkRunId: 7, lines: 5000 }),
    ).rejects.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
