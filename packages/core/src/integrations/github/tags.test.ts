/**
 * A release's tag on GitHub (REQ-63 BC-13, BC-14), over a planted repository client: the ref is
 * created only where none stands, a tag on the commit is answered without a write, one elsewhere is
 * a conflict naming that commit, an annotated tag is read through to its commit, and a lost race is
 * read again rather than reported as a failure.
 */

import { describe, expect, it } from 'vitest';
import { GitHubPublishError, GitHubReadError, type GitHubRepoClient } from './client.js';
import { tagGitHubCommit } from './tags.js';

const SHIP = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TAG_OBJECT = 'c'.repeat(40);

/** A repository whose refs and tag objects are planted; `posts` is every write it took. */
function repo(opts: {
  refs?: Record<string, { type: string; sha: string }>;
  tagObjects?: Record<string, { type: string; sha: string }>;
  /** Make the ref between the read and the write, as another writer would. */
  raceTo?: { type: string; sha: string };
}) {
  const refs = { ...opts.refs };
  const posts: unknown[] = [];
  const client = {
    bindingId: 'b1',
    appId: '1',
    owner: 'acme',
    repo: 'orbit',
    fullName: 'acme/orbit',
    async get<T>(path: string): Promise<T> {
      const ref = /\/git\/ref\/tags\/(.+)$/.exec(path)?.[1];
      if (ref !== undefined) {
        const held = refs[decodeURIComponent(ref)];
        if (!held) throw new GitHubReadError(404, `GET ${path} returned HTTP 404`);
        return { object: held } as T;
      }
      const tag = /\/git\/tags\/(.+)$/.exec(path)?.[1];
      const object = tag ? opts.tagObjects?.[tag] : undefined;
      if (!object) throw new GitHubReadError(404, `GET ${path} returned HTTP 404`);
      return { object } as T;
    },
    async publish<T>(args: { path: string; body?: unknown }): Promise<T> {
      const name = String((args.body as { ref: string }).ref).replace('refs/tags/', '');
      if (opts.raceTo) {
        refs[name] = opts.raceTo;
        throw new GitHubPublishError({
          op: 'tag',
          status: 422,
          detail: 'Reference already exists',
          message: 'POST returned HTTP 422',
        });
      }
      posts.push({ path: args.path, body: args.body });
      refs[name] = { type: 'commit', sha: SHIP };
      return {} as T;
    },
  } as GitHubRepoClient;
  return { client, posts };
}

describe('tagGitHubCommit', () => {
  it('creates refs/tags/<name> on the shipped commit where no tag stands', async () => {
    const { client, posts } = repo({});
    expect(await tagGitHubCommit(client, { name: 'v0.5.0', sha: SHIP })).toEqual({
      kind: 'created',
      name: 'v0.5.0',
      sha: SHIP,
    });
    expect(posts).toEqual([
      { path: '/repos/acme/orbit/git/refs', body: { ref: 'refs/tags/v0.5.0', sha: SHIP } },
    ]);
  });

  it('answers a tag already on the commit as present, writing nothing', async () => {
    const { client, posts } = repo({ refs: { 'v0.5.0': { type: 'commit', sha: SHIP } } });
    expect(await tagGitHubCommit(client, { name: 'v0.5.0', sha: SHIP.toUpperCase() })).toEqual({
      kind: 'present',
      name: 'v0.5.0',
      sha: SHIP,
    });
    expect(posts).toEqual([]);
  });

  it('answers a tag on another commit as a conflict naming it, writing nothing', async () => {
    const { client, posts } = repo({ refs: { 'v0.5.0': { type: 'commit', sha: OTHER } } });
    expect(await tagGitHubCommit(client, { name: 'v0.5.0', sha: SHIP })).toEqual({
      kind: 'conflict',
      name: 'v0.5.0',
      sha: OTHER,
    });
    expect(posts).toEqual([]);
  });

  it('reads an annotated tag through to the commit it names', async () => {
    const { client } = repo({
      refs: { 'v0.5.0': { type: 'tag', sha: TAG_OBJECT } },
      tagObjects: { [TAG_OBJECT]: { type: 'commit', sha: SHIP } },
    });
    expect(await tagGitHubCommit(client, { name: 'v0.5.0', sha: SHIP })).toMatchObject({
      kind: 'present',
    });
  });

  it('reads a ref another writer made between the read and the write again', async () => {
    const { client } = repo({ raceTo: { type: 'commit', sha: OTHER } });
    expect(await tagGitHubCommit(client, { name: 'v0.5.0', sha: SHIP })).toEqual({
      kind: 'conflict',
      name: 'v0.5.0',
      sha: OTHER,
    });
  });
});
