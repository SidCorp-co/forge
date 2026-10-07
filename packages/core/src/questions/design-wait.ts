// A park question that waits on a workflow design revision, and the decision that answers it (ISS-254).
//
// The question names the revision when it is asked, so nothing here reads a prompt for a revision
// number. The approver's decision on that revision is the answer the question asked for: it is
// written as one, in the decision's own transaction, and `question.answered` carries it to the same
// consumers a person's answer reaches. A revision superseded before anyone decided it can no longer
// be decided, so its questions are voided and asked again of the revision that replaced it.

import type { ActorAgency } from '@forge/contracts/permissions';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { agentQuestions, isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import { projectWorkflowDesigns, projectWorkflows } from '../db/schema-workflows.js';
import type { IssueDependencyExecutor } from '../issues/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { type KernelActor, transition } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import { recordAnswerOnIssue } from './answer-record.js';

type Executor = IssueDependencyExecutor;

/** The revision a question waits on: its approver's decision answers it. */
export interface AwaitedDesign {
  workflowId: string;
  revision: number;
}

const DESIGN_SUPERSEDED = 'design_superseded';

/** Why an ask may not wait on the revision it names: the code it is refused with, and the sentence. */
export interface AwaitedDesignFault {
  code: 'QUESTION_DESIGN_UNKNOWN' | 'QUESTION_DESIGN_NOT_AWAITING';
  detail: string;
}

/**
 * Why an ask naming this revision is refused, or the design's flow where the revision is the one
 * awaiting its approver in this project.
 *
 * Taken under the project's workflow lock, the one a decision and a superseding write hold, so a
 * decision racing this ask either committed first and is refused here, or waits and then finds the
 * question this ask wrote.
 */
export async function awaitedDesignFault(
  executor: Executor,
  projectId: string,
  awaited: AwaitedDesign,
): Promise<{ fault: AwaitedDesignFault } | { flow: string }> {
  const { workflowId, revision } = awaited;
  await lockXact(executor, 'workflows', projectId);
  const [workflow] = await executor
    .select({
      projectId: projectWorkflows.projectId,
      flow: projectWorkflows.flow,
      designStatus: projectWorkflows.designStatus,
    })
    .from(projectWorkflows)
    .where(eq(projectWorkflows.id, workflowId))
    .limit(1);
  const designs = workflow
    ? await executor
        .select({
          revision: projectWorkflowDesigns.revision,
          decision: projectWorkflowDesigns.decision,
        })
        .from(projectWorkflowDesigns)
        .where(eq(projectWorkflowDesigns.workflowId, workflowId))
    : [];
  const named = designs.find((d) => d.revision === revision);
  if (!workflow || workflow.projectId !== projectId || !named) {
    return {
      fault: {
        code: 'QUESTION_DESIGN_UNKNOWN',
        detail: `\`awaitsDesign\` names workflow ${workflowId} revision ${revision}, which is not a proposed design revision of this issue's project — name a workflow of project ${projectId} and the revision it put in front of its approver`,
      },
    };
  }
  const latest = Math.max(...designs.map((d) => d.revision));
  const state =
    named.decision === 'approve'
      ? 'approved'
      : named.decision === 'return'
        ? 'returned'
        : latest !== revision
          ? `superseded by revision ${latest}`
          : workflow.designStatus === 'proposed'
            ? null
            : `at design status ${workflow.designStatus ?? 'none'}`;
  if (state !== null) {
    return {
      fault: {
        code: 'QUESTION_DESIGN_NOT_AWAITING',
        detail: `design \`${workflow.flow}\` revision ${revision} is ${state}, so no decision on it is still owed and a question waiting on it would wait forever — park on the revision awaiting its approver, or ask without \`awaitsDesign\``,
      },
    };
  }
  return { flow: workflow.flow };
}

async function openQuestionsAwaiting(tx: Executor, awaited: AwaitedDesign) {
  return tx
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.awaitsWorkflowId, awaited.workflowId),
        eq(agentQuestions.awaitsRevision, awaited.revision),
      ),
    )
    .orderBy(agentQuestions.createdAt, agentQuestions.id)
    .for('update');
}

function decisionAnswer(args: {
  flow: string;
  revision: number;
  decision: 'approve' | 'return';
  reason: string | null;
}): string {
  const design = `Design \`${args.flow}\` revision ${args.revision}`;
  if (args.decision === 'return') {
    return `${design} was returned by its approver: ${args.reason ?? ''}`.trim();
  }
  return args.reason
    ? `${design} was approved by its approver, with this note: ${args.reason}`
    : `${design} was approved by its approver.`;
}

/**
 * Answer every open question waiting on a revision with the decision just made on it. Called inside
 * the decision's transaction, so the decision and its answers commit together or not at all.
 */
export async function answerDesignQuestions(
  tx: Tx,
  args: {
    workflowId: string;
    revision: number;
    flow: string;
    decision: 'approve' | 'return';
    reason: string | null;
    by: string;
    agency: ActorAgency;
  },
): Promise<string[]> {
  const rows = await openQuestionsAwaiting(tx, args);
  const body = decisionAnswer(args);
  const now = new Date();
  for (const row of rows) {
    const current = row.steps[row.steps.length - 1];
    if (!current || isChoiceStep(current)) {
      throw new Error(
        `questions: question ${row.id} waits on a design revision and its round is not free text — only a park writes that link, and a park asks in free text`,
      );
    }
    const answered: QuestionStep = {
      ...current,
      answeredAt: now.toISOString(),
      answerText: body,
      answeredBy: args.by,
    };
    const steps = row.steps.map((s, i) => (i === row.steps.length - 1 ? answered : s));
    await transition(tx, QUESTION_MACHINE, {
      to: 'answered',
      from: 'open',
      set: { steps, updatedAt: now },
      where: eq(agentQuestions.id, row.id),
      actor: { type: 'user', id: args.by, agency: args.agency },
      source: 'workflows',
      returning: ['id'],
    });
    await recordAnswerOnIssue(tx, {
      issueId: row.issueId ?? null,
      questionId: row.id,
      round: answered.round,
      answer: body,
      by: args.by,
      agency: args.agency,
    });
    await emitEvent(tx, 'question.answered', {
      questionId: row.id,
      projectId: row.projectId,
      issueId: row.issueId ?? null,
      answeredBy: args.by,
      body,
    });
  }
  return rows.map((r) => r.id);
}

/**
 * Void every open question waiting on a revision a new one superseded before anyone decided it, and
 * hand back the issues they stood on, which `write.ts:reaskSupersededDesignQuestions` asks again.
 */
export async function voidSupersededDesignQuestions(
  tx: Tx,
  args: {
    workflowId: string;
    superseded: number;
    revision: number;
    flow: string;
    by: string;
    actor: KernelActor;
  },
): Promise<Array<{ projectId: string; issueId: string | null }>> {
  // the issues before their questions, in id order: a move of one of them locks the issue row and
  // then its questions, and the re-ask's insert reads that row, so this write takes the same order
  await tx.execute(sql`
    select id from issues where id in (
      select issue_id from agent_questions
       where status = 'open' and awaits_workflow_id = ${args.workflowId}
         and awaits_revision = ${args.superseded})
     order by id for update`);
  const rows = await openQuestionsAwaiting(tx, {
    workflowId: args.workflowId,
    revision: args.superseded,
  });
  if (rows.length === 0) return [];
  const reason = `design \`${args.flow}\` revision ${args.superseded} was superseded by revision ${args.revision} before anyone decided it`;
  await transition(tx, QUESTION_MACHINE, {
    to: 'void',
    from: 'open',
    set: {
      voidReason: reason,
      endedBy: args.by,
      endedReason: DESIGN_SUPERSEDED,
      updatedAt: new Date(),
    },
    where: inArray(
      agentQuestions.id,
      rows.map((r) => r.id),
    ),
    reason,
    actor: args.actor,
    source: 'workflows',
    returning: ['id'],
  });
  return rows.map((r) => ({ projectId: r.projectId, issueId: r.issueId }));
}

/** What settles a question that waits on a revision, said where `needs` gave nothing. */
export function neededFor(flow: string, revision: number): string {
  return `a decision on design \`${flow}\` revision ${revision} — approving or returning it on its design page answers this question`;
}
