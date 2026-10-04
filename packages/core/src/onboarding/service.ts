/**
 * Onboarding (workflow project-onboarding rev 1): a conversation in the chat panel, one per project,
 * held by an `onboardings` row. A person starts it or asks for a re-analysis; each runs one
 * analysis job (`job.ts`). The agent posts updates and questionnaire batches into the thread
 * (`agent-writes.ts`); a person answers a batch once, which hands the thread back to the agent
 * with a revise job.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { addPerson, openConversationIn, settleShape } from '../conversations/index.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { conversationParticipants } from '../db/schema-conversations.js';
import { onboardings } from '../db/schema-onboarding.js';
import type { EgressReader } from '../lib/data-egress.js';
import { peopleOf } from '../lib/people.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  announce,
  batchesOfConversation,
  inTx,
  questionnairesAs,
  supersedeOpenIn,
} from '../questionnaires/index.js';
import {
  lockOnboarding,
  type OnboardingActor,
  type OnboardingOutcome,
  refusalFor,
  settled,
  systemLine,
} from './act.js';
import { enqueueJob } from './job.js';
import { liveJobOf, onboardingOf, onboardingView } from './read.js';
import { notStarted, personActRefusal, reanalyzeRefusal, startRefusal } from './rules.js';

async function nameOf(userId: string) {
  return (await peopleOf([userId])).get(userId)?.name ?? 'Someone';
}

// cm:why onboarding is offered, never required (BC-1): start only opens the thread and queues the
// one analysis job; a project that never starts it works unchanged
export async function startOnboarding(input: {
  projectId: string;
  actor: OnboardingActor;
}): Promise<OnboardingOutcome> {
  const { projectId, actor } = input;
  const who = await refusalFor(actor, projectId, (f) => personActRefusal(f, 'starting onboarding'));
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
  const who = await refusalFor(actor, projectId, (f) =>
    personActRefusal(f, 'asking for a re-analysis'),
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
  await requireCan(actorFor(input.actor.userId), 'project.write', projectResource(input.projectId));
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

export async function readAnswers(projectId: string, actor: OnboardingActor & EgressReader) {
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const row = await onboardingOf(db, projectId);
  if (!row) return { ok: false as const, refusals: [notStarted()] };
  const questionnaires = await batchesOfConversation(row.conversationId);
  const out = await questionnairesAs(actor, projectId, questionnaires);
  if (!out.ok) return { ok: false as const, refusals: [out.refusal] };
  return {
    ok: true as const,
    onboarding: await onboardingView(db, row),
    questionnaires: out.value,
  };
}
