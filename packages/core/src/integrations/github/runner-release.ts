/**
 * The runner release, steps 1 to 6: everything up to and including the tag.
 *
 * Deterministic from end to end, so it is the kernel's and no agent has to be
 * running for it to proceed or to be recorded (ISS-1075). Steps 7 and 8 are in
 * `runner-release-events.ts`, because they happen on a delivery rather than on
 * this call, and the clock that reaches a release neither of them settles is in
 * `runner-release-deadline.ts`.
 *
 * The one irreversible act is `cut_tag`, and the whole shape of this module is
 * built around it: the intent goes onto the row BEFORE the request leaves, so a
 * process that dies mid-write leaves `tag_state = 'unknown'` rather than a row
 * claiming nothing happened. Nothing here deletes a tag or cuts one again to
 * recover — a tag is immutable, and a release that failed half-way is named
 * rather than tidied away.
 */

import type { RunnerReleaseStep } from '../../db/schema-runner-release.js';
import { logger } from '../../logger.js';
import { GitHubClientError, type GitHubRepoClient, githubRepoClient } from './client.js';
import {
  judgeCrateVersion,
  judgeLockfileVersion,
  type PreflightRefusal,
  RUNNER_CARGO_LOCK_PATH,
  RUNNER_CARGO_TOML_PATH,
  RUNNER_RELEASE_DEADLINE_MS,
  repositoryTruth,
  tagForVersion,
} from './runner-release-preflight.js';
import {
  createTagRef,
  RunnerReleaseRepoError,
  readCommitSha,
  readDefaultBranch,
  readFileAtRef,
  readTagRef,
  saysRefExists,
  tagRefName,
} from './runner-release-repo.js';
import {
  advance,
  appendReading,
  openRunnerRelease,
  type RunnerReleaseRow,
  settleFailed,
} from './runner-release-store.js';

export interface StartRunnerReleaseArgs {
  projectId: string;
  version: string;
  /** A commit or ref to cut at. The repository's default branch head when absent. */
  commit?: string;
  requestedById: string | null;
  now?: Date;
}

/** Which refusal this is, so a caller can choose a status code without reading prose. */
export type StartRefusalKind = 'no_repository' | 'bad_version' | 'already_attempted' | 'stopped';

export type StartRunnerReleaseOutcome =
  | { started: true; release: RunnerReleaseRow }
  | { started: false; kind: StartRefusalKind; message: string; release: RunnerReleaseRow | null };

const truthOf = (row: RunnerReleaseRow, tagState = row.tagState) =>
  repositoryTruth({
    tag: row.tag,
    commitSha: row.commitSha,
    tagState,
    publication: row.publication,
    publicationDetail: row.publicationDetail,
  });

/**
 * Cut the tag and hand the release over to the build's own event.
 *
 * This function never throws a `RunnerReleaseRepoError`: the answer to a failed
 * create is which of three things is true on the repository, and losing that to
 * an exception is how a half-cut release goes quiet.
 */
async function cutTheTag(
  client: GitHubRepoClient,
  row: RunnerReleaseRow,
  commitSha: string,
): Promise<StartRunnerReleaseOutcome> {
  // cm:guard the intent is written BEFORE the request and `tag_state` goes to `unknown` here, not after. Between this statement and the next answer, a killed process is the one case ISS-1075 point 3 is about: the row then says the tag may exist, which is what stops a retry cutting over it and what the deadline pass reports.
  await advance(row.id, { step: 'cut_tag', status: 'cutting', tagState: 'unknown' });
  try {
    const created = await createTagRef(client, row.tag, commitSha);
    await advance(row.id, {
      step: 'await_build',
      status: 'building',
      tagState: 'present',
      tagCutAt: new Date(),
    });
    await appendReading(
      row.id,
      `cut_tag: ${tagRefName(row.tag)} created at ${created.sha} by the App on ${client.fullName}`,
    );
    const after = { ...row, commitSha, tagState: 'present' as const, status: 'building' as const };
    return { started: true, release: after };
  } catch (err) {
    if (!(err instanceof RunnerReleaseRepoError)) throw err;
    const { refusal } = err;
    // cm:guard three outcomes and never two. `present` is a 422 that says the ref is already there, which is a tag Forge did not make; `absent` is a refusal GitHub ANSWERED, so no ref was created; `unknown` is everything else — a timeout or a socket that died with the request in flight. Folding the third into `absent` is what lets the next attempt cut over a tag that already exists.
    const tagState = saysRefExists(refusal)
      ? ('present' as const)
      : err.beforeWrite || refusal.status !== null
        ? ('absent' as const)
        : ('unknown' as const);
    const stopped = { ...row, commitSha, tagState };
    const failure = `${refusal.message} ${truthOf(stopped, tagState)}`;
    await settleFailed(row.id, { step: 'cut_tag', failure, tagState });
    await appendReading(row.id, `cut_tag: refused — ${refusal.cause}`);
    logger.warn(
      { releaseId: row.id, tag: row.tag, cause: refusal.cause, tagState },
      'runner-release: the tag was not cut',
    );
    return { started: false, kind: 'stopped', message: failure, release: { ...stopped } };
  }
}

/** Steps 2 to 5: the commit, the tag's absence, and the two versions at that commit. */
async function runPreflight(
  client: GitHubRepoClient,
  row: RunnerReleaseRow,
  args: StartRunnerReleaseArgs,
): Promise<{ commitSha: string } | StartRunnerReleaseOutcome> {
  const stop = async (
    step: RunnerReleaseStep,
    message: string,
    commitSha: string | null,
  ): Promise<StartRunnerReleaseOutcome> => {
    const stopped = { ...row, commitSha };
    const failure = `${message} ${truthOf(stopped, 'absent')}`;
    await settleFailed(row.id, { step, failure, tagState: 'absent' });
    return { started: false, kind: 'stopped', message: failure, release: stopped };
  };

  let step: RunnerReleaseStep = 'resolve_commit';
  let commitSha: string | null = null;
  try {
    await advance(row.id, { step });
    const ref = args.commit ?? (await readDefaultBranch(client));
    commitSha = await readCommitSha(client, ref);
    await advance(row.id, { commitSha });
    await appendReading(row.id, `resolve_commit: ${commitSha} (${ref})`);

    step = 'check_tag_absent';
    await advance(row.id, { step });
    const existing = await readTagRef(client, row.tag);
    if (existing) {
      const stopped = { ...row, commitSha, tagState: 'present' as const };
      const failure =
        `\`${row.tag}\` already exists on ${client.fullName}, pointing at ${existing.sha}. ` +
        `${truthOf(stopped, 'present')}`;
      await settleFailed(row.id, { step, failure, tagState: 'present' });
      return { started: false, kind: 'stopped', message: failure, release: stopped };
    }
    await appendReading(row.id, `check_tag_absent: ${client.fullName} holds no ${row.tag}`);

    step = 'check_crate_version';
    await advance(row.id, { step });
    const cargoToml = await readFileAtRef(client, RUNNER_CARGO_TOML_PATH, commitSha);
    const crate: PreflightRefusal | null = judgeCrateVersion({
      version: row.version,
      commitSha,
      cargoToml,
    });
    if (crate) return stop(crate.step, crate.message, commitSha);
    await appendReading(row.id, `check_crate_version: Cargo.toml declares ${row.version}`);

    step = 'check_lockfile_version';
    await advance(row.id, { step });
    const cargoLock = await readFileAtRef(client, RUNNER_CARGO_LOCK_PATH, commitSha);
    const locked = judgeLockfileVersion({ version: row.version, commitSha, cargoLock });
    if (locked) return stop(locked.step, locked.message, commitSha);
    await appendReading(row.id, `check_lockfile_version: Cargo.lock records ${row.version}`);

    return { commitSha };
  } catch (err) {
    if (!(err instanceof RunnerReleaseRepoError)) throw err;
    // cm:guard every act in this block is a READ, so `absent` here is a reading and not an assumption: nothing on the repository was touched, and that is exactly what makes the same version re-runnable afterwards.
    return stop(step, err.refusal.message, commitSha);
  }
}

/**
 * Start a runner release: one call, eight steps, no agent.
 *
 * Refuses before opening a row only where there is no row to open — no
 * repository to act on, or a version that names no tag. Everything past that
 * point is recorded, including the refusals.
 */
export async function startRunnerRelease(
  args: StartRunnerReleaseArgs,
): Promise<StartRunnerReleaseOutcome> {
  let client: GitHubRepoClient;
  try {
    client = await githubRepoClient(args.projectId);
  } catch (err) {
    if (err instanceof GitHubClientError) {
      return { started: false, kind: 'no_repository', message: err.message, release: null };
    }
    throw err;
  }

  const tagged = tagForVersion(args.version);
  if ('message' in tagged) {
    return { started: false, kind: 'bad_version', message: tagged.message, release: null };
  }

  const now = args.now ?? new Date();
  const open = await openRunnerRelease({
    projectId: args.projectId,
    bindingId: client.bindingId,
    repository: client.fullName,
    version: args.version.trim(),
    tag: tagged.tag,
    requestedById: args.requestedById,
    deadlineAt: new Date(now.getTime() + RUNNER_RELEASE_DEADLINE_MS),
  });
  if (!open.opened) {
    const held = open.held;
    return {
      started: false,
      kind: 'already_attempted',
      message:
        `\`${held.tag}\` was already attempted on ${held.startedAt.toISOString()} and stopped at ` +
        `\`${held.step}\`. ${truthOf(held)} Cut the next version instead.`,
      release: held,
    };
  }

  const row = open.opened;
  await appendReading(
    row.id,
    `resolve_repository: ${client.fullName} via binding ${client.bindingId}`,
  );
  const preflight = await runPreflight(client, row, args);
  if ('started' in preflight) return preflight;
  return cutTheTag(client, row, preflight.commitSha);
}
