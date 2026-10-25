/**
 * Which shipped feedback items owe an agent reporter's confirm, read for the master of the project that
 * agent reported from (REQ-66 BC-8). An agent has no bell: its fix shipping asks it through its own
 * read of the item (`ship-notice.ts`), and the item waits on it (`standing.ts`). That project's master
 * is the one that acts for it, so its box reads these on every sweep, and the release that ships one
 * wakes it (`ws/master-wake.ts`). The project an item was reported from is its reporter's first
 * occurrence that names one (REQ-47: an item about Forge sits in the home project, filed from the
 * agent's own); an item with none was filed in its own project, which is where its reporter works.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { and, eq, inArray, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import { forgeHomeProject } from '../instance-settings/index.js';
import { userNames } from '../lib/people.js';
import { linkedOf, phaseIn } from './list-read.js';
import type { Row } from './read.js';

export interface OwedAgentConfirm {
  feedbackId: string;
  key: string;
  /** The account that reported it, which the confirm is made as. */
  reporter: string;
  /** The project the item sits in. */
  itemProjectId: string;
  /** Whether that is the Forge home project, whose items are settled through the Forge door. */
  home: boolean;
}

/**
 * The project the item's reporter reported it from. Spelled with its table names: inside a select list
 * drizzle renders a column unqualified, and an unqualified `id` here would be the occurrence's own.
 */
const reportedFrom = sql<string>`coalesce((
  SELECT o.source_project_id FROM feedback_occurrences o
   WHERE o.feedback_id = feedback.id AND o.reported_by = feedback.reported_by
     AND o.source_project_id IS NOT NULL
   ORDER BY o.created_at LIMIT 1
), feedback.project_id)`;

/** Agent-reported items the reporter may still settle, matching `where`; whether each reads resolved is derived after. */
async function candidates(where: SQL | undefined): Promise<(Row & { from: string })[]> {
  const rows = await db
    .select({ row: feedback, from: reportedFrom })
    .from(feedback)
    .where(
      and(
        eq(feedback.status, 'triaged'),
        eq(feedback.reporterAgency, 'agent'),
        isNull(feedback.redactedAt),
        // a snoozed item is owed to nobody until its date
        or(isNull(feedback.snoozedUntil), lte(feedback.snoozedUntil, new Date())),
        where,
      ),
    )
    .orderBy(feedback.fbSeq);
  return rows.map((r) => ({ ...r.row, from: r.from }));
}

async function resolvedAmong(rows: (Row & { from: string })[]): Promise<OwedAgentConfirm[]> {
  if (rows.length === 0) return [];
  const byProject = new Map<string, (Row & { from: string })[]>();
  for (const r of rows) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
  const [home, names] = await Promise.all([
    forgeHomeProject(),
    userNames(rows.map((r) => r.reportedBy)),
  ]);
  const out: OwedAgentConfirm[] = [];
  for (const [projectId, items] of byProject) {
    const linked = await linkedOf(projectId, items);
    for (const r of items) {
      if (phaseIn(r, linked) !== 'resolved') continue;
      out.push({
        feedbackId: r.id,
        key: feedbackKey(r.fbSeq),
        reporter: names.get(r.reportedBy) ?? r.reportedBy,
        itemProjectId: projectId,
        home: projectId === home?.id,
      });
    }
  }
  return out;
}

/** The shipped items agents of `projectId` reported, each owing that agent's confirm or reopen. */
export async function owedAgentConfirms(projectId: string): Promise<OwedAgentConfirm[]> {
  return resolvedAmong(await candidates(sql`${reportedFrom} = ${projectId}`));
}

/**
 * Of the agent-reported items `issueIds` carry, the ones now owing their reporter's confirm, each with
 * the project it was reported from: whose master the ship wakes.
 */
export async function confirmsOwedByShip(
  issueIds: readonly string[],
): Promise<(OwedAgentConfirm & { reportedFrom: string })[]> {
  if (issueIds.length === 0) return [];
  const carried = db
    .select({ id: feedbackRouteIssues.feedbackId })
    .from(feedbackRouteIssues)
    .where(inArray(feedbackRouteIssues.issueId, [...issueIds]));
  const rows = await candidates(inArray(feedback.id, carried));
  const from = new Map(rows.map((r) => [r.id, r.from]));
  return (await resolvedAmong(rows)).map((o) => ({
    ...o,
    reportedFrom: from.get(o.feedbackId) ?? o.itemProjectId,
  }));
}
