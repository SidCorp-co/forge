/**
 * What makes the check run re-publish, and the one thing that must never make
 * it. ISS-1072.
 *
 * ISS-1072's fourth outcome: the check re-publishes on every event that changes
 * the answer — a new head, a status move, a record written — and NEVER by
 * polling. So there is no timer here, no interval and no sweeper tick: every
 * line below hangs off an event somebody else already emits, and a reader
 * checking that claim can check it by looking for a scheduler in this file and
 * finding none.
 *
 * The `pull_request` half is not here: a head moves in
 * `projection-events.ts:onPullRequest`, which is where the row that moved is
 * already in hand. A `check_run` delivery reaches neither, deliberately — it is
 * how Forge's own run comes back, and publishing on it is a loop feeding on its
 * own echo.
 */

import { logger } from '../../logger.js';
import { type HooksBus, hooks } from '../../pipeline/hooks.js';
import {
  noteNotPublished,
  openPullRequestsForIssue,
  openPullRequestsForProject,
  publishForStoredPullRequest,
} from './contract-check.js';

/**
 * How many pull requests one project-wide republication will ask GitHub about.
 *
 * A project changing which records a status requires moves the answer for every
 * open pull request it has at once, and a repository with sixty of them would
 * spend a rate limit on one settings save. The rows past the cap are RECORDED
 * rather than dropped, which is the whole difference between a bound and a
 * silent truncation.
 */
export const PROJECT_REPUBLISH_CAP = 25;

const cappedReason = (total: number) =>
  `${total} open pull request(s) on this project all needed republishing at once and Forge publishes at most ${PROJECT_REPUBLISH_CAP} per event; this one is past that bound and its check still reports the previous answer. It republishes on its own next event — a push, a status move or a record written.`;

/** Publish for each of these, and record the ones past the cap rather than dropping them. */
async function publishAll(pullRequestIds: string[], why: string): Promise<void> {
  if (pullRequestIds.length === 0) return;
  for (const id of pullRequestIds.slice(0, PROJECT_REPUBLISH_CAP)) {
    await publishForStoredPullRequest(id);
  }
  // cm:guard `slice` past the cap takes ALL the remainder, and every one of them gets a row. The shape this mirrors is `projection-events.ts:onPush`, whose own guard records what reading `cap + 1` and marking one extra cost: on a base with 27 open pull requests it left two stale with no sentence on them.
  for (const id of pullRequestIds.slice(PROJECT_REPUBLISH_CAP)) {
    await noteNotPublished(id, cappedReason(pullRequestIds.length));
  }
  logger.info(
    {
      count: pullRequestIds.length,
      capped: Math.max(0, pullRequestIds.length - PROJECT_REPUBLISH_CAP),
      why,
    },
    'contract check: republished',
  );
}

// cm:guard every handler swallows its own failure. `HooksBus.emit` records a throwing subscriber and carries on, but this one shares the `transition` topic with the pipeline orchestrator, whose delivery IS asserted — and a GitHub outage must not be able to put a red on an outbox row that nothing here owns.
async function guarded(why: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    logger.warn({ err, why }, 'contract check: republication failed');
  }
}

export function registerContractCheckSubscribers(bus: HooksBus = hooks): void {
  bus.on(
    'transition',
    async (payload) =>
      guarded('transition', async () =>
        publishAll(await openPullRequestsForIssue(payload.issueId), 'transition'),
      ),
    { name: 'github-contract-check-transition' },
  );

  bus.on(
    'contractInputChanged',
    async (payload) =>
      guarded('contractInputChanged', async () => {
        // cm:guard an absent `issueId` means the DECLARATION moved, not one issue's records, and it is the only case that fans out over a project. Reading it as "no issue, nothing to do" would make a project's own settings save the one contract change that never reached a check run.
        const ids = payload.issueId
          ? await openPullRequestsForIssue(payload.issueId)
          : await openPullRequestsForProject(payload.projectId);
        await publishAll(ids, payload.reason);
      }),
    { name: 'github-contract-check-record' },
  );

  // cm:guard NOT filtered to the work-evidence waiver kind, though that is the only kind `entry-criteria.ts` reads today. The filter would be one line and would be wrong the first time another criterion learns to read an edge: the cost of not filtering is one indexed lookup on a project with no open pull requests, and the cost of filtering is a check that goes stale for a reason nobody is looking for.
  bus.on(
    'dependencyChanged',
    async (payload) =>
      guarded('dependencyChanged', async () =>
        publishAll(await openPullRequestsForIssue(payload.fromIssueId), 'dependencyChanged'),
      ),
    { name: 'github-contract-check-dependency' },
  );
}
