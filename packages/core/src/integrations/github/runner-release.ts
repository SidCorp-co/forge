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
    tagState,
    publication: row.publication,
    publicationDetail: row.publicationDetail,
  });

// cm:guard every outcome reads the row back rather than returning the opening snapshot with the fields this call believes it wrote spread over it. The write may have been refused — `advance` and `settleFailed` are both conditional — and a synthesized answer then reports a step, a status and a readings list the stored row does not carry, so the POST and an immediate GET of the same release disagree.
async function asPersisted(id: string, fallback: RunnerReleaseRow): Promise<RunnerReleaseRow> {
  return (await findById(id)) ?? fallback;
}

/**
 * The row went terminal under a sequence that was still running.
 *
 * Only the deadline pass and a delivery can do that, and both settle with a
 * sentence of their own, so what a caller is owed here is the STORED outcome
 * rather than one this call invents over a row it no longer owns.
 */
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
  // cm:guard the intent is written BEFORE the request and `tag_state` goes to `unknown` here, not after. Between this statement and the next answer, a killed process is the one case ISS-1075 point 3 is about: the row then says the tag may exist, which is what stops a retry cutting over it and what the deadline pass reports.
  const armed = await advance(row.id, row.attempt, {
    step: 'cut_tag',
    status: 'cutting',
    tagState: 'unknown',
  });
  // cm:guard the ANSWER to that write decides whether the request goes out at all. `advance` is conditional on the row being non-terminal, so a `false` here means the deadline pass or a delivery settled this release a moment ago — and creating the tag anyway puts a ref on GitHub that no row will ever be able to record, because every later write is conditional too. The irreversible act may not outrun the record of the intent.
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
    // cm:guard three outcomes and never two, and the middle one is decided by WHICH status GitHub answered rather than by whether it answered at all. `present` is a 422 whose body says the ref is already there, a tag Forge did not make. `absent` is a refusal GitHub answered in the 4xx range, which is the range that rejects a request rather than failing to finish one. Everything else is `unknown`: a 5xx may have committed the ref before it fell over, and a 2xx whose body could not be read carries a status but describes a write that SUCCEEDED. Folding either into `absent` is what lets the next attempt cut over a tag that already exists.
    const rejected = refusal.status !== null && refusal.status >= 400 && refusal.status < 500;
    const tagState = saysRefExists(refusal)
      ? ('present' as const)
      : err.beforeWrite || rejected
        ? ('absent' as const)
        : ('unknown' as const);
    const failure = `${refusal.message} ${truthOf({ ...row, commitSha, tagState }, tagState)}`;
    await settleFailed(row.id, row.attempt, { step: 'cut_tag', failure, tagState });
    await appendReading(row.id, row.attempt, `cut_tag: refused — ${refusal.cause}`);
    logger.warn(
      { releaseId: row.id, tag: row.tag, cause: refusal.cause, tagState },
      'runner-release: the tag was not cut',
    );
    return {
      started: false,
      kind: 'stopped',
      message: failure,
      release: await asPersisted(row.id, { ...row, commitSha, tagState }),
    };
  }
}

/** Steps 2 to 5: the commit, the tag's absence, and the two versions at that commit. */
async function runPreflight(
  client: GitHubRepoClient,
  row: RunnerReleaseRow,
  args: StartRunnerReleaseArgs,
): Promise<{ commitSha: string } | StartRunnerReleaseOutcome> {
  // cm:guard `tagRead` is what separates a tag GitHub answered about from one nobody asked about, and every stop below reads it. Passing `absent` from a preflight that failed at `resolve_commit` records a repository Forge never inspected as one it found the tag missing from — and the operator acts on that sentence. The two are one fact about FORGE (it wrote nothing) and two different facts about the REPOSITORY, which is why `tag_state` carries `unread` beside `absent`.
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
    return {
      started: false,
      kind: 'stopped',
      message: failure,
      release: await asPersisted(row.id, { ...row, commitSha, tagState }),
    };
  };

  let step: RunnerReleaseStep = 'resolve_commit';
  let commitSha: string | null = null;
  try {
    // cm:guard every `advance` on this path is answered, because it is conditional on the row being non-terminal: the deadline pass can settle this release between two steps, and a sequence that carries on past that point writes its readings into a row somebody else already ended — and then cuts a tag for it.
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
      const failure =
        `\`${row.tag}\` already exists on ${client.fullName}, pointing at ${existing.sha}. ` +
        `${truthOf({ ...row, commitSha, tagState: 'present' as const }, 'present')}`;
      const settled = await settleFailed(row.id, row.attempt, {
        step,
        failure,
        tagState: 'present',
      });
      if (!settled) return lostTheRow(row);
      return {
        started: false,
        kind: 'stopped',
        message: failure,
        release: await asPersisted(row.id, { ...row, commitSha, tagState: 'present' as const }),
      };
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
    // cm:guard every act in this block is a READ, so nothing on the repository was touched — which is what makes the same version re-runnable afterwards. What it does NOT establish is whether the tag is there: a read that failed answered nothing, and `stop` records `unread` for exactly that case.
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
    row.attempt,
    `resolve_repository: ${client.fullName} via binding ${client.bindingId}`,
  );
  const preflight = await runPreflight(client, row, args);
  if ('started' in preflight) return preflight;
  return cutTheTag(client, row, preflight.commitSha);
}
