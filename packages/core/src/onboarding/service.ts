/**
 * Onboarding (workflow project-onboarding rev 1): a conversation in the chat panel, one per project,
 * held by an `onboardings` row. A person starts it or asks for a re-analysis; each runs one
 * analysis job (type `onboarding`, the method in its prompt). The agent posts updates and
 * questionnaire batches into the thread; a person answers a batch once, which hands the thread
 * back to the agent with a revise job. Each write runs in one transaction under the project's
 * onboarding lock and answers an outcome, refusals named and nothing written.
 */

import { randomUUID } from 'node:crypto';
import type {
  OnboardingJobPhase,
  OnboardingView,
  PostQuestionnaireRequest,
  PostUpdateRequest,
  QuestionnaireView,
} from '@forge/contracts/onboarding';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { TxOnly } from '../conversations/db-executor.js';
import { settleShape } from '../conversations/membership.js';
import { addPerson } from '../conversations/participants.js';
import { appendMessagesIn, openConversationIn } from '../conversations/store.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { conversationParticipants } from '../db/schema-conversations.js';
import { onboardings } from '../db/schema-onboarding.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { assertProjectAccess, effectiveProjectRole } from '../lib/authz.js';
import { dataPolicyOf, egressDeep } from '../lib/data-egress.js';
import { insertAndEnqueueJob } from '../pipeline/enqueue-helper.js';
import { openOneShotRun } from '../pipeline/runs.js';
import type { NamedRefusal } from '../project-config/respond.js';
import { type BatchRow, batchesOfConversation, batchView } from '../questionnaires/read.js';
import { posterRefusal, roundsRefusal } from '../questionnaires/rules.js';
import { announce, inTx, postQuestionnaireIn, supersedeOpenIn } from '../questionnaires/service.js';
import { userNames } from '../workflows/service.js';
import { analysePrompt, type OnboardingPromptContext, revisePrompt } from './prompt.js';
import {
  designsOf,
  liveJobOf,
  type OnboardingRow,
  onboardingOf,
  onboardingView,
  projectHasRepository,
  projectHoldsSensitiveData,
} from './read.js';
import {
  agentWriteRefusal,
  closeRefusal,
  dataFlowRefusal,
  designUnknownRefusals,
  doneRefusal,
  notStarted,
  personActRefusal,
  reanalyzeRefusal,
  startRefusal,
} from './rules.js';

export interface OnboardingActor {
  userId: string;
  agency: ActorAgency;
}

export type OnboardingOutcome =
  | { ok: true; onboarding: OnboardingView; created?: boolean }
  | { ok: false; refusals: NamedRefusal[] };

export type OnboardingQuestionnaireOutcome =
  | { ok: true; questionnaire: QuestionnaireView; created: true }
  | { ok: false; refusals: NamedRefusal[] };

/** Serialises every onboarding write on one project. */
async function lockOnboarding(tx: TxOnly, projectId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`onboarding:${projectId}`}, 0))`,
  );
}

async function factsOf(actor: OnboardingActor, projectId: string) {
  const access = await effectiveProjectRole(actor.userId, projectId);
  return { ...actor, role: access?.role ?? null };
}

async function nameOf(userId: string) {
  return (await userNames([userId])).get(userId) ?? 'Someone';
}

async function settled(
  projectId: string,
  extra: { created?: boolean } = {},
): Promise<OnboardingOutcome> {
  const row = await onboardingOf(db, projectId);
  if (!row) throw new Error(`onboarding: project ${projectId} lost its onboarding after a write`);
  return { ok: true, onboarding: await onboardingView(db, row), ...extra };
}

async function systemLine(tx: TxOnly, conversationId: string, content: string) {
  const [m] = await appendMessagesIn(tx, {
    conversationId,
    messages: [{ role: 'system', content, authorLabel: 'Forge' }],
  });
  return m?.id ?? null;
}

/** The one job of an onboarding phase: an issue-less one-shot run whose prompt is the method. */
async function enqueueJob(
  row: OnboardingRow,
  phase: OnboardingJobPhase,
  createdBy: string,
  extra: { batchId?: string; reason?: string | null } = {},
): Promise<string> {
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, row.projectId));
  const ctx: OnboardingPromptContext = {
    projectId: row.projectId,
    projectName: project?.name ?? row.projectId,
    onboardingId: row.id,
    conversationId: row.conversationId,
    sensitiveData: await projectHoldsSensitiveData(row.projectId),
    hasRepository: await projectHasRepository(row.projectId),
    roundsSent: row.roundsSent,
    reason: extra.reason ?? null,
  };
  const run = await openOneShotRun({
    projectId: row.projectId,
    kind: 'system',
    metadata: { source: 'onboarding', onboardingId: row.id, phase },
  });
  const { jobId } = await insertAndEnqueueJob({
    projectId: row.projectId,
    issueId: null,
    pipelineRunId: run.id,
    createdBy,
    type: 'onboarding',
    skillName: `onboarding-${phase}`,
    promptString:
      phase === 'revise' && extra.batchId
        ? revisePrompt({ ...ctx, batchId: extra.batchId })
        : analysePrompt(ctx),
    payloadExtras: {
      onboardingId: row.id,
      onboardingPhase: phase,
      ...(extra.batchId ? { batchId: extra.batchId } : {}),
      timeoutSeconds: 3600,
    },
  });
  await db.update(onboardings).set({ lastJobId: jobId }).where(eq(onboardings.id, row.id));
  return jobId;
}

// cm:why onboarding is offered, never required (BC-1): start only opens the thread and queues the
// one analysis job; a project that never starts it works unchanged
export async function startOnboarding(input: {
  projectId: string;
  actor: OnboardingActor;
}): Promise<OnboardingOutcome> {
  const { projectId, actor } = input;
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const who = personActRefusal(await factsOf(actor, projectId), projectId, 'starting onboarding');
  if (who) return { ok: false, refusals: [who] };
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId));
  const starter = await nameOf(actor.userId);
  let conversationId = '';
  const refused = await inTx(async (tx) => {
    await lockOnboarding(tx, projectId);
    const existing = await onboardingOf(tx, projectId);
    const refusal = startRefusal(existing, await liveJobOf(tx, projectId));
    if (refusal) return [refusal];
    const handle = tx as unknown as typeof db;
    const room = await openConversationIn(handle, {
      adapter: 'web',
      externalId: randomUUID(),
      shape: 'direct',
      projectId,
      title: `Onboarding · ${project?.name ?? 'project'}`,
    });
    await addPerson({
      conversationId: room.id,
      userId: actor.userId,
      actorUserId: actor.userId,
      tx: handle,
    });
    await settleShape(handle, room.id);
    conversationId = room.id;
    await tx
      .insert(onboardings)
      .values({ projectId, conversationId: room.id, startedBy: actor.userId });
    await systemLine(
      tx,
      room.id,
      `${starter} started onboarding · one analysis job reads the code`,
    );
    return null;
  });
  if (refused) return { ok: false, refusals: refused };
  const row = await onboardingOf(db, projectId);
  if (row) await enqueueJob(row, 'analyse', actor.userId);
  await announce(conversationId, null, 'system');
  return settled(projectId, { created: true });
}

// cm:why a re-analysis supersedes every open batch (BC-9) and resets the rounds, and never touches
// an approved revision: the new drafts propose new revisions
export async function reanalyzeOnboarding(input: {
  projectId: string;
  actor: OnboardingActor;
  reason?: string | undefined;
}): Promise<OnboardingOutcome> {
  const { projectId, actor } = input;
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const who = personActRefusal(
    await factsOf(actor, projectId),
    projectId,
    'asking for a re-analysis',
  );
  if (who) return { ok: false, refusals: [who] };
  const asker = await nameOf(actor.userId);
  let conversationId = '';
  const refused = await inTx(async (tx) => {
    await lockOnboarding(tx, projectId);
    const row = await onboardingOf(tx, projectId, true);
    const refusal = reanalyzeRefusal(row, await liveJobOf(tx, projectId));
    if (refusal || !row) return [refusal ?? notStarted()];
    conversationId = row.conversationId;
    const superseded = await supersedeOpenIn(tx, row.id, 'superseded by re-analysis');
    await tx
      .update(onboardings)
      .set({
        status: 'in_progress',
        roundsSent: 0,
        reanalyzedBy: actor.userId,
        reanalyzedAt: new Date(),
        doneBy: null,
        doneAt: null,
        doneAgency: null,
        updatedAt: new Date(),
      })
      .where(eq(onboardings.id, row.id));
    await systemLine(
      tx,
      row.conversationId,
      `${asker} asked for a re-analysis${input.reason ? `: ${input.reason}` : ''}${superseded.length ? ` · ${superseded.length === 1 ? 'the open batch is' : `${superseded.length} open batches are`} superseded` : ''}`,
    );
    return null;
  });
  if (refused) return { ok: false, refusals: refused };
  const row = await onboardingOf(db, projectId);
  if (row) await enqueueJob(row, 'analyse', actor.userId, { reason: input.reason ?? null });
  await announce(conversationId, null, 'system');
  return settled(projectId);
}

/** A person of the project joins the onboarding thread, so a thread one person started is everyone's. */
export async function joinOnboarding(input: { projectId: string; actor: OnboardingActor }) {
  await assertProjectAccess(input.projectId, input.actor.userId, 'member');
  const row = await onboardingOf(db, input.projectId);
  if (!row) return { ok: false as const, refusals: [notStarted()] };
  await db.transaction(async (tx) => {
    const handle = tx as unknown as typeof db;
    const [present] = await tx
      .select({ id: conversationParticipants.id })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, row.conversationId),
          eq(conversationParticipants.userId, input.actor.userId),
          sql`${conversationParticipants.removedAt} IS NULL`,
        ),
      )
      .limit(1);
    if (present) return;
    await addPerson({
      conversationId: row.conversationId,
      userId: input.actor.userId,
      actorUserId: input.actor.userId,
      tx: handle,
    });
    await settleShape(handle, row.conversationId);
  });
  return settled(input.projectId);
}

export async function postOnboardingQuestionnaire(input: {
  projectId: string;
  actor: OnboardingActor;
  body: PostQuestionnaireRequest;
}): Promise<OnboardingQuestionnaireOutcome> {
  const { projectId, actor, body } = input;
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const who = posterRefusal(await factsOf(actor, projectId), projectId);
  if (who) return { ok: false, refusals: [who] };
  let batchId = '';
  let conversationId = '';
  let messageId: string | null = null;
  const refused = await inTx(async (tx) => {
    await lockOnboarding(tx, projectId);
    const row = await onboardingOf(tx, projectId, true);
    if (!row) return [notStarted()];
    const blocked = doneRefusal(row.status) ?? roundsRefusal(row.roundsSent);
    if (blocked) return [blocked];
    conversationId = row.conversationId;
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
      .set({ roundsSent: row.roundsSent + 1, status: 'waiting_on_you', updatedAt: new Date() })
      .where(eq(onboardings.id, row.id));
    return null;
  });
  if (refused) return { ok: false, refusals: refused };
  await announce(conversationId, messageId, 'assistant');
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
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const who = agentWriteRefusal(await factsOf(actor, projectId), projectId);
  if (who) return { ok: false, refusals: [who] };
  let conversationId = '';
  let messageId: string | null = null;
  const refused = await inTx(async (tx) => {
    await lockOnboarding(tx, projectId);
    const row = await onboardingOf(tx, projectId, true);
    if (!row) return [notStarted()];
    const done = doneRefusal(row.status);
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
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const who = closeRefusal(await factsOf(actor, projectId), projectId);
  if (who) return { ok: false, refusals: [who] };
  const sensitive = await projectHoldsSensitiveData(projectId);
  let conversationId = '';
  const refused = await inTx(async (tx) => {
    await lockOnboarding(tx, projectId);
    const row = await onboardingOf(tx, projectId, true);
    if (!row) return [notStarted()];
    const done = doneRefusal(row.status);
    if (done) return [done];
    conversationId = row.conversationId;
    const designs = await designsOf(tx, projectId, row.designs);
    const flow = dataFlowRefusal(
      sensitive,
      designs.map((d) => d.template),
    );
    if (flow) return [flow];
    await tx
      .update(onboardings)
      .set({
        status: 'done',
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
  return settled(projectId);
}

/** Written in the submit's transaction: the thread goes back to the agent, or waits after a skip. */
export async function onboardingSubmittedIn(tx: TxOnly, batch: BatchRow, skipped: boolean) {
  if (!batch.onboardingId) return;
  await tx
    .update(onboardings)
    .set({ status: skipped ? 'waiting_on_you' : 'in_progress', updatedAt: new Date() })
    .where(eq(onboardings.id, batch.onboardingId));
}

/** After a submit commits: one revise job reads the answers, unless an onboarding job already runs. */
export async function afterOnboardingSubmit(batch: BatchRow, submittedBy: string) {
  if (!batch.onboardingId) return;
  const row = await onboardingOf(db, batch.projectId);
  if (!row || (await liveJobOf(db, batch.projectId))) return;
  await enqueueJob(row, 'revise', submittedBy, { batchId: batch.id });
}

export async function readAnswers(projectId: string, actor: OnboardingActor) {
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const row = await onboardingOf(db, projectId);
  if (!row) return { ok: false as const, refusals: [notStarted()] };
  const questionnaires = await batchesOfConversation(row.conversationId);
  // cm:guard a person's answers reach a model only as the project's data policy allows: an agent
  // reader is provider-bound, so it reads them scrubbed at redact and is refused at no_egress
  const out =
    actor.agency === 'agent'
      ? egressDeep(await dataPolicyOf(projectId), questionnaires, 'the onboarding answers')
      : { ok: true as const, value: questionnaires };
  if (!out.ok) return { ok: false as const, refusals: [out.refusal] };
  return { ok: true as const, onboarding: await onboardingView(db, row), questionnaires: out.value };
}
