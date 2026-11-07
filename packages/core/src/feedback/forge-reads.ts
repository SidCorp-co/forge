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

/** The id of the home project's item FB-n, or null where it holds none. */
export async function forgeFeedbackIdOfKey(homeId: string, key: string): Promise<string | null> {
  const seq = Number(/^FB-(\d+)$/.exec(key)?.[1]);
  if (!Number.isSafeInteger(seq)) return null;
  const [row] = await db
    .select({ id: feedback.id })
    .from(feedback)
    .where(and(eq(feedback.projectId, homeId), eq(feedback.fbSeq, seq)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The items `ids` names and every item one of them duplicates, followed to its root: an item's
 * progress is read from its root's (`product-progress/feedback-views.ts`), so a door reading only
 * the items it shows reads their roots with them.
 */
export async function withDuplicateRoots(
  homeId: string,
  ids: readonly string[],
): Promise<string[]> {
  const seen = new Set(ids);
  for (let frontier = [...seen]; frontier.length > 0; ) {
    const rows = await db
      .select({ duplicateOf: feedback.duplicateOf })
      .from(feedback)
      .where(and(eq(feedback.projectId, homeId), inArray(feedback.id, frontier)));
    frontier = [];
    for (const r of rows) {
      if (r.duplicateOf && !seen.has(r.duplicateOf)) {
        seen.add(r.duplicateOf);
        frontier.push(r.duplicateOf);
      }
    }
  }
  return [...seen];
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

/** What `forgeOriginsOf` reads: each item's origin view, and the items every report of which came from an archived project. */
export interface ForgeOrigins {
  views: Map<string, FeedbackOriginView>;
  /** Reported only from projects since archived: nobody delivers there, so the item's wait never reads stuck (ISS-1072). */
  fromArchived: Set<string>;
}

/** Each item's reports through the Forge door: how many, the first one's reporter and place, and whether every place is archived. */
export async function forgeOriginsOf(feedbackIds: readonly string[]): Promise<ForgeOrigins> {
  if (feedbackIds.length === 0) return { views: new Map(), fromArchived: new Set() };
  const rows = await db
    .select({
      feedbackId: feedbackOccurrences.feedbackId,
      reportedBy: feedbackOccurrences.reportedBy,
      agency: feedbackOccurrences.reporterAgency,
      projectId: projects.id,
      projectSlug: projects.slug,
      projectName: projects.name,
      projectArchivedAt: projects.archivedAt,
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
  // an item stays live while one of its reports came from a live project, or from no project at all
  const live = new Set(
    rows
      .filter((r) => r.projectId === null || r.projectArchivedAt === null)
      .map((r) => r.feedbackId),
  );
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
  return { views: out, fromArchived: new Set([...out.keys()].filter((id) => !live.has(id))) };
}
