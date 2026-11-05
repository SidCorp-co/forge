import { type FeedbackRoute, type FeedbackStatus, feedbackKey } from '@forge/contracts/feedback';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import { feedbackLinksOf, rowIn as requirementIn } from '../requirements/index.js';
import type { Row } from './read.js';

export const NO_FEEDBACK = '00000000-0000-0000-0000-000000000000';

export async function feedbackIdsOfRequirement(projectId: string, ref: string): Promise<string[]> {
  const req = await requirementIn(db, projectId, ref);
  return (await feedbackLinksOf(projectId, [req.id])).map((l) => l.feedbackId);
}

/** Every issue an issue route names, per item, oldest issue first. */
export async function routeIssuesOf(
  rows: readonly Pick<Row, 'id' | 'route'>[],
): Promise<Map<string, string[]>> {
  const routed = rows.filter((r) => r.route === 'issue').map((r) => r.id);
  const out = new Map<string, string[]>();
  if (routed.length === 0) return out;
  const links = await db
    .select({ feedbackId: feedbackRouteIssues.feedbackId, issueId: feedbackRouteIssues.issueId })
    .from(feedbackRouteIssues)
    .innerJoin(issues, eq(issues.id, feedbackRouteIssues.issueId))
    .where(inArray(feedbackRouteIssues.feedbackId, routed))
    .orderBy(asc(issues.issSeq));
  for (const l of links) out.set(l.feedbackId, [...(out.get(l.feedbackId) ?? []), l.issueId]);
  return out;
}

/** What an item's triage made of it, read from its own record: its route and the issues it names. */
export interface TriageOutcome {
  key: string;
  status: FeedbackStatus;
  route: FeedbackRoute | null;
  answer: string | null;
  /** The issues an issue route names, oldest first; empty for any other route. */
  issueIds: string[];
}

/** The triage outcome of each item by id (the beta port's mirror reads it, ISS-982). */
export async function triageOutcomesOf(
  feedbackIds: readonly string[],
): Promise<Map<string, TriageOutcome>> {
  if (feedbackIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: feedback.id,
      projectId: feedback.projectId,
      fbSeq: feedback.fbSeq,
      status: feedback.status,
      route: feedback.route,
      answer: feedback.answer,
    })
    .from(feedback)
    .where(inArray(feedback.id, [...feedbackIds]));
  const issueIds = await routeIssuesOf(rows);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        key: feedbackKey(r.fbSeq),
        status: r.status,
        route: r.route,
        answer: r.answer,
        issueIds: issueIds.get(r.id) ?? [],
      },
    ]),
  );
}

/** The items whose issue route names `issueId`. */
export async function feedbackIdsRoutingTo(issueId: string): Promise<string[]> {
  const rows = await db
    .select({ feedbackId: feedbackRouteIssues.feedbackId })
    .from(feedbackRouteIssues)
    .where(eq(feedbackRouteIssues.issueId, issueId));
  return rows.map((r) => r.feedbackId);
}

/** The id of the item `FB-<seq>` of a project, or null where it holds none. */
export async function feedbackIdOfSeq(projectId: string, seq: number): Promise<string | null> {
  const [row] = await db
    .select({ id: feedback.id })
    .from(feedback)
    .where(and(eq(feedback.projectId, projectId), eq(feedback.fbSeq, seq)))
    .limit(1);
  return row?.id ?? null;
}
