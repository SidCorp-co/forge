// REQ-63: a project whose document sets `release.changeRequests` releases by merging the change
// requests its roster ships, in the order the cut declares, once the owner approves the cut. This
// reads which requests a roster ships and the order a release keeps; `change-request-merge.ts` merges.

import type { ChangeRequestState, ReleaseChangeRequest } from '@forge/contracts/releases';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type ChangeRequestHost,
  repoPullRequestIssues,
  repoPullRequests,
} from '../db/schema-repo-projection.js';
import { changeRequestLabelOf } from '../integrations/source-host/index.js';
import { issueDisplayIds } from '../issues/index.js';
import { blocker, evaluate } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';
import { refuseRelease } from './refuse.js';

/** An open change request a roster ships, with every issue it delivers. */
export interface RosterChangeRequest {
  pullRequestId: string;
  host: ChangeRequestHost;
  number: number;
  title: string;
  url: string | null;
  headSha: string;
  /** The branch it merges from. */
  headRef: string;
  state: ChangeRequestState;
  issueIds: string[];
}

/** One step of a release's declared merge order, as the run's metadata keeps it. */
export interface ReleaseMergeStep {
  pullRequestId: string;
  host: ChangeRequestHost;
  number: number;
  headSha: string;
  issueIds: string[];
}

export const label = (cr: { host: ChangeRequestHost; number: number }) =>
  changeRequestLabelOf(cr.host, cr.number);

export async function linksOf(pullRequestIds: string[]): Promise<Map<string, string[]>> {
  if (pullRequestIds.length === 0) return new Map();
  const rows = await db
    .select({ pr: repoPullRequestIssues.pullRequestId, issue: repoPullRequestIssues.issueId })
    .from(repoPullRequestIssues)
    .where(inArray(repoPullRequestIssues.pullRequestId, pullRequestIds));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.pr, [...(out.get(r.pr) ?? []), r.issue]);
  return out;
}

/** Every open change request on this project that delivers one of `issueIds`, lowest number first. */
export async function openChangeRequestsOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<RosterChangeRequest[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .selectDistinct({
      id: repoPullRequests.id,
      host: repoPullRequests.host,
      number: repoPullRequests.number,
      title: repoPullRequests.title,
      url: repoPullRequests.htmlUrl,
      headSha: repoPullRequests.headSha,
      headRef: repoPullRequests.headRef,
      state: repoPullRequests.state,
    })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(
      and(
        eq(repoPullRequests.projectId, projectId),
        eq(repoPullRequests.state, 'open'),
        inArray(repoPullRequestIssues.issueId, [...issueIds]),
      ),
    );
  const links = await linksOf(rows.map((r) => r.id));
  return rows
    .map((r) => ({
      pullRequestId: r.id,
      host: r.host,
      number: r.number,
      title: r.title,
      url: r.url,
      headSha: r.headSha,
      headRef: r.headRef,
      state: r.state,
      issueIds: links.get(r.id) ?? [],
    }))
    .sort((a, b) => a.number - b.number);
}

async function shown(ids: string[]): Promise<string[]> {
  const names = await issueDisplayIds(ids);
  return ids.map((id) => names.get(id) ?? id);
}

/**
 * What a roster owes before a change-request release may be cut: every issue a request delivering
 * it, and every request delivering only issues the roster carries — a request that also carries an
 * issue outside it would ship work the owner was never asked to accept.
 */
export async function changeRequestBlockers(
  projectId: string,
  rosterIds: string[],
  out: ReleaseBlocker[],
): Promise<void> {
  if (rosterIds.length === 0) return;
  const requests = await evaluate(
    'change-requests',
    async () => await openChangeRequestsOf(projectId, rosterIds),
    out,
  );
  if (!requests) return;
  const delivered = new Set(requests.flatMap((r) => r.issueIds));
  const missing = rosterIds.filter((id) => !delivered.has(id));
  if (missing.length > 0) {
    out.push(
      blocker('RELEASE_CHANGE_REQUEST_MISSING', {
        issueIds: missing,
        displayIds: await shown(missing),
      }),
    );
  }
  const roster = new Set(rosterIds);
  const carrying = [];
  for (const r of requests) {
    const outside = r.issueIds.filter((id) => !roster.has(id));
    if (outside.length > 0) {
      carrying.push({
        changeRequest: label(r),
        issueIds: outside,
        displayIds: await shown(outside),
      });
    }
  }
  if (carrying.length > 0) {
    out.push(blocker('RELEASE_CHANGE_REQUEST_CARRIES_UNRELEASED', { changeRequests: carrying }));
  }
}

/**
 * The order the release merges its requests in: the one the cut names, else lowest number first. A
 * named order that leaves out a request the roster needs, or names one it does not, is refused by name.
 */
export function mergeOrderOf(
  requests: RosterChangeRequest[],
  named: number[] | undefined,
): ReleaseMergeStep[] {
  const step = (r: RosterChangeRequest): ReleaseMergeStep => ({
    pullRequestId: r.pullRequestId,
    host: r.host,
    number: r.number,
    headSha: r.headSha,
    issueIds: r.issueIds,
  });
  if (!named) return requests.map(step);
  const byNumber = new Map(requests.map((r) => [r.number, r]));
  const unknown = named.filter((n) => !byNumber.has(n));
  const left = requests.filter((r) => !named.includes(r.number));
  const twice = named.filter((n, i) => named.indexOf(n) !== i);
  if (unknown.length > 0 || left.length > 0 || twice.length > 0) {
    const all = requests.map(label).join(', ');
    const faults = [
      unknown.length > 0
        ? `it names ${unknown.join(', ')}, which deliver no issue in this release`
        : null,
      left.length > 0 ? `it leaves out ${left.map(label).join(', ')}` : null,
      twice.length > 0 ? `it names ${twice.join(', ')} twice` : null,
    ].filter(Boolean);
    throw refuseRelease(
      'RELEASE_CHANGE_REQUEST_ORDER',
      `\`changeRequests\` is the order this release merges its change requests in, each once: ${faults.join('; ')}. The requests this roster ships are ${all}.`,
      '/changeRequests',
    );
  }
  return named.map((n) => step(byNumber.get(n) as RosterChangeRequest));
}

/** The declared merge order a release run keeps, or null where the run is not a change-request one. */
export function mergeStepsOf(metadata: unknown): ReleaseMergeStep[] | null {
  const steps = (metadata as { changeRequests?: unknown } | null)?.changeRequests;
  return Array.isArray(steps) ? (steps as ReleaseMergeStep[]) : null;
}

/** One link between an issue and a change request on this project, as a release page reads it. */
export interface ChangeRequestLinkRow {
  issueId: string;
  pullRequestId: string;
  host: ChangeRequestHost;
  number: number;
  title: string;
  url: string | null;
  state: ChangeRequestState;
  updatedAt: Date;
}

/** Every change request linked to these issues on this project, any state. */
export async function readChangeRequestLinks(
  projectId: string,
  issueIds: readonly string[],
): Promise<ChangeRequestLinkRow[]> {
  if (issueIds.length === 0) return [];
  return db
    .select({
      issueId: repoPullRequestIssues.issueId,
      pullRequestId: repoPullRequests.id,
      host: repoPullRequests.host,
      number: repoPullRequests.number,
      title: repoPullRequests.title,
      url: repoPullRequests.htmlUrl,
      state: repoPullRequests.state,
      updatedAt: repoPullRequests.updatedAt,
    })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(
      and(
        eq(repoPullRequests.projectId, projectId),
        inArray(repoPullRequestIssues.issueId, [...issueIds]),
      ),
    );
}

/**
 * The one change request a release shows beside each issue (REQ-63 BC-5): the one the release
 * merges, in its order; else an open one; else a merged one; else the latest any state.
 */
export function changeRequestViews(
  rows: readonly ChangeRequestLinkRow[],
  steps: readonly ReleaseMergeStep[] | null,
): Map<string, ReleaseChangeRequest> {
  const orderOf = new Map((steps ?? []).map((s, i) => [s.pullRequestId, i + 1]));
  const rank = (r: ChangeRequestLinkRow) =>
    (orderOf.has(r.pullRequestId) ? 4 : 0) +
    (r.state === 'open' ? 2 : 0) +
    (r.state === 'merged' ? 1 : 0);
  const best = new Map<string, ChangeRequestLinkRow>();
  for (const r of rows) {
    const held = best.get(r.issueId);
    const wins =
      !held || rank(r) > rank(held) || (rank(r) === rank(held) && r.updatedAt > held.updatedAt);
    if (wins) best.set(r.issueId, r);
  }
  const out = new Map<string, ReleaseChangeRequest>();
  for (const [issueId, r] of best) {
    out.set(issueId, {
      label: label(r),
      number: r.number,
      title: r.title,
      url: r.url,
      state: r.state,
      order: orderOf.get(r.pullRequestId) ?? null,
    });
  }
  return out;
}
