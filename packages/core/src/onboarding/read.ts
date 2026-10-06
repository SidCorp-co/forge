/**
 * The reads of onboarding: the project's onboarding as every surface sees it, with its designs'
 * live status, its open batch and its job, and the dashboard's one-line hint derived from them.
 */

import { LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import {
  ONBOARDING_JOB_PHASES,
  type OnboardingDesignView,
  type OnboardingJobPhase,
  type OnboardingStateResponse,
  type OnboardingStatus,
  type OnboardingThreadRequest,
  type OnboardingView,
  type OpenQuestionnaireBatch,
  QUESTIONNAIRE_MAX_ROUNDS,
  type QuestionnaireItem,
} from '@forge/contracts/onboarding';
import { and, count, desc, eq, gte, inArray, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { conversationMessages } from '../db/schema-conversations.js';
import { onboardings, questionnaireBatches } from '../db/schema-onboarding.js';
import { agentQuestions } from '../db/schema-questions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { peopleOf } from '../lib/people.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { linkItems, type SeriesItem } from './design-items.js';
import { batchDue, hintOf, type SystemContextState } from './hint.js';
import { runWaitingOf } from './ports.js';
import type { LiveJob } from './rules.js';

type Executor = typeof db | Tx;
export type OnboardingRow = typeof onboardings.$inferSelect;

export async function onboardingOf(
  tx: Executor,
  projectId: string,
  lock = false,
): Promise<OnboardingRow | null> {
  const query = tx.select().from(onboardings).where(eq(onboardings.projectId, projectId));
  const [row] = lock ? await query.for('update') : await query;
  return row ?? null;
}

// The status is read, never stored: done once a person closed it (until a re-analysis clears the
// close), waiting on a person while one of its batches is open or skipped, else with the agent
const onboardingStatusOf = (
  row: Pick<OnboardingRow, 'doneAt'>,
  answerable: boolean,
): OnboardingStatus => (row.doneAt ? 'done' : answerable ? 'waiting_on_you' : 'in_progress');

const ANSWERABLE = ['open', 'skipped'] as const;

/** The status of each onboarding whose thread is in `conversationIds`, keyed by conversation. */
export async function onboardingStatusesOf(
  conversationIds: readonly string[],
): Promise<Map<string, OnboardingStatus>> {
  if (conversationIds.length === 0) return new Map();
  const [rows, answerable] = await Promise.all([
    db
      .select({
        id: onboardings.id,
        conversationId: onboardings.conversationId,
        doneAt: onboardings.doneAt,
      })
      .from(onboardings)
      .where(inArray(onboardings.conversationId, [...conversationIds])),
    db
      .selectDistinct({ onboardingId: questionnaireBatches.onboardingId })
      .from(questionnaireBatches)
      .where(
        and(
          inArray(questionnaireBatches.conversationId, [...conversationIds]),
          inArray(questionnaireBatches.status, [...ANSWERABLE]),
        ),
      ),
  ]);
  const waiting = new Set(answerable.map((a) => a.onboardingId));
  return new Map(rows.map((r) => [r.conversationId, onboardingStatusOf(r, waiting.has(r.id))]));
}

/** The onboarding job not yet over for this project, if any: one runs at a time. */
export async function liveJobOf(tx: Executor, projectId: string): Promise<LiveJob | null> {
  const [row] = await tx
    .select({
      id: jobs.id,
      status: jobs.status,
      queuedAt: jobs.queuedAt,
      dispatchedAt: jobs.dispatchedAt,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        eq(jobs.type, 'onboarding'),
        inArray(jobs.status, [...LIVE_JOB_STATUSES]),
      ),
    )
    .orderBy(desc(jobs.queuedAt))
    .limit(1);
  return row ?? null;
}

/** How many of a thread's person messages the job reads: the newest, the cap a room's window keeps. */
const THREAD_REQUESTS_CAP = 50;

/**
 * What the people of the project wrote in the onboarding thread, oldest first: the instructions the
 * job that drafts the designs reads, since the room has no other agent to read them.
 */
export async function threadRequestsOf(conversationId: string): Promise<OnboardingThreadRequest[]> {
  const rows = await db
    .select({
      at: conversationMessages.createdAt,
      authorUserId: conversationMessages.authorUserId,
      authorLabel: conversationMessages.authorLabel,
      text: conversationMessages.content,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.role, 'user'),
      ),
    )
    .orderBy(desc(conversationMessages.seq))
    .limit(THREAD_REQUESTS_CAP);
  const ids = rows.map((r) => r.authorUserId).filter((id): id is string => id !== null);
  const names = await peopleOf(ids);
  return rows.reverse().map((r) => ({
    at: r.at.toISOString(),
    author: (r.authorUserId ? names.get(r.authorUserId)?.name : null) ?? r.authorLabel ?? null,
    text: r.text,
  }));
}

/** The onboarding a conversation is the thread of, and whether a job of it runs now; null for any other room. */
export async function onboardingRoomOf(
  conversationId: string,
): Promise<{ projectId: string; live: boolean } | null> {
  const [row] = await db
    .select({ projectId: onboardings.projectId })
    .from(onboardings)
    .where(eq(onboardings.conversationId, conversationId))
    .limit(1);
  if (!row) return null;
  return { projectId: row.projectId, live: (await liveJobOf(db, row.projectId)) !== null };
}

/** Whether the project's data policy (ISS-59) is above `off`: its onboarding then owes a data-flow design. */
export async function projectHoldsSensitiveData(projectId: string): Promise<boolean> {
  return (await dataPolicyOf(projectId)) !== 'off';
}

export async function designsOf(tx: Executor, projectId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      id: projectWorkflows.id,
      flow: projectWorkflows.flow,
      document: projectWorkflows.document,
      designStatus: projectWorkflows.designStatus,
      revision: projectWorkflows.revision,
      approvedRevision: projectWorkflows.approvedRevision,
    })
    .from(projectWorkflows)
    .where(and(eq(projectWorkflows.projectId, projectId), inArray(projectWorkflows.id, [...ids])));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const doc = (r.document ?? {}) as { title?: string; template?: { id?: string } };
    return [
      {
        workflowId: r.id,
        flow: r.flow,
        title: doc.title ?? r.flow,
        template: doc.template?.id ?? null,
        designStatus: r.designStatus,
        revision: r.revision,
        approvedRevision: r.approvedRevision,
      },
    ];
  });
}

/**
 * The questionnaire items of the onboarding's current series (since its start or last
 * re-analysis), with the round they were asked in, their state and where they landed.
 */
export async function seriesItemsOf(
  tx: Executor,
  row: Pick<OnboardingRow, 'id' | 'startedAt' | 'reanalyzedAt'>,
): Promise<SeriesItem[]> {
  const rows = await tx
    .select({
      questionId: agentQuestions.id,
      status: agentQuestions.status,
      item: agentQuestions.item,
      steps: agentQuestions.steps,
      landedIn: agentQuestions.landedIn,
      round: questionnaireBatches.round,
      createdAt: questionnaireBatches.createdAt,
    })
    .from(agentQuestions)
    .innerJoin(questionnaireBatches, eq(questionnaireBatches.id, agentQuestions.batchId))
    .where(
      and(
        eq(questionnaireBatches.onboardingId, row.id),
        gte(questionnaireBatches.createdAt, row.reanalyzedAt ?? row.startedAt),
      ),
    );
  return rows.flatMap((r) => {
    if (!r.item) return [];
    const chosen = (r.steps.at(-1) as { chosenOptionId?: string } | undefined)?.chosenOptionId;
    const item = r.item as QuestionnaireItem;
    return [
      {
        questionId: r.questionId,
        round: r.round,
        createdAt: r.createdAt,
        state: r.status === 'open' ? 'open' : r.status === 'answered' ? 'answered' : 'void',
        decision:
          item.control === 'accept_reject' && r.status === 'answered'
            ? chosen === 'accept'
              ? 'accept'
              : 'reject'
            : null,
        item,
        landedIn: r.landedIn ?? null,
      } satisfies SeriesItem,
    ];
  });
}

const LIVE = new Set<string>(LIVE_JOB_STATUSES);

const phaseOf = (payload: unknown): OnboardingJobPhase => {
  const p = (payload as { onboardingPhase?: unknown } | null)?.onboardingPhase;
  return (ONBOARDING_JOB_PHASES as readonly unknown[]).includes(p)
    ? (p as OnboardingJobPhase)
    : 'analyse';
};

/**
 * The thread's answerable batch with its due rule (project-onboarding `expect-answers`,
 * `unanswered`): one read for the onboarding thread and the first-requirements room.
 */
export async function openBatchView(
  tx: Executor,
  arm: SQL,
  now: Date,
): Promise<OpenQuestionnaireBatch | null> {
  const [batch] = await tx
    .select({
      id: questionnaireBatches.id,
      round: questionnaireBatches.round,
      createdAt: questionnaireBatches.createdAt,
    })
    .from(questionnaireBatches)
    .where(and(arm, inArray(questionnaireBatches.status, [...ANSWERABLE])))
    .limit(1);
  if (!batch) return null;
  const [items] = await tx
    .select({ n: count() })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.batchId, batch.id), eq(agentQuestions.status, 'open')));
  return {
    id: batch.id,
    round: batch.round,
    open: Number(items?.n ?? 0),
    postedAt: batch.createdAt.toISOString(),
    ...batchDue(batch.createdAt, now),
  };
}

export async function onboardingView(
  tx: Executor,
  row: OnboardingRow,
  now = new Date(),
): Promise<OnboardingView> {
  const [drafted, series, open, job, sensitive] = await Promise.all([
    designsOf(tx, row.projectId, row.designs),
    seriesItemsOf(tx, row),
    openBatchView(tx, eq(questionnaireBatches.onboardingId, row.id), now),
    row.lastJobId
      ? tx
          .select({
            id: jobs.id,
            status: jobs.status,
            payload: jobs.payload,
            pipelineRunId: jobs.pipelineRunId,
            queuedAt: jobs.queuedAt,
            dispatchedAt: jobs.dispatchedAt,
            finishedAt: jobs.finishedAt,
          })
          .from(jobs)
          .where(eq(jobs.id, row.lastJobId))
      : Promise.resolve([]),
    projectHoldsSensitiveData(row.projectId),
  ]);
  const j = job[0];
  const designs: OnboardingDesignView[] = drafted.map((d) => ({
    ...d,
    ...linkItems(d, series, row.roundsSent),
  }));
  const waitingOn =
    j && LIVE.has(j.status) && j.pipelineRunId
      ? await runWaitingOf(row.projectId, j.pipelineRunId)
      : null;
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    status: onboardingStatusOf(row, open !== null),
    roundsSent: row.roundsSent,
    maxRounds: QUESTIONNAIRE_MAX_ROUNDS,
    startedBy: row.startedBy,
    startedAt: row.startedAt.toISOString(),
    reanalyzedAt: row.reanalyzedAt?.toISOString() ?? null,
    doneAt: row.doneAt?.toISOString() ?? null,
    designs,
    openBatch: open,
    job: j
      ? {
          id: j.id,
          phase: phaseOf(j.payload),
          status: j.status,
          queuedAt: j.queuedAt.toISOString(),
          dispatchedAt: j.dispatchedAt?.toISOString() ?? null,
          finishedAt: j.finishedAt?.toISOString() ?? null,
          waitingOn,
        }
      : null,
    sensitiveData: sensitive,
  };
}

export async function readOnboardingState(
  projectId: string,
  userId: string,
): Promise<Omit<OnboardingStateResponse, 'firstRequirements'>> {
  await requireCan(actorFor(userId), 'project.read', projectResource(projectId));
  const row = await onboardingOf(db, projectId);
  const view = row ? await onboardingView(db, row) : null;
  return {
    onboarding: view,
    hint: hintOf(view, view ? 'none' : await systemContextOf(projectId)),
  };
}

/** Whether `projectId` holds a design drawn on the `system-context` template, and whether one is approved. */
async function systemContextOf(projectId: string): Promise<SystemContextState> {
  const rows = await db
    .select({ designStatus: projectWorkflows.designStatus })
    .from(projectWorkflows)
    .where(
      and(
        eq(projectWorkflows.projectId, projectId),
        sql`${projectWorkflows.document}->'template'->>'id' = 'system-context'`,
      ),
    );
  if (rows.some((r) => r.designStatus === 'approved')) return 'approved';
  return rows.length ? 'unapproved' : 'none';
}
