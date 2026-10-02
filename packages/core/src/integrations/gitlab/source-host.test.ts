/**
 * ISS-50 — the GitLab source host, driven against recorded GitLab REST v4 answers. Every case reads
 * the requests the stub received, so a verb that sends the wrong path, method or credential goes red
 * here rather than against a live GitLab.
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const { gitlabSourceHost } = await import('./source-host.js');
const { SourceHostCallError, SourceHostInputRefusal, SourceHostUnavailable } = await import(
  '../source-host/errors.js'
);
const { gitlabStub } = await import('./gitlab-stub.fixture.js');

const TOKEN = 'glpat-recorded-token-0001';
const P = '/projects/autoflow%2Fcore';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function host(answers: Parameters<typeof gitlabStub>[0], config: Record<string, unknown> = {}) {
  const stub = gitlabStub(answers);
  globalThis.fetch = stub.fetchStub;
  const built = gitlabSourceHost.build({
    bindingId: 'bind-gl',
    config: { projectPath: 'autoflow/core', ...config },
    secrets: { token: TOKEN },
  });
  return { host: built, sent: stub.sent };
}

const blobSha = (text: string) => {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

describe('what the GitLab host is', () => {
  it('serves gitlab.com by default and the instance its base URL names otherwise', () => {
    expect(gitlabSourceHost.hostOf({})).toBe('gitlab.com');
    expect(gitlabSourceHost.hostOf({ baseUrl: 'https://git.example.org' })).toBe('git.example.org');
    const { host: h } = host({});
    expect(h.provider).toBe('gitlab');
    expect(h.fullName).toBe('autoflow/core');
    expect(h.words).toMatchObject({ changeRequest: 'merge request', sigil: '!' });
    expect(h.words.mergeMethods).toEqual(['merge', 'squash']);
  });

  it('refuses a binding naming no project, and a connection holding no token, by name', () => {
    expect(() =>
      gitlabSourceHost.build({ bindingId: 'b', config: {}, secrets: { token: TOKEN } }),
    ).toThrow(SourceHostUnavailable);
    try {
      gitlabSourceHost.build({ bindingId: 'b', config: { projectPath: 'a/b' }, secrets: {} });
    } catch (err) {
      expect((err as InstanceType<typeof SourceHostUnavailable>).reason).toBe('no_credential');
    }
  });
});

describe('the kernel reads', () => {
  it('reads a commit with the token, and answers null for one GitLab does not have', async () => {
    const { host: h, sent } = host({
      [`GET ${P}/repository/commits/${SHA}`]: {
        body: {
          id: SHA.toUpperCase(),
          message: 'fix: x (ISS-50)',
          committed_date: '2026-10-01T00:00:00Z',
        },
      },
    });
    expect(await h.readCommit(SHA)).toEqual({
      sha: SHA,
      message: 'fix: x (ISS-50)',
      committedAt: '2026-10-01T00:00:00Z',
    });
    expect(await h.readCommit(OTHER)).toBeNull();
    expect(sent.every((s) => s.token === TOKEN)).toBe(true);
  });

  it('raises a read that failed for another reason than absence, rather than calling it absent', async () => {
    const { host: h } = host({
      [`GET ${P}/repository/commits/${SHA}`]: { status: 502, body: { message: 'bad gateway' } },
    });
    await expect(h.readCommit(SHA)).rejects.toBeInstanceOf(SourceHostCallError);
  });

  it('answers whether a branch contains a commit from every page of its refs', async () => {
    const refs = `GET ${P}/repository/commits/${SHA}/refs?type=branch&per_page=100`;
    const { host: h } = host({
      [`${refs}&page=1`]: {
        body: [{ type: 'branch', name: 'feature' }],
        headers: { 'x-next-page': '2' },
      },
      [`${refs}&page=2`]: {
        body: [{ type: 'branch', name: 'main' }],
        headers: { 'x-next-page': '' },
      },
    });
    expect(await h.branchContains('main', SHA)).toBe(true);
    expect(await h.branchContains('release', SHA)).toBe(false);
  });

  it('compares both ways, so behind and diverged are told apart from ahead', async () => {
    const cmp = (from: string, to: string) => `GET ${P}/repository/compare?from=${from}&to=${to}`;
    const { host: h } = host({
      [cmp('x', 'y')]: { body: { commits: [{ id: SHA }] } },
      [cmp('y', 'x')]: { body: { commits: [] } },
      [cmp('p', 'q')]: { body: { commits: [{ id: SHA }] } },
      [cmp('q', 'p')]: { body: { commits: [{ id: OTHER }] } },
      [cmp('s', 's')]: { body: { commits: [] } },
    });
    expect(await h.compare('x', 'y')).toBe('ahead');
    expect(await h.compare('y', 'x')).toBe('behind');
    expect(await h.compare('p', 'q')).toBe('diverged');
    expect(await h.compare('s', 's')).toBe('identical');
  });

  it('reads what base holds that live lacks, between the two heads by sha', async () => {
    const { host: h } = host({
      [`GET ${P}/repository/branches/staging`]: { body: { commit: { id: SHA } } },
      [`GET ${P}/repository/branches/main`]: { body: { commit: { id: OTHER } } },
      [`GET ${P}/repository/compare?from=${OTHER}&to=${SHA}`]: {
        body: { commits: [{ id: SHA, message: 'feat: y (ISS-50)', parent_ids: [OTHER] }] },
      },
    });
    expect(await h.readDivergence({ baseRef: 'staging', liveRef: 'main' })).toEqual({
      ok: true,
      baseSha: SHA,
      liveSha: OTHER,
      aheadBy: 1,
      commits: [{ sha: SHA, message: 'feat: y (ISS-50)', parents: [OTHER] }],
      complete: true,
    });
  });

  it('answers a divergence it could not read as a refusal carrying the reason', async () => {
    const { host: h } = host({});
    const d = await h.readDivergence({ baseRef: 'staging', liveRef: 'main' });
    expect(d.ok).toBe(false);
  });

  it('reads a file held to the blob id GitLab names, and refuses bytes that are not that blob', async () => {
    const text = '{"openapi":"3.1.0"}';
    const file = `GET ${P}/repository/files/api%2Fopenapi.json?ref=${SHA}`;
    const { host: h } = host({
      [file]: {
        body: {
          size: text.length,
          encoding: 'base64',
          content: Buffer.from(text).toString('base64'),
          blob_id: blobSha(text),
        },
      },
    });
    expect(await h.readFile('api/openapi.json', SHA, 1024)).toBe(text);
    expect(await h.readFile('api/openapi.json', SHA, 4)).toEqual({
      missing: expect.stringContaining('over the 4'),
    });
    expect(await h.readFile('nope.json', SHA, 1024)).toEqual({
      missing: `nope.json does not exist at ${SHA}`,
    });

    const tampered = host({
      [file]: {
        body: {
          size: 3,
          encoding: 'base64',
          content: Buffer.from('lie').toString('base64'),
          blob_id: blobSha(text),
        },
      },
    });
    await expect(tampered.host.readFile('api/openapi.json', SHA, 1024)).rejects.toThrow(
      /not the file it named/,
    );
  });
});

describe('the agent verbs', () => {
  it('builds the diff from every file, scrubs the token out, and reports the whole length beside a slice', async () => {
    const { host: h } = host({
      [`GET ${P}/merge_requests/7/diffs?per_page=100&page=1`]: {
        body: [{ old_path: 'a.ts', new_path: 'a.ts', diff: `@@ -1 +1 @@\n-x\n+token=${TOKEN}\n` }],
      },
    });
    const whole = await h.diff({ number: 7 });
    expect(whole.diff).toContain('diff --git a/a.ts b/a.ts');
    expect(whole.diff).not.toContain(TOKEN);
    const sliced = await h.diff({ number: 7, maxBytes: 10 });
    expect(sliced).toMatchObject({ truncated: true, bytes: whole.bytes });
    expect(Buffer.byteLength(sliced.diff)).toBeLessThanOrEqual(10);
  });

  it('tails a job trace, and answers a trace GitLab will not serve with a refusal, never an empty log', async () => {
    const job = {
      id: 31,
      name: 'test',
      status: 'failed',
      web_url: 'https://gitlab.com/autoflow/core/-/jobs/31',
      failure_reason: 'script_failure',
    };
    const ok = host({
      [`GET ${P}/jobs/31`]: { body: job },
      [`GET ${P}/jobs/31/trace`]: { text: 'one\ntwo\nthree' },
    });
    expect(await ok.host.checkLog({ checkRunId: 31, lines: 2 })).toMatchObject({
      name: 'test',
      app: 'gitlab-ci',
      status: 'completed',
      conclusion: 'failure',
      summary: 'script_failure',
      log: 'two\nthree',
      truncated: true,
      refusal: null,
    });
    const gone = host({ [`GET ${P}/jobs/31`]: { body: job } });
    const read = await gone.host.checkLog({ checkRunId: 31 });
    expect(read.log).toBeNull();
    expect(read.refusal).toMatch(/HTTP 404/);
  });

  it('writes a note on the merge request and links it', async () => {
    const { host: h, sent } = host({ [`POST ${P}/merge_requests/7/notes`]: { body: { id: 99 } } });
    expect(await h.comment({ number: 7, body: 'looks right' })).toEqual({
      commentId: 99,
      url: 'https://gitlab.com/autoflow/core/-/merge_requests/7#note_99',
    });
    expect(sent[0]?.body).toEqual({ body: 'looks right' });
  });

  it('opens a merge request, marks a draft the way GitLab does, and reads the base when diff_refs is not ready', async () => {
    const { host: h, sent } = host({
      [`POST ${P}/merge_requests`]: {
        body: {
          iid: 12,
          web_url: 'https://gitlab.com/autoflow/core/-/merge_requests/12',
          title: 'Draft: x',
          state: 'opened',
          draft: true,
          source_branch: 'ISS-50-x',
          target_branch: 'main',
          sha: SHA,
          diff_refs: null,
          updated_at: '2026-10-02T00:00:00Z',
        },
      },
      [`GET ${P}/repository/branches/main`]: { body: { commit: { id: OTHER } } },
    });
    const opened = await h.openChangeRequest({
      head: 'ISS-50-x',
      base: 'main',
      title: 'x',
      draft: true,
    });
    expect(sent[0]?.body).toEqual({
      source_branch: 'ISS-50-x',
      target_branch: 'main',
      title: 'Draft: x',
    });
    expect(opened).toMatchObject({
      number: 12,
      state: 'open',
      draft: true,
      headSha: SHA,
      baseSha: OTHER,
      headRef: 'ISS-50-x',
    });
  });

  it('refuses team reviewers and an unknown username by name, and adds to the reviewers already asked', async () => {
    const { host: h, sent } = host({
      'GET /users?username=owner': { body: [{ id: 5, username: 'owner' }] },
      'GET /users?username=ghost': { body: [] },
      [`GET ${P}/merge_requests/7`]: { body: { reviewers: [{ id: 2, username: 'bot' }] } },
      [`PUT ${P}/merge_requests/7`]: (req) => ({
        body: {
          reviewers: (req.body as { reviewer_ids: number[] }).reviewer_ids.map((id) => ({
            id,
            username: id === 5 ? 'owner' : 'bot',
          })),
        },
      }),
    });
    await expect(h.requestReview({ number: 7, teamReviewers: ['core'] })).rejects.toBeInstanceOf(
      SourceHostInputRefusal,
    );
    await expect(h.requestReview({ number: 7, reviewers: ['ghost'] })).rejects.toThrow(
      /no user `ghost`/,
    );
    const asked = await h.requestReview({ number: 7, reviewers: ['owner'] });
    expect(sent.find((s) => s.method === 'PUT')?.body).toEqual({ reviewer_ids: [2, 5] });
    expect(asked.requestedReviewers).toEqual(['bot', 'owner']);
  });

  it('approves at the judged head and notes the verdict, and refuses a request-changes verdict GitLab has no verb for', async () => {
    const { host: h, sent } = host({
      [`GET ${P}/merge_requests/7`]: { body: { sha: SHA, source_branch: 'ISS-50-x' } },
      [`POST ${P}/merge_requests/7/approve`]: { body: {} },
      [`POST ${P}/merge_requests/7/notes`]: {
        body: { id: 41, created_at: '2026-10-02T00:00:00Z' },
      },
      'GET /user': { body: { username: 'forge-bot' } },
    });
    const review = await h.submitReview({ number: 7, event: 'APPROVE', body: 'ship it' });
    expect(sent.find((s) => s.path.endsWith('/approve'))?.body).toEqual({ sha: SHA });
    expect(review).toMatchObject({
      reviewId: 41,
      state: 'approved',
      reviewer: 'forge-bot',
      headRef: 'ISS-50-x',
      number: 7,
    });
    await expect(
      h.submitReview({ number: 7, event: 'REQUEST_CHANGES', body: 'no' }),
    ).rejects.toThrow(/no request-changes verdict/);
  });
});
