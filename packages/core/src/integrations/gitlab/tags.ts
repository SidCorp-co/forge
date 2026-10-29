/**
 * A release's tag on GitLab (REQ-63 BC-13, BC-14): the lightweight tag `name` on one commit, written
 * with the connection's access token. A tag already there is read and never moved.
 */

import { type HostTagResult, SourceHostCallError } from '../source-host/index.js';
import type { GitLabClient } from './client.js';

interface TagBody {
  name?: string;
  /** The commit the tag names; an annotated tag's own object id is `target`, never read here. */
  commit?: { id?: string };
}

/** The commit the tag `name` names on GitLab, or null where there is none. */
export async function readGitLabTag(client: GitLabClient, name: string): Promise<string | null> {
  let tag: TagBody;
  try {
    tag = await client.json<TagBody>(
      'GET',
      client.project(`/repository/tags/${encodeURIComponent(name)}`),
    );
  } catch (err) {
    if (err instanceof SourceHostCallError && err.phase === 'request' && err.status === 404) {
      return null;
    }
    throw err;
  }
  const sha = tag.commit?.id;
  if (!sha) {
    throw new SourceHostCallError(200, `${client.fullName} answered tag ${name} with no commit`);
  }
  return sha.toLowerCase();
}

function answer(name: string, on: string, sha: string): HostTagResult {
  return on === sha ? { kind: 'present', name, sha: on } : { kind: 'conflict', name, sha: on };
}

/**
 * Put `name` on `sha`: read first, so a tag already there is answered as it stands, then create it.
 * GitLab answers 400 where another writer made the tag in between; that is read again.
 */
export async function tagGitLabCommit(
  client: GitLabClient,
  args: { name: string; sha: string },
): Promise<HostTagResult> {
  const sha = args.sha.toLowerCase();
  const before = await readGitLabTag(client, args.name);
  if (before !== null) return answer(args.name, before, sha);
  try {
    await client.json('POST', client.project('/repository/tags'), {
      tag_name: args.name,
      ref: sha,
    });
  } catch (err) {
    if (!(err instanceof SourceHostCallError) || err.status !== 400) throw err;
    const raced = await readGitLabTag(client, args.name);
    if (raced === null) throw err;
    return answer(args.name, raced, sha);
  }
  return { kind: 'created', name: args.name, sha };
}
