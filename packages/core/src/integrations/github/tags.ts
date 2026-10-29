/**
 * A release's tag on GitHub (REQ-63 BC-13, BC-14): the lightweight tag `name` on one commit, written
 * as the App over the binding's installation. A tag already there is read and never moved.
 */

import type { HostTagResult } from '../source-host/index.js';
import { GitHubPublishError, GitHubReadError, type GitHubRepoClient } from './client.js';

interface RefBody {
  object?: { type?: string; sha?: string };
}

/** How many annotated tags a ref is read through before it is called unreadable. */
const PEEL_LIMIT = 4;

/** The commit the tag `name` names on GitHub, an annotated tag read through; null where there is none. */
export async function readGitHubTag(
  client: GitHubRepoClient,
  name: string,
): Promise<string | null> {
  const repo = `/repos/${client.fullName}`;
  let ref: RefBody;
  try {
    ref = await client.get<RefBody>(`${repo}/git/ref/tags/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err instanceof GitHubReadError && err.phase === 'request' && err.status === 404)
      return null;
    throw err;
  }
  let object = ref.object;
  for (let n = 0; object?.type === 'tag' && n < PEEL_LIMIT; n += 1) {
    const tag = await client.get<RefBody>(
      `${repo}/git/tags/${encodeURIComponent(object.sha ?? '')}`,
    );
    object = tag.object;
  }
  if (object?.type !== 'commit' || !object.sha) {
    throw new GitHubReadError(
      200,
      `${client.fullName} answered tag ${name} as a ${object?.type ?? 'nothing'}, not a commit`,
    );
  }
  return object.sha.toLowerCase();
}

function answer(name: string, on: string, sha: string): HostTagResult {
  return on === sha ? { kind: 'present', name, sha: on } : { kind: 'conflict', name, sha: on };
}

/**
 * Put `name` on `sha`: read first, so a tag already there is answered as it stands, then create the
 * ref. GitHub answers 422 where another writer made the ref in between; that is read again.
 */
export async function tagGitHubCommit(
  client: GitHubRepoClient,
  args: { name: string; sha: string },
): Promise<HostTagResult> {
  const sha = args.sha.toLowerCase();
  const before = await readGitHubTag(client, args.name);
  if (before !== null) return answer(args.name, before, sha);
  try {
    await client.publish({
      op: 'tag',
      method: 'POST',
      path: `/repos/${client.owner}/${client.repo}/git/refs`,
      body: { ref: `refs/tags/${args.name}`, sha },
    });
  } catch (err) {
    if (!(err instanceof GitHubPublishError) || err.status !== 422) throw err;
    const raced = await readGitHubTag(client, args.name);
    if (raced === null) {
      throw new GitHubPublishError({
        op: 'tag',
        status: err.status,
        detail: err.detail,
        message: `GitHub refused tag ${args.name} on ${sha} with HTTP 422 and holds no such tag: ${err.detail ?? 'no reason given'}`,
      });
    }
    return answer(args.name, raced, sha);
  }
  return { kind: 'created', name: args.name, sha };
}
