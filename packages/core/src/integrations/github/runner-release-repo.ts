/**
 * The five acts a runner release makes on the repository, each as the App and
 * none as anybody. ISS-1075.
 *
 * Every call here goes through `GitHubRepoClient.publish`, which mints an
 * installation token from the App's own credential per call and raises
 * `GitHubPublishError` carrying the op, the status, the response headers and
 * whether it timed out. That is what point 4 of ISS-1075 asks for and it is
 * also the only way the sequence can tell a write that did not happen from one
 * whose outcome it never heard — which is the difference between "cut it again"
 * and "read the repository first".
 *
 * Nothing in this module reads an environment token, a `gh` configuration or a
 * personal credential, and nothing shells out. `runner-release-credential.test.ts`
 * is the assertion that says so, over the source of every module on this path.
 */

import { Buffer } from 'node:buffer';
import { GitHubPublishError, type GitHubRepoClient } from './client.js';
import {
  describePublishThrown,
  type PublishOpSubject,
  type PublishRefusal,
  type PublishSubject,
} from './publish-refusal.js';
import { type ReleaseReading, RUNNER_RELEASE_TAG_PREFIX } from './runner-release-preflight.js';

const repoPath = (client: GitHubRepoClient) =>
  `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}`;

/** The operations a runner release sends. It never sends `merge`. */
export type RunnerReleaseOp = 'mint' | 'lookup' | 'create' | 'update';

/** What each of these calls needs. The name is the claim these sentences make. */
const NEEDS_CONTENTS_WRITE: Omit<PublishOpSubject, 'where'> = {
  permission:
    'the App has no `contents: write` permission. Set Contents to "Read and write" on the App, ' +
    'then approve the resulting request on the installation — reconnecting will not change ' +
    'this, because the credential is not what is wrong.',
  ambiguous:
    'sent nothing saying which of the two it was: the App may lack `contents: write`, or this ' +
    "may be a secondary rate limit. Forge is not guessing between them. Check the App's " +
    'Contents permission first; if it is already "Read and write", retry after a pause.',
  nothingWritten: 'so nothing was written to the repository. Retrying is safe.',
  unprocessable:
    'On this path that is usually a ref that already exists, or a commit this repository does ' +
    'not hold.',
};

export function runnerReleaseSubject(what: {
  lookup: string;
  write?: string;
}): PublishSubject<RunnerReleaseOp> {
  const write = what.write ?? 'creating the tag';
  return {
    mint: { where: 'minting the installation token', ...NEEDS_CONTENTS_WRITE },
    lookup: { where: what.lookup, ...NEEDS_CONTENTS_WRITE },
    create: { where: write, ...NEEDS_CONTENTS_WRITE },
    update: { where: write, ...NEEDS_CONTENTS_WRITE },
  };
}

/** A repository act that did not answer, with the sentence an operator reads. */
export class RunnerReleaseRepoError extends Error {
  readonly refusal: PublishRefusal;
  /** True only where the failure provably happened before any write left this process. */
  readonly beforeWrite: boolean;
  constructor(refusal: PublishRefusal, beforeWrite: boolean) {
    super(refusal.message);
    this.name = 'RunnerReleaseRepoError';
    this.refusal = refusal;
    this.beforeWrite = beforeWrite;
  }
}

function refuse(
  err: unknown,
  op: 'lookup' | 'create',
  subject: PublishSubject<RunnerReleaseOp>,
): never {
  const refusal = describePublishThrown(err, op, subject);
  const beforeWrite = op === 'lookup' || refusal.op === 'mint' || refusal.op === 'lookup';
  throw new RunnerReleaseRepoError(refusal, beforeWrite);
}

function isAbsent(err: unknown): boolean {
  return err instanceof GitHubPublishError && err.status === 404 && err.op === 'lookup';
}

/**
 * A 404 read as absence — but only once the repository itself still answers.
 *
 * GitHub answers 404 for "there is no such thing" and for "you may not see
 * that" alike, on purpose: a private repository the App was removed from
 * masks itself rather than admitting it exists. The two are the same status,
 * the same body and the same headers, and only one of them is a reading.
 *
 * So the repository is asked. It answering is the evidence that makes the 404
 * about the resource; it not answering makes the refusal about access, and the
 * caller is told that instead of being handed an absence nobody observed —
 * which is what would otherwise put `publication = 'absent'` and the sentence
 * "nothing is published" on a release GitHub is holding perfectly well.
 */
async function absentUnlessUnreachable(
  client: GitHubRepoClient,
  subject: PublishSubject<RunnerReleaseOp>,
): Promise<null> {
  try {
    await client.publish<{ id?: number }>({
      op: 'lookup',
      method: 'GET',
      path: repoPath(client),
    });
  } catch (probe) {
    refuse(probe, 'lookup', subject);
  }
  return null;
}

/** The repository's own default branch name, read as the App. */
export async function readDefaultBranch(client: GitHubRepoClient): Promise<string> {
  const subject = runnerReleaseSubject({ lookup: 'reading the repository' });
  try {
    const repo = await client.publish<{ default_branch?: string }>({
      op: 'lookup',
      method: 'GET',
      path: repoPath(client),
    });
    if (!repo.default_branch) {
      throw new Error(`GitHub named no default branch for ${client.fullName}`);
    }
    return repo.default_branch;
  } catch (err) {
    refuse(err, 'lookup', subject);
  }
}

export async function readCommitSha(client: GitHubRepoClient, ref: string): Promise<string> {
  const subject = runnerReleaseSubject({ lookup: `reading the commit ${ref}` });
  try {
    const commit = await client.publish<{ sha?: string }>({
      op: 'lookup',
      method: 'GET',
      path: `${repoPath(client)}/commits/${encodeURIComponent(ref)}`,
    });
    if (!commit.sha) throw new Error(`GitHub named no commit for ${ref} on ${client.fullName}`);
    return commit.sha;
  } catch (err) {
    refuse(err, 'lookup', subject);
  }
}

export async function readFileAtRef(
  client: GitHubRepoClient,
  path: string,
  ref: string,
): Promise<string> {
  const subject = runnerReleaseSubject({ lookup: `reading ${path} at ${ref}` });
  try {
    const file = await client.publish<{ content?: string; encoding?: string }>({
      op: 'lookup',
      method: 'GET',
      path: `${repoPath(client)}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    });
    if (file.encoding !== 'base64' || typeof file.content !== 'string') {
      throw new Error(
        `GitHub served ${path} at ${ref} with encoding \`${file.encoding ?? 'none'}\`, which carries no content — the file is over the contents API's 1MB ceiling`,
      );
    }
    return Buffer.from(file.content, 'base64').toString('utf8');
  } catch (err) {
    refuse(err, 'lookup', subject);
  }
}

/**
 * The COMMIT a tag points at, or `null` where the repository holds no such tag.
 *
 * An annotated tag's ref points at a tag OBJECT rather than at a commit, so the
 * sha off the ref alone is not the thing criterion 2 says this refusal names —
 * and every `runner-v*` tag on this repository is annotated, Forge's own
 * included. Peeling it is a second read and it is not optional: a refusal that
 * prints a tag-object sha under the word "commit" sends whoever reads it
 * looking for a commit that does not exist.
 */
export async function readTagRef(
  client: GitHubRepoClient,
  tag: string,
): Promise<{ sha: string } | null> {
  const subject = runnerReleaseSubject({ lookup: `looking the tag ${tag} up` });
  let object: { sha?: string; type?: string } | undefined;
  try {
    const ref = await client.publish<{ object?: { sha?: string; type?: string } }>({
      op: 'lookup',
      method: 'GET',
      path: `${repoPath(client)}/git/ref/tags/${encodeURIComponent(tag)}`,
    });
    object = ref.object;
  } catch (err) {
    if (isAbsent(err)) return absentUnlessUnreachable(client, subject);
    refuse(err, 'lookup', subject);
  }
  if (!object?.sha) return { sha: '(unknown commit)' };
  let target = object;
  for (let peels = 0; target.type === 'tag' && peels < 5; peels += 1) {
    const sha = target.sha;
    if (!sha) break;
    try {
      const peeled = await client.publish<{ object?: { sha?: string; type?: string } }>({
        op: 'lookup',
        method: 'GET',
        path: `${repoPath(client)}/git/tags/${encodeURIComponent(sha)}`,
      });
      if (!peeled.object?.sha) throw new Error(`GitHub named no target for the tag object ${sha}`);
      target = peeled.object;
    } catch (err) {
      refuse(err, 'lookup', subject);
    }
  }
  if (target.type !== 'commit' || !target.sha) {
    const named =
      target.type === 'tag'
        ? `is a chain of more than 5 tag objects and reaches no commit`
        : `points at a \`${target.type ?? 'nameless'}\` object rather than at a commit`;
    throw new RunnerReleaseRepoError(
      describePublishThrown(new Error(`\`${tag}\` ${named}`), 'lookup', subject),
      true,
    );
  }
  return { sha: target.sha };
}

export async function createTagRef(
  client: GitHubRepoClient,
  tag: string,
  sha: string,
  message: string,
): Promise<{ sha: string }> {
  const subject = runnerReleaseSubject({
    lookup: `looking the tag ${tag} up`,
    write: `creating the tag ${tag}`,
  });
  let object: string;
  try {
    const created = await client.publish<{ sha?: string }>({
      op: 'create',
      method: 'POST',
      path: `${repoPath(client)}/git/tags`,
      body: { tag, message, object: sha, type: 'commit' },
    });
    if (!created.sha) throw new Error(`GitHub named no object for the tag ${tag}`);
    object = created.sha;
  } catch (err) {
    const refusal = describePublishThrown(err, 'create', subject);
    throw new RunnerReleaseRepoError(refusal, true);
  }
  try {
    const created = await client.publish<{ object?: { sha?: string } }>({
      op: 'create',
      method: 'POST',
      path: `${repoPath(client)}/git/refs`,
      body: { ref: `refs/tags/${tag}`, sha: object },
    });
    return { sha: created.object?.sha ?? object };
  } catch (err) {
    refuse(err, 'create', subject);
  }
}

export function saysRefExists(refusal: PublishRefusal): boolean {
  return refusal.status === 422 && /already exists/i.test(refusal.detail ?? '');
}

/** What GitHub holds for a tag, or `null` where it holds nothing. */
export async function readReleaseForTag(
  client: GitHubRepoClient,
  tag: string,
): Promise<ReleaseReading | null> {
  const subject = runnerReleaseSubject({ lookup: `reading the release for ${tag}` });
  try {
    const release = await client.publish<{
      html_url?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: Array<{ name?: string }>;
    }>({
      op: 'lookup',
      method: 'GET',
      path: `${repoPath(client)}/releases/tags/${encodeURIComponent(tag)}`,
    });
    return {
      htmlUrl: release.html_url ?? null,
      draft: release.draft === true,
      prerelease: release.prerelease === true,
      assetNames: (release.assets ?? [])
        .map((a) => a.name)
        .filter((name): name is string => typeof name === 'string'),
    };
  } catch (err) {
    if (isAbsent(err)) return absentUnlessUnreachable(client, subject);
    refuse(err, 'lookup', subject);
  }
}

/** `refs/tags/<tag>`, as GitHub spells the ref this path creates. */
export function tagRefName(tag: string): string {
  return `refs/tags/${tag}`;
}

export { RUNNER_RELEASE_TAG_PREFIX };
