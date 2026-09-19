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
        const ids = payload.issueId
          ? await openPullRequestsForIssue(payload.issueId)
          : await openPullRequestsForProject(payload.projectId);
        await publishAll(ids, payload.reason);
      }),
    { name: 'github-contract-check-record' },
  );

  bus.on(
    'dependencyChanged',
    async (payload) =>
      guarded('dependencyChanged', async () =>
        publishAll(await openPullRequestsForIssue(payload.fromIssueId), 'dependencyChanged'),
      ),
    { name: 'github-contract-check-dependency' },
  );
}
