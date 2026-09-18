/**
 * Forge's own clock over a release nothing else settled. ISS-1075.
 *
 * Point 3 of ISS-1075 is that a release which fails half-way says which step
 * failed and what is now true on the repository — and the shape that most needs
 * saying is the one no delivery will ever arrive for: a process that died at
 * `cut_tag` with the answer still in flight, a build GitHub never reported, a
 * preflight that stopped between two reads. Every one of those leaves a
 * non-terminal row nothing else reaches.
 *
 * So this pass reaches EVERY non-terminal row past its own deadline, whichever
 * of the eight steps it stopped on, and not only the ones waiting on a build.
 * It is not a poll: it reads this table and this clock, and asks GitHub nothing.
 *
 * It lives in `pipeline/` rather than beside the release code for the reason
 * `release-coolify.ts` does: the sweeper's tick is the pipeline's, and a file
 * here reaching one integration keeps `sweeper.ts` from reaching a seventh
 * module — the fan-out limit that exists to stop it becoming a coordinator.
 */

import {
  RUNNER_RELEASE_DEADLINE_MS,
  repositoryTruth,
} from '../integrations/github/runner-release-preflight.js';
import {
  overdueReleases,
  type RunnerReleaseRow,
  settleFailed,
} from '../integrations/github/runner-release-store.js';
import { logger } from '../logger.js';

export { RUNNER_RELEASE_DEADLINE_MS };

export interface RunnerReleaseDeadlineResult {
  named: number;
}

// cm:guard the sentence for a build that never reported names the SUBSCRIPTION, because that is the one cause an operator can act on and the one this change created: `connect.ts`'s manifest only decides the events of Apps created after it, so an App that already exists hears no `workflow_run` until somebody subscribes it by hand, and the symptom is exactly this row — a tag cut, a build running, and Forge told nothing.
function leadFor(row: RunnerReleaseRow, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - row.startedAt.getTime()) / 60_000));
  if (row.step === 'await_build') {
    return (
      `Forge cut \`${row.tag}\` ${minutes} minutes ago and GitHub has reported no build for it. ` +
      'Forge hears a build on a `workflow_run` delivery and never polls, so the first thing to ' +
      "check is that this project's GitHub App subscribes to Workflow run — its Permissions & " +
      'events page, under Subscribe to events.'
    );
  }
  if (row.step === 'cut_tag') {
    return `Forge stopped at \`cut_tag\` ${minutes} minutes ago and never reported the outcome.`;
  }
  return `Forge stopped at \`${row.step}\` ${minutes} minutes ago and never came back to it.`;
}

/**
 * Fail every release whose own clock has run out, naming the step it stopped on
 * and what is true on the repository as a result.
 */
// cm:guard best-effort per row — one failure is logged and skipped rather than aborting the pass, the convention every reaper in `pipeline/sweeper.ts` follows.
export async function nameOverdueRunnerReleases(
  now: Date = new Date(),
): Promise<RunnerReleaseDeadlineResult> {
  const rows = await overdueReleases(now);
  let named = 0;
  for (const row of rows) {
    const failure = `${leadFor(row, now)} ${repositoryTruth({
      tag: row.tag,
      commitSha: row.commitSha,
      tagState: row.tagState,
      publication: row.publication,
      publicationDetail: row.publicationDetail,
    })}`;
    try {
      // cm:guard the row's OWN `tag_state` is carried through untouched. This pass knows nothing new about the repository — it only knows that nobody said anything — so deciding a tag state here would be inventing the very reading the row is honest about not having.
      // cm:guard the attempt pins the settle to the ATTEMPT this row was read in, and `ifUnchanged` to the reading within it. Both are needed and neither subsumes the other: a re-arm brings `settled_at IS NULL` back and can bring the step and tag state round to the same pair, so a sweep holding an older reading would otherwise fail somebody else's live attempt before its own deadline.
      // cm:guard `ifUnchanged` pins the settle to the reading this sentence was written from. The sequence this pass is racing moves a row on between the SELECT and the UPDATE — `resolve_commit`/`unread` becomes `cut_tag`/`unknown` the moment a create request goes out — and a settle without it writes the older step back over the newer one together with prose saying nothing was written, over a row that has a tag request in flight. A candidate that moved is left for the next tick, which reads it as it now stands.
      const settled = await settleFailed(row.id, row.attempt, {
        step: row.step,
        failure,
        ifUnchanged: { step: row.step, tagState: row.tagState },
      });
      if (settled) named += 1;
      logger.warn(
        { releaseId: row.id, tag: row.tag, step: row.step, tagState: row.tagState, settled },
        settled
          ? 'runner-release: deadline reached with nothing reported'
          : 'runner-release: the overdue release moved under the pass, so the next tick reads it afresh',
      );
    } catch (err) {
      logger.error(
        { err, releaseId: row.id, tag: row.tag },
        'runner-release: naming an overdue release failed (row skipped)',
      );
    }
  }
  if (named > 0) logger.info({ named }, 'runner-release: overdue releases named');
  return { named };
}
