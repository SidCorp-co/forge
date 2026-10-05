/**
 * The agent's writes into an onboarding thread: questionnaire batches, updates that name designs,
 * and the close. Each runs in one transaction under the project's onboarding lock, refusals named
 * and nothing written.
 */

import type {
  PostQuestionnaireRequest,
  PostUpdateRequest,
  QuestionnaireView,
} from '@forge/contracts/onboarding';
import { and, eq, inArray } from 'drizzle-orm';
import { appendMessagesIn, type TxOnly } from '../conversations/index.js';
import { db } from '../db/client.js';
import { onboardings } from '../db/schema-onboarding.js';
import { suggestions } from '../db/schema-suggestions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import type { Refusal } from '../lib/refusal.js';
import {
  announce,
  type BatchRow,
  batchView,
  inTx,
  posterRefusal,
  postQuestionnaireIn,
  roundsRefusal,
} from '../questionnaires/index.js';
import { recordItemLandings } from '../questions/index.js';
import {
  lockOnboarding,
  type OnboardingActor,
  type OnboardingOutcome,
  refusalFor,
  settled,
} from './act.js';
import { citeRefusals, landingsOf } from './design-items.js';
import { settlePhaseJob } from './job.js';
import { designsOf, onboardingOf, projectHoldsSensitiveData, seriesItemsOf } from './read.js';
import {
  agentWriteRefusal,
  closeRefusal,
  dataFlowRefusal,
  designUnknownRefusals,
  doneRefusal,
  notStarted,
} from './rules.js';

type OnboardingQuestionnaireOutcome =
  | { ok: true; questionnaire: QuestionnaireView; created: true }
  | { ok: false; refusals: Refusal[] };

export async function postOnboardingQuestionnaire(input: {
  projectId: string;
  actor: OnboardingActor;
  body: PostQuestionnaireRequest;
}): Promise<OnboardingQuestionnaireOutcome> {
  const { projectId, actor, body } = input;
  const who = await refusalFor(actor, projectId, posterRefusal);
  if (who) return { ok: false, refusals: [who] };
  let batchId = '';
  let conversationId = '';
  let messageId: string | null = null;
  let jobId: string | null = null;
  const refused = await inTx(async (tx) => {
    await lockOnboarding(tx, projectId);
    const row = await onboardingOf(tx, projectId, true);
    if (!row) return [notStarted()];
    const blocked = doneRefusal(row) ?? roundsRefusal(row.roundsSent);
    if (blocked) return [blocked];
    conversationId = row.conversationId;
    jobId = row.lastJobId;
    const posted = await postQuestionnaireIn(tx, {
      projectId,
      conversationId: row.conversationId,
      onboardingId: row.id,
      requirementId: null,
      round: row.roundsSent + 1,
      seriesSince: row.reanalyzedAt ?? row.startedAt,
      actor,
      authorLabel: 'Agent',
      title: body.title,
      intro: body.intro,
      items: body.items,
    });
    if (Array.isArray(posted)) return posted;
    batchId = posted.batchId;
    messageId = posted.messageId;
    await tx
      .update(onboardings)
      .set({ roundsSent: row.roundsSent + 1, updatedAt: new Date() })
      .where(eq(onboardings.id, row.id));
    return null;
  });
  if (refused) return { ok: false, refusals: refused };
  await announce(conversationId, messageId, 'assistant');
  await settlePhaseJob(actor.agency, jobId);
  return { ok: true, questionnaire: await batchView(db, projectId, batchId), created: true };
}

// cm:why an update names its designs and registers them with the onboarding, so their status is read
// live by the thread and the dashboard, and so they take only a person's approval
export async function postOnboardingUpdate(input: {
  projectId: string;
  actor: OnboardingActor;
  body: PostUpdateRequest;
}): Promise<OnboardingOutcome> {
  const { projectId, actor, body } = input;
  const who = await refusalFor(actor, projectId, agentWriteRefusal);
  if (who) return { ok: false, refusals: [who] };
  let conversationId = '';
  let messageId: string | null = null;
  const refused = await inTx(async (tx) => {
    await lockOnboarding(tx, projectId);
    const row = await onboardingOf(tx, projectId, true);
    if (!row) return [notStarted()];
    const done = doneRefusal(row);
    if (done) return [done];
    conversationId = row.conversationId;
    const ids = body.designs?.workflowIds ?? [];
    if (ids.length) {
      const found = await tx
        .select({ id: projectWorkflows.id })
        .from(projectWorkflows)
        .where(and(eq(projectWorkflows.projectId, projectId), inArray(projectWorkflows.id, ids)));
      const have = new Set(found.map((f) => f.id));
      const missing = designUnknownRefusals(ids.filter((id) => !have.has(id)));
      if (missing.length) return missing;
    }
    const cites = body.cites ?? [];
    if (cites.length) {
      const series = await seriesItemsOf(tx, row);
      const named = cites.flatMap((c) => ('suggestionId' in c ? [c.suggestionId] : []));
      const found = named.length
        ? await tx
            .select({ id: suggestions.id })
            .from(suggestions)
            .where(and(eq(suggestions.projectId, projectId), inArray(suggestions.id, named)))
        : [];
      const refusals = citeRefusals(
        cites,
        series,
        await designsOf(tx, projectId, [...new Set([...row.designs, ...ids])]),
        new Set(found.map((f) => f.id)),
      );
      if (refusals.length) return refusals;
      await recordItemLandings(tx, landingsOf(cites, series, actor.userId, new Date()));
    }
    const [message] = await appendMessagesIn(tx, {
      conversationId: row.conversationId,
      messages: [
        {
          role: 'assistant',
          authorUserId: actor.userId,
          authorLabel: 'Agent',
          content: body.designs
            ? `${body.text}\n\n${body.designs.heading}: ${ids.join(', ')}`
            : body.text,
          blocks: [
            { type: 'text', text: body.text },
            ...(body.designs ? [{ type: 'designs' as const, designs: body.designs }] : []),
          ],
        },
      ],
    });
    messageId = message?.id ?? null;
    await tx
      .update(onboardings)
      .set({ designs: [...new Set([...row.designs, ...ids])], updatedAt: new Date() })
      .where(eq(onboardings.id, row.id));
    return null;
  });
  if (refused) return { ok: false, refusals: refused };
  await announce(conversationId, messageId, 'assistant');
  return settled(projectId);
}

export async function markOnboardingDone(input: {
  projectId: string;
  actor: OnboardingActor;
  text?: string | undefined;
}): Promise<OnboardingOutcome> {
  const { projectId, actor } = input;
  const who = await refusalFor(actor, projectId, closeRefusal);
  if (who) return { ok: false, refusals: [who] };
  const sensitive = await projectHoldsSensitiveData(projectId);
  let conversationId = '';
  let jobId: string | null = null;
  const refused = await inTx(async (tx) => {
    await lockOnboarding(tx, projectId);
    const row = await onboardingOf(tx, projectId, true);
    if (!row) return [notStarted()];
    const done = doneRefusal(row);
    if (done) return [done];
    conversationId = row.conversationId;
    jobId = row.lastJobId;
    const designs = await designsOf(tx, projectId, row.designs);
    const flow = dataFlowRefusal(
      sensitive,
      designs.map((d) => d.template),
    );
    if (flow) return [flow];
    await tx
      .update(onboardings)
      .set({
        doneBy: actor.userId,
        doneAgency: actor.agency,
        doneAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(onboardings.id, row.id));
    if (input.text) {
      await appendMessagesIn(tx, {
        conversationId: row.conversationId,
        messages: [
          {
            role: actor.agency === 'agent' ? 'assistant' : 'system',
            authorUserId: actor.userId,
            authorLabel: actor.agency === 'agent' ? 'Agent' : null,
            content: input.text,
          },
        ],
      });
    }
    return null;
  });
  if (refused) return { ok: false, refusals: refused };
  await announce(conversationId, null, 'assistant');
  await settlePhaseJob(actor.agency, jobId);
  return settled(projectId);
}

/** Written in the submit's transaction; the batch's own status says whose turn the thread is. */
export async function onboardingSubmittedIn(tx: TxOnly, batch: BatchRow) {
  if (!batch.onboardingId) return;
  await tx
    .update(onboardings)
    .set({ updatedAt: new Date() })
    .where(eq(onboardings.id, batch.onboardingId));
}
