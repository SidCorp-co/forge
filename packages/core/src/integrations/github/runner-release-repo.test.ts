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

  it('refuses a file GitHub served with no content rather than reading it as empty', async () => {
    const { client } = stubClient(() => ({ encoding: 'none', content: '' }));
    await expect(readFileAtRef(client, 'packages/runner/Cargo.lock', 'abc1234')).rejects.toThrow(
      /carries no content/,
    );
  });

  it('reads a missing tag as absence and a lightweight one as its commit', async () => {
    const absent = stubClient((call) =>
      call.path.includes('/git/ref/tags/')
        ? new GitHubPublishError({ op: 'lookup', status: 404, message: 'no ref' })
        : { id: 7, default_branch: 'main' },
    );
    expect(await readTagRef(absent.client, 'runner-v9.9.9')).toBeNull();
    expect(absent.calls.map((c) => c.path)).toEqual([
      '/repos/SidCorp-co/forge/git/ref/tags/runner-v9.9.9',
      '/repos/SidCorp-co/forge',
    ]);
    const present = stubClient(() => ({ object: { sha: 'abc1234', type: 'commit' } }));
    expect(await readTagRef(present.client, 'runner-v0.13.2')).toEqual({ sha: 'abc1234' });
  });

  it('refuses a peel that 404s rather than reading the tag as absent', async () => {
    const { client } = stubClient((call) =>
      call.path.includes('/git/ref/tags/')
        ? { object: { sha: 'tagobj1', type: 'tag' } }
        : new GitHubPublishError({ op: 'lookup', status: 404, message: 'no object' }),
    );
    const err = await readTagRef(client, 'runner-v0.14.0').catch((e) => e);
    expect(err).toBeInstanceOf(RunnerReleaseRepoError);
    expect(err.beforeWrite).toBe(true);
  });

  it('peels an annotated tag to the commit it points at', async () => {
    const { client, calls } = stubClient((call) =>
      call.path.includes('/git/ref/tags/')
        ? { object: { sha: 'tagobj1', type: 'tag' } }
        : { object: { sha: 'abc1234', type: 'commit' } },
    );
    expect(await readTagRef(client, 'runner-v0.14.0')).toEqual({ sha: 'abc1234' });
    expect(calls.map((c) => c.path)).toEqual([
      '/repos/SidCorp-co/forge/git/ref/tags/runner-v0.14.0',
      '/repos/SidCorp-co/forge/git/tags/tagobj1',
    ]);
  });

  it('reads a missing release as absence and a present one as its assets', async () => {
    const absent = stubClient((call) =>
      call.path.includes('/releases/tags/')
        ? new GitHubPublishError({ op: 'lookup', status: 404, message: 'no release' })
        : { id: 7 },
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
  /** The tag object answers, so a stub decides only what the REF create does. */
  const onRefCreate = (answer: (call: Call) => unknown) =>
    stubClient((call) => (call.path.endsWith('/git/tags') ? { sha: 'tagobj1' } : answer(call)));

  it('creates an annotated tag as the App, then the ref pointing at it', async () => {
    const { client, calls } = onRefCreate(() => ({ object: { sha: 'tagobj1' } }));
    expect(await createTagRef(client, 'runner-v0.13.3', 'abc1234', 'forge-runner 0.13.3')).toEqual({
      sha: 'tagobj1',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      op: 'create',
      method: 'POST',
      path: '/repos/SidCorp-co/forge/git/tags',
      body: {
        tag: 'runner-v0.13.3',
        message: 'forge-runner 0.13.3',
        object: 'abc1234',
        type: 'commit',
      },
    });
    expect(calls[1]).toEqual({
      op: 'create',
      method: 'POST',
      path: '/repos/SidCorp-co/forge/git/refs',
      body: { ref: 'refs/tags/runner-v0.13.3', sha: 'tagobj1' },
    });
    expect(tagRefName('runner-v0.13.3')).toBe('refs/tags/runner-v0.13.3');
  });

  it('says an answered refusal wrote nothing and a timeout may have', async () => {
    const answered = onRefCreate(
      () => new GitHubPublishError({ op: 'create', status: 403, message: 'forbidden' }),
    );
    const a = await createTagRef(
      answered.client,
      'runner-v0.13.3',
      'abc1234',
      'forge-runner 0.13.3',
    ).catch((e) => e);
    expect(a).toBeInstanceOf(RunnerReleaseRepoError);
    expect(a.beforeWrite).toBe(false);
    expect(a.refusal.status).toBe(403);

    const timedOut = onRefCreate(
      () => new GitHubPublishError({ op: 'create', timedOut: true, message: 'timed out' }),
    );
    const t = await createTagRef(
      timedOut.client,
      'runner-v0.13.3',
      'abc1234',
      'forge-runner 0.13.3',
    ).catch((e) => e);
    expect(t.beforeWrite).toBe(false);
    expect(t.refusal.cause).toBe('timed-out-mid-write');
    expect(t.refusal.status).toBeNull();
  });

  it('says a failure at the tag object wrote no tag, whatever the failure was', async () => {
    const answered = stubClient(
      () => new GitHubPublishError({ op: 'create', status: 403, message: 'forbidden' }),
    );
    const a = await createTagRef(
      answered.client,
      'runner-v0.13.3',
      'abc1234',
      'forge-runner 0.13.3',
    ).catch((e) => e);
    expect(a).toBeInstanceOf(RunnerReleaseRepoError);
    expect(a.beforeWrite).toBe(true);
    expect(answered.calls).toHaveLength(1);

    const timedOut = stubClient(
      () => new GitHubPublishError({ op: 'create', timedOut: true, message: 'timed out' }),
    );
    const t = await createTagRef(
      timedOut.client,
      'runner-v0.13.3',
      'abc1234',
      'forge-runner 0.13.3',
    ).catch((e) => e);
    expect(t.beforeWrite).toBe(true);
    expect(timedOut.calls).toHaveLength(1);
  });

  it('refuses a tag object GitHub answered with no sha', async () => {
    const { client } = stubClient(() => ({}));
    await expect(
      createTagRef(client, 'runner-v0.13.3', 'abc1234', 'forge-runner 0.13.3'),
    ).rejects.toThrow(/named no object/);
  });

  it('knows a 422 that says the ref is already there', async () => {
    const { client } = onRefCreate(
      () =>
        new GitHubPublishError({
          op: 'create',
          status: 422,
          detail: '{"message":"Reference already exists"}',
          message: 'POST /git/refs returned HTTP 422',
        }),
    );
    const err = await createTagRef(
      client,
      'runner-v0.13.3',
      'abc1234',
      'forge-runner 0.13.3',
    ).catch((e) => e);
    expect(saysRefExists(err.refusal)).toBe(true);
  });

  it('does NOT read a 422 about a missing commit as a ref that already exists', async () => {
    const { client } = onRefCreate(
      () =>
        new GitHubPublishError({
          op: 'create',
          status: 422,
          detail: '{"message":"Object does not exist"}',
          message: 'POST /git/refs returned HTTP 422',
        }),
    );
    const err = await createTagRef(
      client,
      'runner-v0.13.3',
      'deadbee',
      'forge-runner 0.13.3',
    ).catch((e) => e);
    expect(err.refusal.status).toBe(422);
    expect(err.refusal.message).toContain('already exists');
    expect(err.refusal.detail).toContain('Object does not exist');
    expect(saysRefExists(err.refusal)).toBe(false);
  });
});

describe('a 404 that is not the thing being absent', () => {
  it('refuses a tag 404 the repository itself will not confirm', async () => {
    const { client } = stubClient(
      () => new GitHubPublishError({ op: 'lookup', status: 404, message: 'not found' }),
    );
    const err = await readTagRef(client, 'runner-v0.13.3').catch((e) => e);
    expect(err).toBeInstanceOf(RunnerReleaseRepoError);
    expect(err.refusal.cause).toBe('repository-unreachable');
  });

  it('refuses a release 404 the repository itself will not confirm', async () => {
    const { client } = stubClient(
      () => new GitHubPublishError({ op: 'lookup', status: 404, message: 'not found' }),
    );
    await expect(readReleaseForTag(client, 'runner-v0.13.3')).rejects.toBeInstanceOf(
      RunnerReleaseRepoError,
    );
  });

  it('peels a chain of annotated tags all the way to the commit', async () => {
    const { client } = stubClient((call) => {
      if (call.path.includes('/git/ref/tags/')) return { object: { sha: 'tagA', type: 'tag' } };
      if (call.path.endsWith('/git/tags/tagA')) return { object: { sha: 'tagB', type: 'tag' } };
      return { object: { sha: 'abc1234', type: 'commit' } };
    });
    expect(await readTagRef(client, 'runner-v0.14.0')).toEqual({ sha: 'abc1234' });
  });

  it('refuses a tag pointing at a tree rather than calling it a commit', async () => {
    const { client } = stubClient(() => ({ object: { sha: 'treeaaa', type: 'tree' } }));
    await expect(readTagRef(client, 'runner-v0.14.0')).rejects.toThrow(
      /points at a `tree` object rather than at a commit/,
    );
  });

  it('refuses an annotated tag whose own target is a blob', async () => {
    const { client } = stubClient((call) =>
      call.path.includes('/git/ref/tags/')
        ? { object: { sha: 'tagA', type: 'tag' } }
        : { object: { sha: 'blobaaa', type: 'blob' } },
    );
    await expect(readTagRef(client, 'runner-v0.14.0')).rejects.toThrow(/`blob` object/);
  });

  it('refuses a tag chain that never reaches a commit rather than naming an object', async () => {
    const { client } = stubClient((call) =>
      call.path.includes('/git/ref/tags/')
        ? { object: { sha: 'tag0', type: 'tag' } }
        : { object: { sha: 'tagN', type: 'tag' } },
    );
    await expect(readTagRef(client, 'runner-v0.14.0')).rejects.toThrow(/reaches no commit/);
  });

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
