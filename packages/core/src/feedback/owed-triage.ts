/**
 * Which feedback items owe their project master a triage (workflow feedback-triage: intake wakes the
 * master for every filed item, and the master proposes a feedback_triage suggestion or routes it).
 * Severity orders the list and admits nothing: a low item left out of it is one nobody is woken for
 * (ISS-253). The box carrying the master reads it on every sweep, so a filed item is master work
 * whether or not its feedback.filed wake was heard. An item with a clarification open waits
 * on the reporter, not the master, and the reporter's answer wakes the master and owes it again.
 * One carrying a proposed feedback_triage suggestion waits on whoever accepts or rejects it, by the
 * one rule (`@forge/contracts/who-owes:whoOwes`, `feedback.triage`, ISS-1132): where the project's
 * policy gives triage to the master, the suggestion is the master's own work item and stays on this
 * list naming it; where the policy keeps triage a person's, it waits on them, and a rejection owes
 * it again. An item triaged once whose carrier is gone (no route, its issues all dropped, its
 * requirement dropped, its revision suggestion settled without being taken) owes a triage again and is
 * listed beside them (ISS-1086: agenfold FB-108, 51 and 31 were never named): its standing waits on
 * the same triager a fresh item's does (`standing.ts`, `feedback.rule.carrierGone`).
 */

import { FEEDBACK_SEVERITIES, type FeedbackSeverity, feedbackKey } from '@forge/contracts/feedback';
import { whoOwes } from '@forge/contracts/who-owes';
import { and, asc, eq, inArray, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { suggestions } from '../db/schema-suggestions.js';
import { readOwedPolicy } from '../project-config/index.js';

export interface OwedTriage {
  feedbackId: string;
  key: string;
  title: string;
  severity: FeedbackSeverity;
  /** `triaged` for one whose carrier is gone, which owes a triage again. */
  status: 'new' | 'reopened' | 'triaged';
  /** The feedback_triage suggestion proposed on it, where one is: the master accepts or rejects it. */
  proposed: string | null;
}

/** A triaged item that carries nothing any more, as `standing.ts:phaseOf` reads it back to triaged. */
const carrierGoneSql = sql`(${feedback.status} = 'triaged' AND (
  ${feedback.route} IS NULL
  OR (${feedback.route} = 'issue' AND NOT EXISTS (
        SELECT 1 FROM feedback_route_issues ri JOIN issues i ON i.id = ri.issue_id
         WHERE ri.feedback_id = ${feedback.id} AND i.status <> 'dropped'))
  OR (${feedback.route} = 'new_requirement' AND EXISTS (
        SELECT 1 FROM requirements q WHERE q.id = ${feedback.routedRequirementId} AND q.status = 'dropped'))
  OR (${feedback.route} = 'revision' AND NOT EXISTS (
        SELECT 1 FROM suggestions s WHERE s.id = ${feedback.routedSuggestionId}
           AND s.status IN ('proposed', 'accepted')))))`;

export async function owedTriages(projectId: string, exec: Tx = db): Promise<OwedTriage[]> {
  const masterTriages = whoOwes('feedback.triage', await readOwedPolicy(projectId)).by === 'master';
  const rows = await exec
    .select({
      id: feedback.id,
      fbSeq: feedback.fbSeq,
      title: feedback.title,
      severity: feedback.severity,
      status: feedback.status,
    })
    .from(feedback)
    .where(
      and(
        eq(feedback.projectId, projectId),
        or(inArray(feedback.status, ['new', 'reopened']), carrierGoneSql),
        // a snoozed item is owed to nobody until its date; the read returns it, no timer does
        or(isNull(feedback.snoozedUntil), lte(feedback.snoozedUntil, new Date())),
        notExists(
          exec
            .select({ id: agentQuestions.id })
            .from(agentQuestions)
            .where(
              and(eq(agentQuestions.feedbackId, feedback.id), eq(agentQuestions.status, 'open')),
            ),
        ),
        masterTriages
          ? undefined
          : notExists(
              exec
                .select({ id: suggestions.id })
                .from(suggestions)
                .where(
                  and(
                    eq(suggestions.feedbackId, feedback.id),
                    eq(suggestions.kind, 'feedback_triage'),
                    eq(suggestions.status, 'proposed'),
                  ),
                ),
            ),
      ),
    )
    .orderBy(asc(feedback.fbSeq));
  const proposed =
    masterTriages && rows.length > 0
      ? await exec
          .select({ id: suggestions.id, feedbackId: suggestions.feedbackId })
          .from(suggestions)
          .where(
            and(
              inArray(
                suggestions.feedbackId,
                rows.map((r) => r.id),
              ),
              eq(suggestions.kind, 'feedback_triage'),
              eq(suggestions.status, 'proposed'),
            ),
          )
          .orderBy(asc(suggestions.createdAt))
      : [];
  const proposalOf = new Map<string, string>();
  for (const p of proposed) {
    if (p.feedbackId && !proposalOf.has(p.feedbackId)) proposalOf.set(p.feedbackId, p.id);
  }
  return bySeverity(rows).map((r) => ({
    feedbackId: r.id,
    key: feedbackKey(r.fbSeq),
    title: r.title,
    severity: r.severity,
    status: r.status as OwedTriage['status'],
    proposed: proposalOf.get(r.id) ?? null,
  }));
}

/** Most severe first, and in filing order within one severity: the sort is stable. */
export function bySeverity<T extends { severity: FeedbackSeverity }>(rows: readonly T[]): T[] {
  const rank = (s: FeedbackSeverity) => FEEDBACK_SEVERITIES.indexOf(s);
  return [...rows].sort((a, b) => rank(b.severity) - rank(a.severity));
}
