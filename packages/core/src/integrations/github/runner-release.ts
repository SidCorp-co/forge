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
  tagMessageForVersion,
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
  findById,
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
    tagCommitSha: row.tagCommitSha,
    tagState,
    publication: row.publication,
    publicationDetail: row.publicationDetail,
  });

async function asPersisted(id: string, fallback: RunnerReleaseRow): Promise<RunnerReleaseRow> {
  return (await findById(id)) ?? fallback;
}

/**
 * The outcome of a stop that WON its settle: this call's own message, beside
 * the row as it now stands.
 *
 * The two can be about different attempts. Between the settle and the read-back
 * another start may re-arm this row and be several steps into a release of its
 * own, and pairing this call's "nothing was written, the tag does not exist"
 * with that row's `building`/`present` is one answer asserting both. The
 * attempt is what tells them apart, and where they differ the sentence says so
 * rather than letting a reader assume the message describes the release beside
 * it.
 */
async function stoppedOutcome(
  row: RunnerReleaseRow,
  message: string,
  fallback: RunnerReleaseRow,
): Promise<StartRunnerReleaseOutcome> {
  const now = await asPersisted(row.id, fallback);
  if (Number(now.attempt) === Number(row.attempt)) {
    return { started: false, kind: 'stopped', message, release: now };
  }
  return {
    started: false,
    kind: 'stopped',
    message:
      `${message} Since this attempt stopped, \`${now.tag}\` has been run again: the release on ` +
      `record is attempt ${now.attempt}, at \`${now.step}\`, and the outcome above is this ` +
      "call's rather than that row's.",
    release: now,
  };
}

async function lostTheRow(row: RunnerReleaseRow): Promise<StartRunnerReleaseOutcome> {
  const settled = await asPersisted(row.id, row);
  const message =
    settled.failure ??
    `\`${settled.tag}\` was settled by another writer while this sequence was running. ${truthOf(settled)}`;
  return { started: false, kind: 'stopped', message, release: settled };
}

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
  const armed = await advance(row.id, row.attempt, {
    step: 'cut_tag',
    status: 'cutting',
    tagState: 'unknown',
  });
  if (!armed) return lostTheRow(row);
  try {
    const created = await createTagRef(
      client,
      row.tag,
      commitSha,
      tagMessageForVersion(row.version),
    );
    await advance(row.id, row.attempt, {
      step: 'await_build',
      status: 'building',
      tagState: 'present',
      tagCommitSha: commitSha,
      tagCutAt: new Date(),
    });
    await appendReading(
      row.id,
      row.attempt,
      `cut_tag: ${tagRefName(row.tag)} created as an annotated tag at ${created.sha} by the App on ${client.fullName}`,
    );
    return { started: true, release: await asPersisted(row.id, row) };
  } catch (err) {
    if (!(err instanceof RunnerReleaseRepoError)) throw err;
    const { refusal } = err;
    const rejected = refusal.status !== null && refusal.status >= 400 && refusal.status < 500;
    const tagState = saysRefExists(refusal)
      ? ('present' as const)
      : err.beforeWrite || rejected
        ? ('absent' as const)
        : ('unknown' as const);
    const failure = `${refusal.message} ${truthOf({ ...row, commitSha, tagState }, tagState)}`;
    if (!(await settleFailed(row.id, row.attempt, { step: 'cut_tag', failure, tagState }))) {
      return lostTheRow(row);
    }
    await appendReading(row.id, row.attempt, `cut_tag: refused — ${refusal.cause}`);
    logger.warn(
      { releaseId: row.id, tag: row.tag, cause: refusal.cause, tagState },
      'runner-release: the tag was not cut',
    );
    return stoppedOutcome(row, failure, { ...row, commitSha, tagState });
  }
}

/** Steps 2 to 5: the commit, the tag's absence, and the two versions at that commit. */
async function runPreflight(
  client: GitHubRepoClient,
  row: RunnerReleaseRow,
  args: StartRunnerReleaseArgs,
): Promise<{ commitSha: string } | StartRunnerReleaseOutcome> {
  let tagRead = false;
  const stop = async (
    step: RunnerReleaseStep,
    message: string,
    commitSha: string | null,
  ): Promise<StartRunnerReleaseOutcome> => {
    const tagState = tagRead ? ('absent' as const) : ('unread' as const);
    const failure = `${message} ${truthOf({ ...row, commitSha, tagState }, tagState)}`;
    const settled = await settleFailed(row.id, row.attempt, { step, failure, tagState });
    if (!settled) return lostTheRow(row);
    return stoppedOutcome(row, failure, { ...row, commitSha, tagState });
  };

  let step: RunnerReleaseStep = 'resolve_commit';
  let commitSha: string | null = null;
  try {
    if (!(await advance(row.id, row.attempt, { step }))) return lostTheRow(row);
    const ref = args.commit ?? (await readDefaultBranch(client));
    commitSha = await readCommitSha(client, ref);
    if (!(await advance(row.id, row.attempt, { commitSha }))) return lostTheRow(row);
    await appendReading(row.id, row.attempt, `resolve_commit: ${commitSha} (${ref})`);

    step = 'check_tag_absent';
    if (!(await advance(row.id, row.attempt, { step }))) return lostTheRow(row);
    const existing = await readTagRef(client, row.tag);
    tagRead = true;
    if (existing) {
      const observed = { ...row, commitSha, tagCommitSha: existing.sha };
      const failure =
        `\`${row.tag}\` already exists on ${client.fullName}, pointing at ${existing.sha}, ` +
        `and this release resolved ${commitSha}. ` +
        `${truthOf(observed, 'present')}`;
      const settled = await settleFailed(row.id, row.attempt, {
        step,
        failure,
        tagState: 'present',
        tagCommitSha: existing.sha,
      });
      if (!settled) return lostTheRow(row);
      return stoppedOutcome(row, failure, { ...observed, tagState: 'present' as const });
    }
    if (!(await advance(row.id, row.attempt, { tagState: 'absent' }))) return lostTheRow(row);
    await appendReading(
      row.id,
      row.attempt,
      `check_tag_absent: ${client.fullName} holds no ${row.tag}`,
    );

    step = 'check_crate_version';
    if (!(await advance(row.id, row.attempt, { step }))) return lostTheRow(row);
    const cargoToml = await readFileAtRef(client, RUNNER_CARGO_TOML_PATH, commitSha);
    const crate: PreflightRefusal | null = judgeCrateVersion({
      version: row.version,
      commitSha,
      cargoToml,
    });
    if (crate) return stop(crate.step, crate.message, commitSha);
    await appendReading(
      row.id,
      row.attempt,
      `check_crate_version: Cargo.toml declares ${row.version}`,
    );

    step = 'check_lockfile_version';
    if (!(await advance(row.id, row.attempt, { step }))) return lostTheRow(row);
    const cargoLock = await readFileAtRef(client, RUNNER_CARGO_LOCK_PATH, commitSha);
    const locked = judgeLockfileVersion({ version: row.version, commitSha, cargoLock });
    if (locked) return stop(locked.step, locked.message, commitSha);
    await appendReading(
      row.id,
      row.attempt,
      `check_lockfile_version: Cargo.lock records ${row.version}`,
    );

    return { commitSha };
  } catch (err) {
    if (!(err instanceof RunnerReleaseRepoError)) throw err;
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
    const message =
      held.settledAt === null
        ? `\`${held.tag}\` is already running: it was opened on ${held.startedAt.toISOString()} ` +
          `and is at \`${held.step}\`. Follow that release (${held.id}) rather than starting ` +
          'a second one for the same tag.'
        : `\`${held.tag}\` was already attempted on ${held.startedAt.toISOString()} and stopped ` +
          `at \`${held.step}\`. ${truthOf(held)} Cut the next version instead.`;
    return { started: false, kind: 'already_attempted', message, release: held };
  }

  const row = open.opened;
  await appendReading(
    row.id,
    row.attempt,
    `resolve_repository: ${client.fullName} via binding ${client.bindingId}`,
  );
  const preflight = await runPreflight(client, row, args);
  if ('started' in preflight) return preflight;
  return cutTheTag(client, row, preflight.commitSha);
}
