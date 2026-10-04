/**
 * The feedback case (workflow requirement-to-delivery step `fb-case`): one per item, opened by triage
 * with the route it decided, and closed for routing once what carries the route is written.
 */

import {
  FEEDBACK_ROUTE_SLA_WORKING_DAYS,
  type FeedbackCaseOwner,
  type FeedbackCaseView,
  type FeedbackTriageRoute,
} from '@forge/contracts/feedback';
import { eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedbackCases } from '../db/schema-feedback.js';
import { addWorkingDays } from '../lib/working-days.js';
import type { FeedbackActor, Row } from './read.js';

export type CaseRow = typeof feedbackCases.$inferSelect;

/** An issue route is the project master's to file or link; every other route is the BA's. */
export const caseOwnerOf = (route: FeedbackTriageRoute): FeedbackCaseOwner =>
  route === 'issue' ? 'master' : 'ba';

/** The route task is due by severity; a contract change at the end of its commitment window. */
export function caseDueAt(row: Row, now: Date): Date {
  if (row.kind === 'contract_change' && row.dueAt) return row.dueAt;
  return addWorkingDays(now, FEEDBACK_ROUTE_SLA_WORKING_DAYS[row.severity]);
}

/** Opens the item's case, or re-opens it on a re-triage, inside the caller's transaction. */
export async function openCaseIn(
  tx: Tx,
  row: Row,
  route: FeedbackTriageRoute,
  actor: FeedbackActor,
): Promise<CaseRow> {
  const now = new Date();
  const values = {
    route,
    owner: caseOwnerOf(route),
    openedBy: actor.userId,
    openedAgency: actor.agency,
    openedAt: now,
    dueAt: caseDueAt(row, now),
    routedAt: null,
    routedBy: null,
  };
  const [opened] = await tx
    .insert(feedbackCases)
    .values({ projectId: row.projectId, feedbackId: row.id, ...values })
    .onConflictDoUpdate({ target: feedbackCases.feedbackId, set: values })
    .returning();
  if (!opened) throw new Error('feedback_cases: the open returned no row');
  return opened;
}

export async function markRoutedIn(tx: Tx, caseId: string, actor: FeedbackActor): Promise<void> {
  await tx
    .update(feedbackCases)
    .set({ routedAt: new Date(), routedBy: actor.userId })
    .where(eq(feedbackCases.id, caseId));
}

export async function caseIn(tx: Tx, feedbackId: string): Promise<CaseRow | null> {
  const [row] = await tx
    .select()
    .from(feedbackCases)
    .where(eq(feedbackCases.feedbackId, feedbackId));
  return row ?? null;
}

export async function casesOf(feedbackIds: readonly string[]): Promise<Map<string, CaseRow>> {
  if (feedbackIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(feedbackCases)
    .where(inArray(feedbackCases.feedbackId, [...feedbackIds]));
  return new Map(rows.map((r) => [r.feedbackId, r]));
}

export function caseView(c: CaseRow, now: Date = new Date()): FeedbackCaseView {
  return {
    route: c.route,
    owner: c.owner,
    openedAt: c.openedAt.toISOString(),
    dueAt: c.dueAt.toISOString(),
    routedAt: c.routedAt?.toISOString() ?? null,
    overdue: c.routedAt === null && now.getTime() > c.dueAt.getTime(),
  };
}
