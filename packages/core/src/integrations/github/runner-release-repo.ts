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
  type PublishRefusal,
  type PublishSubject,
} from './publish-refusal.js';
import { type ReleaseReading, RUNNER_RELEASE_TAG_PREFIX } from './runner-release-preflight.js';

const repoPath = (client: GitHubRepoClient) =>
  `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}`;

// cm:guard the permission named here is `contents: write` and never `checks: write`. Both live on the same App and a 403 on either looks identical; `check-refusal.ts` names the other one, and the two sentences send an operator to two different rows of the same settings page.
export function runnerReleaseSubject(what: { lookup: string; write?: string }): PublishSubject {
  const write = what.write ?? 'creating the tag';
  return {
    where: {
      mint: 'minting the installation token',
      lookup: what.lookup,
      create: write,
      update: write,
    },
    permission:
      'the App has no `contents: write` permission. Set Contents to "Read and write" on the App, ' +
      'then approve the resulting request on the installation — reconnecting will not change ' +
      'this, because the credential is not what is wrong.',
    ambiguous:
      'the App may lack `contents: write`, or this may be a secondary rate limit. Forge is not ' +
      "guessing between them. Check the App's Contents permission first; if it is already " +
      '"Read and write", retry after a pause.',
    nothingWritten: 'so nothing was written to the repository. Retrying is safe.',
    unprocessable:
      'On this path that is usually a ref that already exists, or a commit this repository does ' +
      'not hold.',
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

function refuse(err: unknown, op: 'lookup' | 'create', subject: PublishSubject): never {
  const refusal = describePublishThrown(err, op, subject);
  // cm:guard `beforeWrite` is about the CALL, not about the cause: a lookup never wrote, and a create that timed out may have. A mint failure is before every write on either call, which is why it is folded in here rather than left to the caller to remember.
  const beforeWrite = op === 'lookup' || refusal.op === 'mint' || refusal.op === 'lookup';
  throw new RunnerReleaseRepoError(refusal, beforeWrite);
}

// cm:guard the OP is half of this test and not decoration: `client.publish` mints an installation token first and raises its failure as a `GitHubPublishError` too, so a 404 from the mint — an installation that no longer exists — arrives here looking exactly like a tag that is not there. Reading that as absence tells a caller the tag does not exist on a repository Forge could not reach at all, which is how a cut goes out over a tag nobody looked for and how a completed build is recorded with publication `absent`.
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
  subject: PublishSubject,
): Promise<null> {
  try {
    await client.publish<{ id?: number }>({
      op: 'lookup',
      method: 'GET',
      path: repoPath(client),
    });
  } catch (probe) {
    // cm:guard the PROBE's refusal and not the original 404, because the probe is the one that says what is wrong: an App removed from the installation, a repository renamed or deleted. The resource 404 under those conditions carries no information at all.
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

// cm:guard a branch name and a commit sha both resolve here, and a caller's own sha goes through it rather than being taken on trust: a tag cut at a sha this repository does not hold is a 422 from the create, which reads as a rejected payload rather than as the commit nobody checked.
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

// cm:guard the contents API answers `encoding: "none"` with an EMPTY body for a file over 1MB rather than failing, so a reader that decodes whatever it is handed gets an empty string and every version check over it passes. The refusal below is what keeps that from reading as agreement.
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
  // cm:guard the 404-as-absence belongs to the REF lookup and to nothing else. Sharing it with the peel below means a `/git/tags/<sha>` that answers 404 — the object collected, the sha mistyped, a permission that covers refs and not objects — reads as "this repository holds no such tag" for a ref GitHub just handed back, and the sequence then walks on and cuts over a tag it has seen.
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
  // cm:guard peeling LOOPS, because git lets a tag object point at another tag object and the chain ends at a commit whenever it ends. One peel returns the inner tag's sha — a real object, not a commit — and that is what gets stored as `tag_commit_sha` and printed as the commit the tag points at. The bound is here because a malformed chain must refuse rather than spin.
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
  // cm:guard the final type must be `commit` and not merely "no longer a tag". Git lets a ref point at a tree or a blob, and both are legal objects this peel would otherwise hand back as the commit the tag points at — a sha that is real, is not a commit, and is recorded under `tag_commit_sha` and printed as one. The release is refused either way; what is at stake is whether its record says something true.
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

/**
 * Create the tag. The one irreversible act on this path, in two calls.
 *
 * ANNOTATED, because that is the artefact the hand-cut releases are: every
 * `runner-v*` tag on this repository carries a tagger and the message
 * `forge-runner <version>` — `runner-v0.14.0`, cut by hand on 2026-09-18 while
 * this issue was being built, is the latest. A lightweight ref would trigger
 * the same workflow and serve the same release, and it would still be a
 * different object from the one every other release on the repository is: the
 * point of this operation is that Forge does what was done by hand, not
 * something that comes out equivalent.
 *
 * The tag OBJECT is written first and is invisible until a ref points at it —
 * unreferenced, collectable, naming nothing — so the irreversible act is still
 * exactly one call, the second. A caller records the intent (`tag_state =
 * 'unknown'`) before either, and moves it to `present` only on the ref's
 * answer. A 422 saying the reference already exists is the one refusal that
 * also moves it to `present`: the tag is there, Forge just did not make it.
 */
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
    // cm:guard a failure HERE leaves no tag on the repository however it failed, including a timeout: the object this call writes names nothing until the ref below points at it, and no ref request has been sent. That is why it refuses as `beforeWrite` rather than leaving the tag's existence unknown — the precision is the whole reason the write is split.
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

// cm:guard GitHub's own body and NEVER `refusal.message`. The message is Forge's prose with the subject's `unprocessable` sentence folded in, and that sentence itself says "usually a ref that already exists" — so matching it there made every 422 read as a tag that is already on the repository, including the 422 for a commit this repository does not hold. That records `present` for a tag nobody cut and refuses every later attempt at the version.
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
