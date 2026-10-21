/**
 * What the Forge door reads of the items reported through it (REQ-47): which are a reporter's own,
 * and for each item how many times it was reported and where its first report came from (BC-4).
 */

import type { FeedbackOriginView } from '@forge/contracts/feedback';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { feedback, feedbackOccurrences } from '../db/schema-feedback.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';

/** The ids of the home project's items `userId` filed or reported again, newest first. */
export async function ownForgeFeedbackIds(homeId: string, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: feedback.id, at: feedback.createdAt })
    .from(feedback)
    .leftJoin(feedbackOccurrences, eq(feedbackOccurrences.feedbackId, feedback.id))
    .where(
      and(
        eq(feedback.projectId, homeId),
        or(eq(feedback.reportedBy, userId), eq(feedbackOccurrences.reportedBy, userId)),
      ),
    )
    .orderBy(asc(feedback.createdAt));
  return rows.map((r) => r.id).reverse();
}

/** Whether `userId` reported item `feedbackId`, by filing it or by a later report of it. */
export async function reportedForge(feedbackId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: feedback.id })
    .from(feedback)
    .leftJoin(feedbackOccurrences, eq(feedbackOccurrences.feedbackId, feedback.id))
    .where(
      and(
        eq(feedback.id, feedbackId),
        or(eq(feedback.reportedBy, userId), eq(feedbackOccurrences.reportedBy, userId)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Each item's reports through the Forge door: how many, and the first one's reporter and place. */
export async function forgeOriginsOf(
  feedbackIds: readonly string[],
): Promise<Map<string, FeedbackOriginView>> {
  if (feedbackIds.length === 0) return new Map();
  const rows = await db
    .select({
      feedbackId: feedbackOccurrences.feedbackId,
      reportedBy: feedbackOccurrences.reportedBy,
      agency: feedbackOccurrences.reporterAgency,
      projectId: projects.id,
      projectSlug: projects.slug,
      projectName: projects.name,
      issueId: issues.id,
      issueProjectId: issues.projectId,
      issueSeq: issues.issSeq,
      runId: feedbackOccurrences.sourceRunId,
      clientVersion: feedbackOccurrences.clientVersion,
      at: feedbackOccurrences.createdAt,
    })
    .from(feedbackOccurrences)
    .leftJoin(projects, eq(projects.id, feedbackOccurrences.sourceProjectId))
    .leftJoin(issues, eq(issues.id, feedbackOccurrences.sourceIssueId))
    .where(inArray(feedbackOccurrences.feedbackId, [...feedbackIds]))
    .orderBy(asc(feedbackOccurrences.createdAt), asc(feedbackOccurrences.id));
  const people = await peopleOf(rows.map((r) => r.reportedBy));
  const out = new Map<string, FeedbackOriginView>();
  for (const r of rows) {
    const had = out.get(r.feedbackId);
    if (had) {
      had.occurrences += 1;
      continue;
    }
    const issueKey =
      r.issueId && r.issueProjectId && r.issueSeq !== null
        ? formatIssueRef(await activeIssuePrefix(r.issueProjectId), r.issueSeq)
        : null;
    out.set(r.feedbackId, {
      occurrences: 1,
      project:
        r.projectId && r.projectSlug && r.projectName
          ? { id: r.projectId, slug: r.projectSlug, name: r.projectName }
          : null,
      issue: r.issueId && issueKey ? { id: r.issueId, key: issueKey } : null,
      run: r.runId,
      clientVersion: r.clientVersion,
      reporter: {
        id: r.reportedBy,
        name: people.get(r.reportedBy)?.name ?? null,
        agency: r.agency,
      },
      at: r.at.toISOString(),
    });
  }
  return out;
}
