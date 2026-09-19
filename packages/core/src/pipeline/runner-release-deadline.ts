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

function leadFor(row: RunnerReleaseRow, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - row.startedAt.getTime()) / 60_000));
  if (row.step === 'await_build') {
    return (
      `Forge cut \`${row.tag}\` ${minutes} minutes ago and GitHub has reported no build for it. ` +
      'Forge hears a build on a `workflow_run` delivery and never polls, so check two things on ' +
      "this project's GitHub App, both on its Permissions & events page: that Actions is set to " +
      'Read-only, which is the permission GitHub gates that event on, and that Workflow run is ' +
      'ticked under Subscribe to events. A permission added to an App also needs approving on ' +
      'the installation.'
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
export async function nameOverdueRunnerReleases(
  now: Date = new Date(),
): Promise<RunnerReleaseDeadlineResult> {
  const rows = await overdueReleases(now);
  let named = 0;
  for (const row of rows) {
    const failure = `${leadFor(row, now)} ${repositoryTruth({
      tag: row.tag,
      commitSha: row.commitSha,
      tagCommitSha: row.tagCommitSha,
      tagState: row.tagState,
      publication: row.publication,
      publicationDetail: row.publicationDetail,
    })}`;
    try {
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
