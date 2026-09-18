/**
 * The five acts on the repository: what each one sends, and what each refusal
 * lets the sequence conclude about the world.
 *
 * The distinction these assertions exist for is `beforeWrite`. A read that
 * failed proves nothing was written; a create that timed out proves nothing at
 * all. Collapsing them is how a retry cuts over a tag that already exists.
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const { GitHubPublishError } = await import('./client.js');
const {
  createTagRef,
  readCommitSha,
  readDefaultBranch,
  readFileAtRef,
  readReleaseForTag,
  readTagRef,
  RunnerReleaseRepoError,
  runnerReleaseSubject,
  saysRefExists,
  tagRefName,
} = await import('./runner-release-repo.js');

type Call = { op: string; method: string; path: string; body?: unknown };

function stubClient(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client = {
    bindingId: 'binding-1',
    appId: '7',
    owner: 'SidCorp-co',
    repo: 'forge',
    fullName: 'SidCorp-co/forge',
    get: async () => {
      throw new Error('the release path never uses get()');
    },
    publish: async (call: Call) => {
      calls.push(call);
      const out = answer(call);
      if (out instanceof Error) throw out;
      return out;
    },
  } as never;
  return { client, calls };
}

const contents = (text: string) => ({
  content: Buffer.from(text, 'utf8').toString('base64'),
  encoding: 'base64',
});

describe('the reads', () => {
  it('asks for the repository, then the head of the branch it named', async () => {
    const { client, calls } = stubClient((call) =>
      call.path === '/repos/SidCorp-co/forge' ? { default_branch: 'main' } : { sha: 'deadbee' },
    );
    expect(await readDefaultBranch(client)).toBe('main');
    expect(await readCommitSha(client, 'main')).toBe('deadbee');
    expect(calls.map((c) => c.path)).toEqual([
      '/repos/SidCorp-co/forge',
      '/repos/SidCorp-co/forge/commits/main',
    ]);
    expect(calls.every((c) => c.method === 'GET' && c.op === 'lookup')).toBe(true);
  });

  it('decodes a file at a ref', async () => {
    const { client, calls } = stubClient(() =>
      contents('[workspace.package]\nversion = "0.13.2"\n'),
    );
    const text = await readFileAtRef(client, 'packages/runner/Cargo.toml', 'abc1234');
    expect(text).toContain('version = "0.13.2"');
    expect(calls[0]?.path).toBe(
      '/repos/SidCorp-co/forge/contents/packages/runner/Cargo.toml?ref=abc1234',
    );
  });

  // cm:guard the contents API answers `encoding: "none"` and an empty body for a file over 1MB instead of failing. Decoding that gives an empty string, and every version check over an empty string passes — so the refusal here is what keeps a file nobody could read from reading as agreement.
  it('refuses a file GitHub served with no content rather than reading it as empty', async () => {
    const { client } = stubClient(() => ({ encoding: 'none', content: '' }));
    await expect(readFileAtRef(client, 'packages/runner/Cargo.lock', 'abc1234')).rejects.toThrow(
      /carries no content/,
    );
  });

  it('reads a missing tag as absence and a present one as its commit', async () => {
    const absent = stubClient(
      () => new GitHubPublishError({ op: 'lookup', status: 404, message: 'no ref' }),
    );
    expect(await readTagRef(absent.client, 'runner-v9.9.9')).toBeNull();
    const present = stubClient(() => ({ object: { sha: 'abc1234' } }));
    expect(await readTagRef(present.client, 'runner-v0.13.2')).toEqual({ sha: 'abc1234' });
  });

  it('reads a missing release as absence and a present one as its assets', async () => {
    const absent = stubClient(
      () => new GitHubPublishError({ op: 'lookup', status: 404, message: 'no release' }),
    );
    expect(await readReleaseForTag(absent.client, 'runner-v9.9.9')).toBeNull();
    const present = stubClient(() => ({
      html_url: 'https://github.com/SidCorp-co/forge/releases/tag/runner-v0.13.2',
      draft: false,
      prerelease: false,
      assets: [{ name: 'forge-runner-x86_64-unknown-linux-gnu' }, { name: 'VERSION' }, {}],
    }));
    expect(await readReleaseForTag(present.client, 'runner-v0.13.2')).toEqual({
      htmlUrl: 'https://github.com/SidCorp-co/forge/releases/tag/runner-v0.13.2',
      draft: false,
      prerelease: false,
      assetNames: ['forge-runner-x86_64-unknown-linux-gnu', 'VERSION'],
    });
  });

  it('carries a read refusal out as one that provably wrote nothing', async () => {
    const { client } = stubClient(
      () => new GitHubPublishError({ op: 'lookup', status: 403, message: 'forbidden' }),
    );
    await expect(readTagRef(client, 'runner-v0.13.3')).rejects.toBeInstanceOf(
      RunnerReleaseRepoError,
    );
    const err = await readTagRef(client, 'runner-v0.13.3').catch((e) => e);
    expect(err.beforeWrite).toBe(true);
  });
});

describe('the one write', () => {
  it('creates the tag ref as the App, at the commit it was given', async () => {
    const { client, calls } = stubClient(() => ({ object: { sha: 'abc1234' } }));
    expect(await createTagRef(client, 'runner-v0.13.3', 'abc1234')).toEqual({ sha: 'abc1234' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      op: 'create',
      method: 'POST',
      path: '/repos/SidCorp-co/forge/git/refs',
      body: { ref: 'refs/tags/runner-v0.13.3', sha: 'abc1234' },
    });
    expect(tagRefName('runner-v0.13.3')).toBe('refs/tags/runner-v0.13.3');
  });

  // cm:guard a create that GitHub ANSWERED wrote nothing; a create that timed out may have. These two assertions are the whole basis of `tag_state` in `runner-release.ts`, and folding them is how a second attempt cuts over a tag that already exists.
  it('says an answered refusal wrote nothing and a timeout may have', async () => {
    const answered = stubClient(
      () => new GitHubPublishError({ op: 'create', status: 403, message: 'forbidden' }),
    );
    const a = await createTagRef(answered.client, 'runner-v0.13.3', 'abc1234').catch((e) => e);
    expect(a).toBeInstanceOf(RunnerReleaseRepoError);
    expect(a.beforeWrite).toBe(false);
    expect(a.refusal.status).toBe(403);

    const timedOut = stubClient(
      () => new GitHubPublishError({ op: 'create', timedOut: true, message: 'timed out' }),
    );
    const t = await createTagRef(timedOut.client, 'runner-v0.13.3', 'abc1234').catch((e) => e);
    expect(t.beforeWrite).toBe(false);
    expect(t.refusal.cause).toBe('timed-out-mid-write');
    expect(t.refusal.status).toBeNull();
  });

  it('knows a 422 that says the ref is already there', async () => {
    const { client } = stubClient(
      () =>
        new GitHubPublishError({
          op: 'create',
          status: 422,
          detail: '{"message":"Reference already exists"}',
          message: 'POST /git/refs returned HTTP 422',
        }),
    );
    const err = await createTagRef(client, 'runner-v0.13.3', 'abc1234').catch((e) => e);
    expect(saysRefExists(err.refusal)).toBe(true);
  });

  // cm:guard the refusal this case builds is the REAL one, through `describePublishRefusal`, and that is the whole point: Forge's own 422 sentence ends "usually a ref that already exists, or a commit this repository does not hold", so a test matching a hand-written message passes over a function that matches every 422 alike. Here GitHub says the commit is missing, and reading that as a tag already on the repository records `present` for a tag nobody cut and refuses the version for ever.
  it('does NOT read a 422 about a missing commit as a ref that already exists', async () => {
    const { client } = stubClient(
      () =>
        new GitHubPublishError({
          op: 'create',
          status: 422,
          detail: '{"message":"Object does not exist"}',
          message: 'POST /git/refs returned HTTP 422',
        }),
    );
    const err = await createTagRef(client, 'runner-v0.13.3', 'deadbee').catch((e) => e);
    expect(err.refusal.status).toBe(422);
    expect(err.refusal.message).toContain('already exists');
    expect(err.refusal.detail).toContain('Object does not exist');
    expect(saysRefExists(err.refusal)).toBe(false);
  });
});

describe('a 404 that is not the thing being absent', () => {
  // cm:guard `client.publish` mints an installation token before every call and raises the mint's own failure as a `GitHubPublishError` too, so a 404 from the mint — an installation that no longer exists — is byte-identical in status to a tag that is not there. Reading it as absence tells the sequence the tag is missing on a repository Forge could not reach at all, and tells a completed build's publication reading that GitHub holds no release.
  it('refuses a mint 404 rather than reading it as a missing tag', async () => {
    const { client } = stubClient(
      () =>
        new GitHubPublishError({
          op: 'mint',
          status: 404,
          message: 'this App has no installation on SidCorp-co/forge',
        }),
    );
    const err = await readTagRef(client, 'runner-v0.13.3').catch((e) => e);
    expect(err).toBeInstanceOf(RunnerReleaseRepoError);
    expect(err.refusal.cause).toBe('installation-missing');
    expect(err.beforeWrite).toBe(true);
  });

  it('refuses a mint 404 rather than reading it as a missing release', async () => {
    const { client } = stubClient(
      () =>
        new GitHubPublishError({
          op: 'mint',
          status: 404,
          message: 'this App has no installation on SidCorp-co/forge',
        }),
    );
    await expect(readReleaseForTag(client, 'runner-v0.13.3')).rejects.toBeInstanceOf(
      RunnerReleaseRepoError,
    );
  });
});

describe('the refusal sentences this path uses', () => {
  // cm:guard the App holds both `checks: write` and `contents: write`, GitHub answers 403 on either identically, and the two sentences send an operator to two different rows of the same settings page. Naming the wrong one costs the afternoon.
  it('name `contents: write` and never `checks: write`', () => {
    const subject = runnerReleaseSubject({ lookup: 'looking the tag up' });
    expect(subject.permission).toContain('contents: write');
    expect(subject.permission).not.toContain('checks: write');
    expect(subject.ambiguous).toContain('contents: write');
    expect(subject.nothingWritten).toContain('nothing was written to the repository');
    expect(subject.where.create).toBe('creating the tag');
    expect(subject.where.lookup).toBe('looking the tag up');
  });
});
