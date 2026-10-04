/**
 * The reads of onboarding: the project's onboarding as every surface sees it, with its designs'
 * live status, its open batch and its job, and the dashboard's one-line hint derived from them.
 */

import {
  ONBOARDING_JOB_PHASES,
  type OnboardingHint,
  type OnboardingJobPhase,
  type OnboardingStateResponse,
  type OnboardingView,
  QUESTIONNAIRE_DUE_DAYS,
  QUESTIONNAIRE_MAX_ROUNDS,
} from '@forge/contracts/onboarding';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { onboardings, questionnaireBatches } from '../db/schema-onboarding.js';
import { agentQuestions } from '../db/schema-questions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { LIVE_JOB_STATUSES } from '../jobs/status-sets.js';
import { assertProjectAccess } from '../lib/authz.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { readProjectDocument } from '../project-config/service.js';
import type { LiveJob } from './rules.js';

export type Executor = typeof db | Tx;
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

/** Whether the project's data policy (ISS-59) is above `off`: its onboarding then owes a data-flow design. */
export async function projectHoldsSensitiveData(projectId: string): Promise<boolean> {
  return (await dataPolicyOf(projectId)) !== 'off';
}

export async function projectHasRepository(projectId: string): Promise<boolean> {
  const doc = await readProjectDocument(projectId);
  return doc?.document.source.type === 'git';
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

const phaseOf = (payload: unknown): OnboardingJobPhase => {
  const p = (payload as { onboardingPhase?: unknown } | null)?.onboardingPhase;
  return (ONBOARDING_JOB_PHASES as readonly unknown[]).includes(p)
    ? (p as OnboardingJobPhase)
    : 'analyse';
};

export async function onboardingView(tx: Executor, row: OnboardingRow): Promise<OnboardingView> {
  const [designs, open, job, sensitive] = await Promise.all([
    designsOf(tx, row.projectId, row.designs),
    tx
      .select({
        id: questionnaireBatches.id,
        round: questionnaireBatches.round,
        createdAt: questionnaireBatches.createdAt,
      })
      .from(questionnaireBatches)
      .where(
        and(
          eq(questionnaireBatches.onboardingId, row.id),
          inArray(questionnaireBatches.status, ['open', 'skipped']),
        ),
      )
      .limit(1),
    row.lastJobId
      ? tx
          .select({
            id: jobs.id,
            status: jobs.status,
            payload: jobs.payload,
            queuedAt: jobs.queuedAt,
            dispatchedAt: jobs.dispatchedAt,
            finishedAt: jobs.finishedAt,
          })
          .from(jobs)
          .where(eq(jobs.id, row.lastJobId))
      : Promise.resolve([]),
    projectHoldsSensitiveData(row.projectId),
  ]);
  const batch = open[0];
  const openItems = batch
    ? (
        await tx
          .select({ id: agentQuestions.id })
          .from(agentQuestions)
          .where(and(eq(agentQuestions.batchId, batch.id), eq(agentQuestions.status, 'open')))
      ).length
    : 0;
  const j = job[0];
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    status: row.status,
    roundsSent: row.roundsSent,
    maxRounds: QUESTIONNAIRE_MAX_ROUNDS,
    startedBy: row.startedBy,
    startedAt: row.startedAt.toISOString(),
    reanalyzedAt: row.reanalyzedAt?.toISOString() ?? null,
    doneAt: row.doneAt?.toISOString() ?? null,
    designs,
    openBatch: batch
      ? {
          id: batch.id,
          round: batch.round,
          open: openItems,
          postedAt: batch.createdAt.toISOString(),
        }
      : null,
    job: j
      ? {
          id: j.id,
          phase: phaseOf(j.payload),
          status: j.status,
          queuedAt: j.queuedAt.toISOString(),
          dispatchedAt: j.dispatchedAt?.toISOString() ?? null,
          finishedAt: j.finishedAt?.toISOString() ?? null,
        }
      : null,
    sensitiveData: sensitive,
  };
}

const LIVE = new Set<string>(LIVE_JOB_STATUSES);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The project's system-context design, by its template: none, drafted but not approved, or approved. */
export type SystemContextState = 'none' | 'unapproved' | 'approved';

// cm:why the hint is derived, never stored: it says what the onboarding's own rows say now, and it
// leaves the dashboard once every onboarding design is approved (state `onboarded`). With no
// onboarding it reads the project's system-context design, so a project that has one approved is
// never told it has no system context (e2e D9)
export function hintOf(
  view: OnboardingView | null,
  now: Date = new Date(),
  systemContext: SystemContextState = 'none',
): OnboardingHint | null {
  if (!view) {
    if (systemContext === 'approved') return null;
    if (systemContext === 'unapproved') {
      return {
        tone: 'you',
        lead: 'System context not approved yet.',
        text: 'A system-context design is drafted; approve it in Workflows, or let the agent draft the rest.',
        action: 'start',
        actionLabel: 'Start onboarding',
      };
    }
    return {
      tone: 'you',
      lead: 'No system context yet.',
      text: 'The agent can read the code, draft the key designs and ask what it cannot tell.',
      action: 'start',
      actionLabel: 'Start onboarding',
    };
  }
  const drafted = view.designs.length;
  const approved = view.designs.filter((d) => d.designStatus === 'approved').length;
  if (view.status === 'done') {
    if (drafted > 0 && approved === drafted) return null;
    return {
      tone: 'ready',
      lead: 'Onboarding done.',
      text: `${plural(drafted - approved, 'design')} wait on your approval.`,
      action: 'open',
      actionLabel: 'Open onboarding',
    };
  }
  if (view.job && LIVE.has(view.job.status)) {
    const waiting = view.job.status === 'queued';
    return {
      tone: 'run',
      lead:
        view.job.phase === 'revise'
          ? 'Onboarding: updating designs.'
          : 'Onboarding: reading the code.',
      text: waiting
        ? 'Onboarding waits on a runner checkout; the project works meanwhile.'
        : 'One analysis job is running; the project works meanwhile.',
      action: 'open',
      actionLabel: 'Open onboarding',
    };
  }
  if (view.openBatch) {
    const ageDays = (now.getTime() - Date.parse(view.openBatch.postedAt)) / 86_400_000;
    const late = ageDays >= QUESTIONNAIRE_DUE_DAYS;
    const open = `Open questions ${view.openBatch.open}`;
    if (view.openBatch.round === 1) {
      return {
        tone: late ? 'attention' : 'you',
        lead: 'No system context yet.',
        text: `The agent read the code and drafted ${plural(drafted, 'design')} · ${open}${late ? ` · waiting ${Math.floor(ageDays)} days` : ''}`,
        action: 'continue',
        actionLabel: 'Start onboarding',
      };
    }
    return {
      tone: late ? 'attention' : 'you',
      lead: 'Onboarding:',
      text: `follow-up round waits on you · ${open}${late ? ` · waiting ${Math.floor(ageDays)} days` : ''}`,
      action: 'continue',
      actionLabel: 'Continue onboarding',
    };
  }
  if (view.job && view.job.status === 'failed') {
    return {
      tone: 'err',
      lead: 'Onboarding analysis failed.',
      text: 'The last code map stays; ask for a re-analysis from the thread.',
      action: 'open',
      actionLabel: 'Open onboarding',
    };
  }
  return {
    tone: 'run',
    lead: 'Onboarding in progress.',
    text: drafted ? `${plural(drafted, 'design')} drafted.` : 'Waiting for the analysis.',
    action: 'open',
    actionLabel: 'Open onboarding',
  };
}

export async function readOnboardingState(
  projectId: string,
  userId: string,
): Promise<OnboardingStateResponse> {
  await assertProjectAccess(projectId, userId, 'viewer');
  const row = await onboardingOf(db, projectId);
  const view = row ? await onboardingView(db, row) : null;
  return {
    onboarding: view,
    hint: hintOf(view, new Date(), view ? 'none' : await systemContextOf(projectId)),
  };
}

/** Whether `projectId` holds a design drawn on the `system-context` template, and whether one is approved. */
export async function systemContextOf(projectId: string): Promise<SystemContextState> {
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

/** Whether a workflow was drafted by this project's onboarding: such a design takes only a person's approval. */
export async function isOnboardingDesign(projectId: string, workflowId: string): Promise<boolean> {
  const row = await onboardingOf(db, projectId);
  return row?.designs.includes(workflowId) ?? false;
}
