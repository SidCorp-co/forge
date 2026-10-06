/**
 * Which feedback items owe their project master a triage (workflow feedback-triage: intake wakes the
 * master for high or critical, and the master proposes a feedback_triage suggestion or routes it).
 * The box carrying the master reads it on every sweep, so a filed item is master work whether or not
 * its feedback.filed wake was heard. An item whose one clarification is open waits on the reporter,
 * not the master, and the reporter's answer wakes the master and owes it again; one carrying a
 * proposed feedback_triage suggestion waits on whoever accepts or rejects it, and a rejection owes it
 * again.
 */

import { type FeedbackSeverity, feedbackKey } from '@forge/contracts/feedback';
import { and, asc, eq, inArray, notExists } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { suggestions } from '../db/schema-suggestions.js';

/** The severities a master is woken for and owes a triage at; lower ones wait for a member. */
export const MASTER_OWED_SEVERITIES: readonly FeedbackSeverity[] = ['high', 'critical'];

export interface OwedTriage {
  feedbackId: string;
  key: string;
  title: string;
  severity: FeedbackSeverity;
  status: 'new' | 'reopened';
}

export async function owedTriages(projectId: string, exec: Tx = db): Promise<OwedTriage[]> {
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
        inArray(feedback.status, ['new', 'reopened']),
        inArray(feedback.severity, [...MASTER_OWED_SEVERITIES]),
        notExists(
          exec
            .select({ id: agentQuestions.id })
            .from(agentQuestions)
            .where(
              and(eq(agentQuestions.feedbackId, feedback.id), eq(agentQuestions.status, 'open')),
            ),
        ),
        notExists(
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
  return rows.map((r) => ({
    feedbackId: r.id,
    key: feedbackKey(r.fbSeq),
    title: r.title,
    severity: r.severity,
    status: r.status as OwedTriage['status'],
  }));
}
