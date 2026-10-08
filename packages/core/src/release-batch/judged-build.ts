/**
 * The build a verdict on an issue is judged against by default (REQ-6 BC-2, BC-4): the commit
 * production serves now where Forge can show it carries the issue's work, else the build that
 * shipped the work, else the commit it merged as. Read when asked and never stored.
 *
 * The live build is what the production probe answers (`provider-live.ts:servedProductionCommit`),
 * never a branch head. It carries the issue where the release verified at that commit holds the issue
 * on its roster, or where the issue's work commit (the release that shipped it, else its merge) is an
 * ancestor of it — asked of the source host, or of the box holding a bound checkout where no host is
 * bound (`shipped-earlier.ts:ancestrySourceFor`). Nothing is inferred: a pair nobody could read
 * falls back to the build the issue is known to be in, and `basis` says why.
 */

import type { JudgedBuild } from '@forge/contracts/verdict-identity';
import { pairKey } from '../runners/index.js';
import { type Reading, servedProductionCommit } from './provider-live.js';
import {
  type AncestrySource,
  ancestrySourceFor,
  type ShippedReleaseRun,
  shippedReleaseRuns,
} from './shipped-earlier.js';
import { deploymentConfirms } from './verify.js';

const WHOLE = /^[0-9a-f]{40}$/i;

export interface JudgedBuildIssue {
  id: string;
  projectId: string;
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
}

export interface JudgedBuildDeps {
  served(projectId: string): Promise<Reading<string>>;
  releases(projectId: string): Promise<ShippedReleaseRun[]>;
  ancestry(projectId: string): Promise<AncestrySource>;
}

const LIVE_DEPS: JudgedBuildDeps = {
  served: servedProductionCommit,
  releases: shippedReleaseRuns,
  ancestry: (projectId) => ancestrySourceFor(projectId),
};

// Ancestry between two commits never changes, so an answer is kept for the process, bounded.
const ANSWERED = new Map<string, boolean>();
const ANSWERED_LIMIT = 5_000;

/** Whether `commit` is in `live`, or why that could not be read. */
async function carried(
  source: AncestrySource,
  commit: string,
  live: string,
): Promise<boolean | { unread: string }> {
  const pair = { commit, release: live };
  const held = ANSWERED.get(pairKey(pair));
  if (held !== undefined) return held;
  if (source.kind === 'none') return { unread: source.why };
  const answers = await source.reader.ask([pair]);
  if (!(answers instanceof Map)) return { unread: answers.silent };
  const answer = answers.get(pairKey(pair));
  if (typeof answer !== 'boolean') return { unread: answer?.unread ?? 'the reader gave no answer' };
  if (ANSWERED.size >= ANSWERED_LIMIT) ANSWERED.clear();
  ANSWERED.set(pairKey(pair), answer);
  return answer;
}

/** The commit production serves now, whole: as the probe answered it, or the release it names. */
function liveCommitOf(served: string, releases: readonly ShippedReleaseRun[]): string | null {
  if (WHOLE.test(served)) return served.toLowerCase();
  const named = releases.filter((r) => deploymentConfirms(r.commit, served));
  return named.length === 1 ? (named[0] as ShippedReleaseRun).commit : null;
}

/** What the issue's work is known to be in, without asking the live build. */
function fallback(
  issue: JudgedBuildIssue,
  shippedIn: ShippedReleaseRun | null,
  why: string,
): JudgedBuild {
  if (shippedIn) {
    return {
      sha: shippedIn.commit,
      source: 'shipped',
      version: shippedIn.version,
      basis: `release ${shippedIn.version} shipped this issue's work at this commit; ${why}`,
    };
  }
  const merged = issue.mergedCommitSha?.trim().toLowerCase() ?? '';
  if (WHOLE.test(merged)) {
    return {
      sha: merged,
      source: 'merged',
      version: null,
      basis: `this issue merged as this commit and no release Forge verified carries it yet; ${why}`,
    };
  }
  return {
    sha: null,
    source: null,
    version: null,
    basis:
      issue.mergedAt == null
        ? 'this issue has not merged, so no build carries its work yet'
        : `this issue's merge names no commit and no release Forge verified carries it; ${why}`,
  };
}

/** The build a verdict on `issue` defaults to, and how Forge knows. */
export async function judgedBuildOf(
  issue: JudgedBuildIssue,
  deps: JudgedBuildDeps = LIVE_DEPS,
): Promise<JudgedBuild> {
  const releases = await deps.releases(issue.projectId);
  const carrying = releases.filter((r) => r.issueIds.includes(issue.id));
  const shippedIn = carrying[carrying.length - 1] ?? null;
  const served = await deps.served(issue.projectId);
  if (!served.ok) {
    return fallback(issue, shippedIn, `the live build could not be read: ${served.why}`);
  }
  const live = liveCommitOf(served.value, releases);
  if (!live) {
    return fallback(
      issue,
      shippedIn,
      `production answers \`${served.value}\`, which names no single release Forge verified`,
    );
  }
  const liveRelease = releases.find((r) => r.commit === live) ?? null;
  const isLive = (basis: string): JudgedBuild => ({
    sha: live,
    source: 'live',
    version: liveRelease?.version ?? null,
    basis,
  });
  if (liveRelease?.issueIds.includes(issue.id)) {
    return isLive(`production serves release ${liveRelease.version}, which shipped this issue`);
  }
  const merged = issue.mergedCommitSha?.trim().toLowerCase() ?? '';
  const work = shippedIn?.commit ?? (WHOLE.test(merged) ? merged : null);
  if (!work) return fallback(issue, null, `production serves \`${live}\``);
  if (work === live) return isLive('production serves the commit this issue shipped at');
  const answer = await carried(await deps.ancestry(issue.projectId), work, live);
  const whose = shippedIn ? `release ${shippedIn.version}'s commit` : "this issue's merge commit";
  if (answer === true) {
    return isLive(`production serves \`${live}\`, which holds ${whose} \`${work}\``);
  }
  return fallback(
    issue,
    shippedIn,
    answer === false
      ? `production serves \`${live}\`, which does not hold it`
      : `whether production's \`${live}\` holds it could not be read: ${answer.unread}`,
  );
}
