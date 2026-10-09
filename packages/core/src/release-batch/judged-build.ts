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
import { db } from '../db/client.js';
import { shipsWithdrawnOf } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { ANCESTRY_PAIRS_MAX, type AncestryPair, pairKey } from '../runners/index.js';
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
  /** Whether the issue was moved out of `closed` since it last closed, so no release it was closed
   *  into holds its current work (`issues/release-evidence.ts:shipsWithdrawnOf`). */
  withdrawn(issueId: string): Promise<boolean>;
}

const LIVE_DEPS: JudgedBuildDeps = {
  served: servedProductionCommit,
  releases: shippedReleaseRuns,
  ancestry: (projectId) => ancestrySourceFor(projectId),
  withdrawn: async (issueId) => (await shipsWithdrawnOf(db, [issueId])).has(issueId),
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
  const withdrawn = await deps.withdrawn(issue.id);
  // A release that closed an issue its reopen took back shipped rejected work: none carries it now.
  const releases = (await deps.releases(issue.projectId)).map((r) =>
    withdrawn ? { ...r, issueIds: r.issueIds.filter((id) => id !== issue.id) } : r,
  );
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

/**
 * What the live build holds of the commits verdicts were judged at, for a requirement's coverage
 * (`requirements/standing-coverage.ts:coverageOf`). `runtimes` are the runtimes verdicts were judged
 * at: each resolves to the commit that build served the way production's own answer does
 * (`liveCommitOf`: a whole commit as it reads, else the one release Forge verified whose commit it
 * names), or to null where neither holds, and the commits it resolves to are asked beside `commits`.
 * Per asked commit, lower case, either whether it is the commit production serves now or an ancestor
 * of it (`holds`), read by the same reader and kept in the same cache as `judgedBuildOf`'s, or why
 * nobody could answer (`unanswered`) — never neither, since coverage counts no verdict whose hold it
 * cannot name. `sha` is null, `holds` empty and every commit unanswered where the live build itself
 * cannot be read; the whole answer is null where nothing was asked.
 */
export async function liveBuildHolds(
  projectId: string,
  asked: { commits: readonly string[]; runtimes?: readonly string[] },
  deps: JudgedBuildDeps = LIVE_DEPS,
): Promise<{
  sha: string | null;
  holds: Map<string, boolean>;
  runtimes: Map<string, string | null>;
  unanswered: Map<string, string>;
} | null> {
  const clean = (xs: readonly string[]) => [
    ...new Set(xs.map((c) => c.trim().toLowerCase()).filter((c) => c !== '')),
  ];
  const refs = clean(asked.runtimes ?? []);
  const runtimes = new Map<string, string | null>();
  if (refs.length > 0) {
    const releases = await deps.releases(projectId);
    for (const ref of refs) runtimes.set(ref, liveCommitOf(ref, releases));
  }
  const commits = clean([
    ...asked.commits,
    ...[...runtimes.values()].filter((c): c is string => c !== null),
  ]);
  if (commits.length === 0 && refs.length === 0) return null;
  const holds = new Map<string, boolean>();
  const unanswered = new Map<string, string>();
  if (commits.length === 0) return { sha: null, holds, runtimes, unanswered };
  const live = await liveCommitFor(projectId, deps);
  if ('unread' in live) {
    for (const commit of commits) unanswered.set(commit, live.unread);
    return { sha: null, holds, runtimes, unanswered };
  }
  const open: AncestryPair[] = [];
  for (const commit of commits) {
    const same = commit.length >= 7 && live.sha.startsWith(commit);
    const held = same ? true : ANSWERED.get(pairKey({ commit, release: live.sha }));
    if (held !== undefined) holds.set(commit, held);
    else open.push({ commit, release: live.sha });
  }
  const why = open.length > 0 ? await askAncestry(projectId, open, deps) : new Map();
  for (const pair of open) {
    const answer = ANSWERED.get(pairKey(pair));
    if (answer !== undefined) holds.set(pair.commit, answer);
    else
      unanswered.set(pair.commit, why.get(pairKey(pair)) ?? 'the ancestry reader gave no answer');
  }
  return { sha: live.sha, holds, runtimes, unanswered };
}

// A list of requirements reads its coverage on every load, so the commit production serves is read
// at most once per project in LIVE_FOR_MS; a deploy shows in coverage that much later at most.
const LIVE_FOR_MS = 30_000;
const LIVE_READ = new Map<string, { at: number; sha: string }>();

/** The commit production serves now, whole, or why it cannot be read. */
async function liveCommitFor(
  projectId: string,
  deps: JudgedBuildDeps,
): Promise<{ sha: string } | { unread: string }> {
  const held = deps === LIVE_DEPS ? LIVE_READ.get(projectId) : undefined;
  if (held && Date.now() - held.at < LIVE_FOR_MS) return { sha: held.sha };
  const served = await deps.served(projectId);
  if (!served.ok) return { unread: `the live build could not be read: ${served.why}` };
  const live = liveCommitOf(served.value, await deps.releases(projectId));
  if (!live) {
    return {
      unread: `production answers \`${served.value}\`, which names no single release Forge verified`,
    };
  }
  if (deps === LIVE_DEPS) LIVE_READ.set(projectId, { at: Date.now(), sha: live });
  return { sha: live };
}

/**
 * Asks `pairs` of the project's ancestry reader and keeps each answer; answers, per pair key it could
 * not settle, why — no reader can be asked, the reader was silent, it could not answer that pair, or
 * it failed (logged too).
 */
async function askAncestry(
  projectId: string,
  pairs: readonly AncestryPair[],
  deps: JudgedBuildDeps,
): Promise<Map<string, string>> {
  const why = new Map<string, string>();
  const all = (reason: string, from = 0) => {
    for (const p of pairs.slice(from)) if (!why.has(pairKey(p))) why.set(pairKey(p), reason);
  };
  let at = 0;
  try {
    const source = await deps.ancestry(projectId);
    if (source.kind === 'none') {
      all(`no ancestry reader can be asked: ${source.why}`);
      return why;
    }
    for (; at < pairs.length; at += ANCESTRY_PAIRS_MAX) {
      const answers = await source.reader.ask(pairs.slice(at, at + ANCESTRY_PAIRS_MAX));
      if (!(answers instanceof Map)) {
        all(`the ancestry reader did not answer: ${answers.silent}`, at);
        return why;
      }
      for (const [key, answer] of answers) {
        if (typeof answer !== 'boolean') {
          why.set(key, `the ancestry reader could not answer: ${answer.unread}`);
          continue;
        }
        if (ANSWERED.size >= ANSWERED_LIMIT) ANSWERED.clear();
        ANSWERED.set(key, answer);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { projectId, err: message },
      'live build ancestry unread: verdict commits it was asked about do not count',
    );
    all(`the ancestry reader failed: ${message}`, at);
  }
  return why;
}
