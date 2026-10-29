/**
 * What triage told an item's reporter (REQ-47 BC-10): the answer, the decline's reason, the latest
 * clarification asked of them and the release the fix shipped in. A reporter reads it wherever they
 * read the item, so every door builds it here, from the same parts the project's own read shows: the
 * answer off `list-read.ts:routeView`, the clarification through `clarificationViewOf`, the release off
 * `ship-notice.ts:shipNoticesOf`, the decline off the item's decisions.
 */

import type { FeedbackSummary, FeedbackView } from '@forge/contracts/feedback';
import type { FeedbackToldView } from '@forge/contracts/forge-feedback';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedbackDecisions } from '../db/schema-feedback.js';
import { agentQuestions, isChoiceStep } from '../db/schema-questions.js';
import { shipNoticesOf } from './ship-notice.js';

type Asked = Pick<typeof agentQuestions.$inferSelect, 'id' | 'status' | 'steps'>;

/** The item's latest clarification: its status, and its prompt and answer where the viewer may read them. */
export function clarificationViewOf(
  q: Asked | undefined,
  withhold: boolean,
): FeedbackView['clarification'] {
  if (!q) return null;
  const step = q.steps.at(-1);
  return {
    id: q.id,
    status: q.status,
    prompt: withhold ? null : (step?.prompt ?? null),
    recommended: withhold || !step || isChoiceStep(step) ? null : step.recommended?.trim() || null,
    answer: withhold ? null : step && 'answerText' in step ? (step.answerText ?? null) : null,
  };
}

/** The latest clarification asked of each item's reporter, by item. */
async function clarificationsOf(ids: readonly string[]): Promise<Map<string, Asked>> {
  const rows = await db
    .select({
      id: agentQuestions.id,
      status: agentQuestions.status,
      steps: agentQuestions.steps,
      feedbackId: agentQuestions.feedbackId,
    })
    .from(agentQuestions)
    .where(inArray(agentQuestions.feedbackId, [...ids]))
    .orderBy(desc(agentQuestions.createdAt));
  const out = new Map<string, Asked>();
  for (const r of rows) if (r.feedbackId && !out.has(r.feedbackId)) out.set(r.feedbackId, r);
  return out;
}

/** The reason of each item's latest decline, by item. */
async function declinesOf(ids: readonly string[]): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ feedbackId: feedbackDecisions.feedbackId, reason: feedbackDecisions.reason })
    .from(feedbackDecisions)
    .where(
      and(
        inArray(feedbackDecisions.feedbackId, [...ids]),
        eq(feedbackDecisions.decision, 'declined'),
      ),
    )
    .orderBy(asc(feedbackDecisions.decidedAt));
  return new Map(rows.map((r) => [r.feedbackId, r.reason]));
}

/**
 * What triage told the reporter of each of `items`, by item id; withheld where the project's data
 * policy withholds the item's words from this reader, as its own read withholds them.
 */
export async function toldOf(
  projectId: string,
  items: readonly FeedbackSummary[],
  withhold: boolean,
): Promise<Map<string, FeedbackToldView>> {
  if (items.length === 0) return new Map();
  const ids = items.map((s) => s.id);
  const [clarifications, declines, notices] = await Promise.all([
    clarificationsOf(ids),
    declinesOf(ids),
    shipNoticesOf(
      projectId,
      items.map((s) => ({
        id: s.id,
        route: s.route?.route ?? null,
        phase: s.phase,
        reporterAgency: s.reporter.agency,
      })),
    ),
  ]);
  return new Map(
    items.map((s) => {
      const asked = clarificationViewOf(clarifications.get(s.id), withhold);
      const told: FeedbackToldView = {
        answer: s.route?.answer ?? null,
        // a decline is what it says only while the item stands declined; a reopen took it back
        declined: s.phase === 'declined' && !withhold ? (declines.get(s.id) ?? null) : null,
        clarification: asked
          ? { prompt: asked.prompt, recommended: asked.recommended, status: asked.status }
          : null,
        shippedIn: notices.get(s.id)?.shipped.release ?? null,
      };
      return [s.id, told];
    }),
  );
}
