/**
 * What a feedback item's standing reads beyond its own row (REQ-48 BC-9): the own standing of each
 * issue still carrying it, read with no viewer, its newest triage decision, and whether a master
 * serves the project; then, per item, the carrier it rolls up and the draft that holds it triaged.
 */

import type { IssueStanding } from '@forge/contracts/issue-standing';
import type { MasterServing } from '@forge/contracts/steward';
import { inArray, max } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedbackDecisions } from '../db/schema-feedback.js';
import { issueWaitsOf } from '../issues/index.js';
import { masterServingOf } from '../masters/index.js';
import type { Row } from './read.js';
import type { CarrierStanding } from './standing.js';

export interface StandingFacts {
  /** Each owed carrier issue's own standing, by issue id, read with no viewer. */
  carrierStandings: Map<string, IssueStanding>;
  /** Each row's newest triage decision: since when its wait stands where no carrier says. */
  decidedAt: Map<string, Date>;
  /** Whether a live master serves the project (`masters/read.ts:masterServingOf`). */
  master: MasterServing;
}

/** What `linkedOf` reads for every row's standing, in one statement each. */
export async function standingFactsOf(
  projectId: string,
  rows: readonly Row[],
  issueRows: readonly { id: string; status: string }[],
  carrying: ReadonlySet<string>,
): Promise<StandingFacts> {
  const owed = issueRows
    .filter((i) => carrying.has(i.id) && i.status !== 'closed' && i.status !== 'dropped')
    .map((i) => i.id);
  const [waits, decidedAt, master] = await Promise.all([
    issueWaitsOf(projectId, owed, null),
    decidedAtOf(rows.map((r) => r.id)),
    masterServingOf(projectId),
  ]);
  return {
    carrierStandings: new Map([...waits].map(([id, c]) => [id, c.standing])),
    decidedAt,
    master,
  };
}

/** Each item's newest triage decision, by item id. */
async function decidedAtOf(feedbackIds: readonly string[]): Promise<Map<string, Date>> {
  if (feedbackIds.length === 0) return new Map();
  const rows = await db
    .select({ id: feedbackDecisions.feedbackId, at: max(feedbackDecisions.decidedAt) })
    .from(feedbackDecisions)
    .where(inArray(feedbackDecisions.feedbackId, [...feedbackIds]))
    .groupBy(feedbackDecisions.feedbackId);
  return new Map(rows.flatMap((r) => (r.at ? [[r.id, new Date(r.at)] as const] : [])));
}

/**
 * The owed carrier a planned item rolls up and the first draft carrier, where there is one: a stuck
 * carrier first (the oldest), else the first owed (REQ-48 BC-9).
 */
export function carriersOf(
  r: Row,
  l: StandingFacts & {
    routeIssues: Map<string, string[]>;
    issues: Map<string, { key: string; status: string }>;
  },
): { carrier: CarrierStanding | null; draft: string | null } {
  const owed = (l.routeIssues.get(r.id) ?? []).flatMap((id) => {
    const issue = l.issues.get(id);
    const own = l.carrierStandings.get(id);
    return issue && own ? [{ key: issue.key, status: issue.status, own }] : [];
  });
  const draft = owed.find((c) => c.status === 'draft')?.key ?? null;
  const live = owed.filter((c) => c.status !== 'draft');
  const stuck = live
    .filter((c) => c.own.times.stuck)
    .sort((a, b) => (a.own.times.stuck?.since ?? '').localeCompare(b.own.times.stuck?.since ?? ''));
  const first = stuck[0] ?? live[0];
  return {
    draft,
    carrier: first
      ? {
          key: first.key,
          waitingOn: first.own.waitingOn,
          since: new Date(first.own.times.since),
          stuck: first.own.times.stuck,
        }
      : null,
  };
}
