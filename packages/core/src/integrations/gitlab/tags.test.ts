/**
 * A release's tag on GitLab (REQ-63 BC-13, BC-14), over a planted project client: the tag is created
 * only where none stands, one on the commit is answered without a write, one elsewhere is a conflict
 * naming that commit, and a lost race is read again rather than reported as a failure.
 */

import { describe, expect, it } from 'vitest';
import { SourceHostCallError } from '../source-host/index.js';
import type { GitLabClient } from './client.js';
import { tagGitLabCommit } from './tags.js';

const SHIP = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** A project whose tags are planted by name; `posts` is every write it took. */
function project(opts: { tags?: Record<string, string>; raceTo?: string }) {
  const tags = { ...opts.tags };
  const posts: unknown[] = [];
  const client = {
    fullName: 'acme/orbit',
    project: (suffix: string) => `/projects/acme%2Forbit${suffix}`,
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method === 'GET') {
        const name = decodeURIComponent(path.split('/repository/tags/')[1] ?? '');
        const on = tags[name];
        if (!on)
          throw new SourceHostCallError(404, `GET ${path} returned HTTP 404`, '404 Tag Not Found');
        return { name, commit: { id: on } } as T;
      }
      const name = (body as { tag_name: string }).tag_name;
      if (opts.raceTo) {
        tags[name] = opts.raceTo;
        throw new SourceHostCallError(
          400,
          `POST ${path} returned HTTP 400`,
          `Tag ${name} already exists`,
        );
      }
      posts.push({ path, body });
      tags[name] = (body as { ref: string }).ref;
      return { name } as T;
    },
  } as unknown as GitLabClient;
  return { client, posts };
}

describe('tagGitLabCommit', () => {
  it('creates the tag on the shipped commit where none stands', async () => {
    const { client, posts } = project({});
    expect(await tagGitLabCommit(client, { name: 'v0.5.0', sha: SHIP })).toEqual({
      kind: 'created',
      name: 'v0.5.0',
      sha: SHIP,
    });
    expect(posts).toEqual([
      {
        path: '/projects/acme%2Forbit/repository/tags',
        body: { tag_name: 'v0.5.0', ref: SHIP },
      },
    ]);
  });

  it('answers a tag already on the commit as present, writing nothing', async () => {
    const { client, posts } = project({ tags: { 'v0.5.0': SHIP } });
    expect(await tagGitLabCommit(client, { name: 'v0.5.0', sha: SHIP })).toMatchObject({
      kind: 'present',
      sha: SHIP,
    });
    expect(posts).toEqual([]);
  });

  it('answers a tag on another commit as a conflict naming it, writing nothing', async () => {
    const { client, posts } = project({ tags: { 'v0.5.0': OTHER } });
    expect(await tagGitLabCommit(client, { name: 'v0.5.0', sha: SHIP })).toEqual({
      kind: 'conflict',
      name: 'v0.5.0',
      sha: OTHER,
    });
    expect(posts).toEqual([]);
  });

  it('reads a tag another writer made between the read and the write again', async () => {
    const { client } = project({ raceTo: SHIP });
    expect(await tagGitLabCommit(client, { name: 'v0.5.0', sha: SHIP })).toMatchObject({
      kind: 'present',
    });
  });
});
