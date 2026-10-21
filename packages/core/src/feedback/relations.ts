import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { feedbackRouteIssues } from '../db/schema-feedback.js';
import { feedbackLinksOf, rowIn as requirementIn } from '../requirements/index.js';
import type { Row } from './read.js';

export const NO_FEEDBACK = '00000000-0000-0000-0000-000000000000';

export async function feedbackIdsOfRequirement(projectId: string, ref: string): Promise<string[]> {
  const req = await requirementIn(db, projectId, ref);
  return (await feedbackLinksOf(projectId, [req.id])).map((l) => l.feedbackId);
}

/** Every issue an issue route names, per item, oldest issue first. */
export async function routeIssuesOf(rows: Row[]): Promise<Map<string, string[]>> {
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
