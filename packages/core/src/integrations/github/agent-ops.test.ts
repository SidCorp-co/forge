/**
 * The six verbs, the one refusal, and the request each of them actually makes.
 *
 * ISS-1074 criteria 4 to 12, 16 and 17. The client is a recorder rather than a stub that returns
 * whatever is asked of it: what half of these cases are about is the PATH and the METHOD, and a
 * client that answered without recording would let every one of them pass with the request deleted.
 */

import { describe, expect, it } from 'vitest';
import type { GitHubAgentClient } from './agent-client.js';
import { GitHubAgentCallError } from './agent-client.js';
import {
  actionsJobId,
  isKernelVerb,
  kernelVerbRefusal,
  openPullRequest,
  readCheckRunLog,
  readPullRequestDiff,
  requestReview,
  submitReview,
  tailLines,
  writePullRequestComment,
} from './agent-ops.js';

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
  accept?: string;
  keep?: 'head' | 'tail';
}

function recorder(answers: {
  json?: (args: { method: string; path: string; body?: unknown }) => unknown;
  text?: (args: { path: string; accept: string; maxBytes: number; keep?: 'head' | 'tail' }) => {
    body: string;
    bytes: number;
    truncated: boolean;
  };
}): { client: GitHubAgentClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client: GitHubAgentClient = {
    bindingId: 'bind-1',
    owner: 'SidCorp-co',
    repo: 'forge-dev',
    fullName: 'SidCorp-co/forge-dev',
    async json<T>(args: { method: string; path: string; body?: unknown }): Promise<T> {
      calls.push({ method: args.method, path: args.path, body: args.body });
      return (answers.json?.(args) ?? {}) as T;
    },
    // The recorder redacts, because the real `text` does: ISS-1074's review found the redaction
    // living in ONE of its two callers, and it now runs on everything the client read, before the
    // cap and before any caller's tail. A recorder handing back raw text would let a caller that
    // depends on that pass with the redaction deleted.
    async text(args: { path: string; accept: string; maxBytes: number; keep?: 'head' | 'tail' }) {
      calls.push({
        method: 'GET',
        path: args.path,
        accept: args.accept,
        ...(args.keep ? { keep: args.keep } : {}),
      });
      const got = answers.text?.(args) ?? { body: '', bytes: 0, truncated: false };
      return { ...got, body: got.body.replace(/ghs_[A-Za-z0-9_]+/g, '[Filtered]') };
    },
    async scrub(text: string) {
      return text.replace(/ghs_[A-Za-z0-9_]+/g, '[Filtered]');
    },
  };
  return { client, calls };
}

const ACTIONS_URL = 'https://github.com/SidCorp-co/forge-dev/actions/runs/900/job/12345';

describe('reading a pull request', () => {
  it('asks for the diff media type and reports the whole size beside what came back', async () => {
    const { client, calls } = recorder({
      text: () => ({ body: 'diff --git', bytes: 900_000, truncated: true }),
    });
    await expect(readPullRequestDiff(client, { number: 481 })).resolves.toEqual({
      number: 481,
      repository: 'SidCorp-co/forge-dev',
      bytes: 900_000,
      truncated: true,
      diff: 'diff --git',
    });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/repos/SidCorp-co/forge-dev/pulls/481',
      accept: 'application/vnd.github.v3.diff',
    });
  });
});

describe('the Actions job a check run names', () => {
  it('reads the job id out of the details URL', () => {
    expect(actionsJobId(ACTIONS_URL)).toBe(12345);
  });

  it('answers null for a URL that names no job, rather than guessing one', () => {
    expect(actionsJobId('https://circleci.example/build/77')).toBeNull();
    expect(actionsJobId('https://github.com/o/r/actions/runs/900')).toBeNull();
    expect(actionsJobId(null)).toBeNull();
    expect(actionsJobId(undefined)).toBeNull();
  });
});

describe('tailing', () => {
  it('keeps the last n lines and says it dropped some', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toEqual({ text: 'c\nd', truncated: true });
  });
  it('leaves a short text alone and says so', () => {
    expect(tailLines('a\nb', 5)).toEqual({ text: 'a\nb', truncated: false });
  });
});

describe('reading a check run s log', () => {
  // ISS-1074 criteria 6 and 7.
  it('fetches the Actions job log, scrubs it and tails it to the lines asked for', async () => {
    const { client, calls } = recorder({
      json: () => ({
        id: 77,
        name: 'ci-passed',
        status: 'completed',
        conclusion: 'failure',
        details_url: ACTIONS_URL,
        app: { slug: 'github-actions' },
        output: { summary: '3 of 11 jobs failed' },
      }),
      text: () => ({
        body: 'line1 ghs_leaked_token\nline2\nline3\nline4',
        bytes: 40,
        truncated: false,
      }),
    });

    const got = await readCheckRunLog(client, { checkRunId: 77, lines: 2 });
    expect(got.log).toBe('line3\nline4');
    expect(got.truncated).toBe(true);
    expect(got.refusal).toBeNull();
    expect(got.conclusion).toBe('failure');
    expect(calls[1]?.path).toBe('/repos/SidCorp-co/forge-dev/actions/jobs/12345/logs');
  });

  // Answers finding F4 of ISS-1074's whole-set review. The cap and the tail are the same
  // requirement at two scales, and the cap was the one reading from the wrong end: a log past
  // `LOG_CAP_BYTES` gave this function its first 2 MiB, whose last hundred lines are output from
  // before the failure the caller asked to see.
  it('asks GitHub s answer to be kept from its END, which is where a failure is', async () => {
    const { client, calls } = recorder({
      json: () => ({ details_url: ACTIONS_URL, app: { slug: 'github-actions' } }),
      text: () => ({ body: 'earlier\nFAILED here', bytes: 19, truncated: false }),
    });
    const got = await readCheckRunLog(client, { checkRunId: 77, lines: 1 });
    expect(calls[1]?.keep).toBe('tail');
    expect(got.log).toBe('FAILED here');
  });

  it('scrubs before it tails, so a credential on a dropped line is still not returned', async () => {
    const { client } = recorder({
      json: () => ({ details_url: ACTIONS_URL, app: { slug: 'github-actions' } }),
      text: () => ({ body: 'ghs_leaked_token\nkept', bytes: 20, truncated: false }),
    });
    const got = await readCheckRunLog(client, { checkRunId: 77, lines: 5 });
    expect(got.log).toBe('[Filtered]\nkept');
  });

  // ISS-1074 criterion 8 — the absence with a reason beside it, never an empty log.
  it('refuses by name for a check run that is not an Actions job, and keeps its summary', async () => {
    const { client, calls } = recorder({
      json: () => ({
        name: 'codecov/patch',
        details_url: 'https://app.codecov.io/gh/SidCorp-co/forge-dev/pull/481',
        app: { slug: 'codecov' },
        output: { summary: 'coverage dropped 0.2%' },
      }),
    });
    const got = await readCheckRunLog(client, { checkRunId: 88 });
    expect(got.log).toBeNull();
    expect(got.refusal).toContain('codecov');
    expect(got.refusal).toContain('https://app.codecov.io/gh/SidCorp-co/forge-dev/pull/481');
    expect(got.summary).toBe('coverage dropped 0.2%');
    expect(calls).toHaveLength(1);
  });

  it('names the status GitHub answered when the log itself cannot be fetched', async () => {
    const { client } = recorder({
      json: () => ({ details_url: ACTIONS_URL, app: { slug: 'github-actions' } }),
      text: () => {
        throw new GitHubAgentCallError(410, 'GET …/logs returned HTTP 410');
      },
    });
    const got = await readCheckRunLog(client, { checkRunId: 77 });
    expect(got.log).toBeNull();
    expect(got.refusal).toContain('410');
    expect(got.refusal).toContain('expired');
  });
});

describe('writing', () => {
  it('writes a comment on the conversation thread, not on a diff line', async () => {
    const { client, calls } = recorder({ json: () => ({ id: 5, html_url: 'https://gh/c/5' }) });
    await expect(
      writePullRequestComment(client, { number: 481, body: 'looks right' }),
    ).resolves.toEqual({ commentId: 5, url: 'https://gh/c/5' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/repos/SidCorp-co/forge-dev/issues/481/comments',
      body: { body: 'looks right' },
    });
  });

  it('opens a pull request and reports the refs GitHub recorded', async () => {
    const { client, calls } = recorder({
      json: () => ({
        number: 490,
        html_url: 'https://gh/pr/490',
        state: 'open',
        draft: true,
        head: { ref: 'ISS-1074' },
        base: { ref: 'main' },
      }),
    });
    await expect(
      openPullRequest(client, { head: 'ISS-1074', base: 'main', title: 'T', draft: true }),
    ).resolves.toMatchObject({ number: 490, draft: true, headRef: 'ISS-1074', baseRef: 'main' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/repos/SidCorp-co/forge-dev/pulls',
      body: { title: 'T', head: 'ISS-1074', base: 'main', draft: true },
    });
  });

  it('requests named reviewers and teams, and reports what GitHub now holds', async () => {
    const { client, calls } = recorder({
      json: () => ({
        requested_reviewers: [{ login: 'junixlabs' }],
        requested_teams: [{ slug: 'core' }],
      }),
    });
    await expect(
      requestReview(client, { number: 481, reviewers: ['junixlabs'], teamReviewers: ['core'] }),
    ).resolves.toEqual({
      number: 481,
      requestedReviewers: ['junixlabs'],
      requestedTeams: ['core'],
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/repos/SidCorp-co/forge-dev/pulls/481/requested_reviewers',
      body: { reviewers: ['junixlabs'], team_reviewers: ['core'] },
    });
  });

  // The head ref is not decoration: it is what resolves the issue a review's tracker record is
  // written onto, so a submit that stopped reading the pull request would take the second half of
  // "one record instead of two" with it.
  it('reads the pull request for its head branch before submitting the verdict', async () => {
    const { client, calls } = recorder({
      json: (args) =>
        args.method === 'GET'
          ? { head: { ref: 'ISS-1074-mcp-face' } }
          : {
              id: 9001,
              state: 'CHANGES_REQUESTED',
              html_url: 'https://gh/r/9001',
              user: { login: 'forge[bot]' },
            },
    });
    const got = await submitReview(client, { number: 481, event: 'REQUEST_CHANGES', body: 'no' });
    expect(got).toMatchObject({
      reviewId: 9001,
      state: 'changes_requested',
      headRef: 'ISS-1074-mcp-face',
      number: 481,
      repository: 'SidCorp-co/forge-dev',
    });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/repos/SidCorp-co/forge-dev/pulls/481',
    });
    expect(calls[1]).toMatchObject({
      method: 'POST',
      path: '/repos/SidCorp-co/forge-dev/pulls/481/reviews',
      body: { event: 'REQUEST_CHANGES', body: 'no' },
    });
  });
});

describe('nothing on this face merges', () => {
  // ISS-1074 criterion 16.
  it('recognises the kernel verbs in order to answer them by name', () => {
    for (const verb of ['merge', 'close', 'delete-branch', 'squash', 'rebase']) {
      expect(isKernelVerb(verb)).toBe(true);
    }
    expect(isKernelVerb('review')).toBe(false);
    expect(isKernelVerb('diff')).toBe(false);
  });

  it('says where the merge lives rather than that the verb is unknown, quoting the name given', () => {
    const said = kernelVerbRefusal('merge');
    expect(said).toContain('pull_request.merge');
    expect(said).not.toContain('ISS-1073');
    expect(said).toContain('DISPATCH face');
    expect(said).toContain('merged_at');
    expect(kernelVerbRefusal('merge-pull-request')).toContain('merge-pull-request');
  });

  // ISS-1074 criterion 17. Driven rather than grepped: every verb is run against one recorder and
  // the whole set of requests is judged, so a merge added inside any of them is caught even where
  // the file never writes the word.
  it('makes no request that could land a change, across every verb', async () => {
    const { client, calls } = recorder({
      json: (args) =>
        args.path.endsWith('/pulls/481')
          ? { head: { ref: 'ISS-1074' } }
          : { id: 1, number: 490, head: { ref: 'x' }, base: { ref: 'main' } },
      text: () => ({ body: '', bytes: 0, truncated: false }),
    });
    await readPullRequestDiff(client, { number: 481 });
    await writePullRequestComment(client, { number: 481, body: 'b' });
    await openPullRequest(client, { head: 'h', base: 'main', title: 't' });
    await requestReview(client, { number: 481, reviewers: ['x'] });
    await submitReview(client, { number: 481, event: 'COMMENT', body: 'b' });
    await readCheckRunLog(client, { checkRunId: 1 }).catch(() => undefined);

    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      expect(call.method).not.toBe('PUT');
      expect(call.method).not.toBe('DELETE');
      expect(call.path).not.toMatch(/\/merge\b/);
      expect(call.path).not.toMatch(/\/git\/refs\b/);
    }
  });
});
