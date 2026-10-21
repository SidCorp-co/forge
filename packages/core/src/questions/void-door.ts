// Withdraw an open question that no longer needs its answer (`POST /api/questions/:id/void`): the
// question machine's `open → void`, made by a holder of `project.write` with the reason the asker of
// the question reads. The steward's undo of its own question goes through here (REQ-48 BC-12). A
// question its issue's park asked is refused: it ends when the issue leaves the park, so voiding it
// alone would leave the issue parked on nothing.

import { AUTONOMOUS_QUESTION_STATUS } from '@forge/contracts/issue-machine';
import type { ActorAgency } from '@forge/contracts/permissions';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import { transition } from '../lifecycle/index.js';
import { notFound } from '../middleware/route-errors.js';
import { permissionFactsOf, requireHeld } from '../permissions/index.js';
import { refuseQuestion } from './write.js';

/** What a voided question's `ended_reason` says: a person or an agent withdrew it at this door. */
const QUESTION_WITHDRAWN = 'withdrawn';

/**
 * Whether the question is the one its issue's latest move into the park wrote (`issue-coupling.ts`):
 * compared on the stored timestamps, at the database's own precision.
 */
async function isParkQuestion(tx: Tx, questionId: string): Promise<boolean> {
  const [hit] = (await tx.execute(sql`
    SELECT 1 AS hit FROM agent_questions q JOIN issues i ON i.id = q.issue_id
     WHERE q.id = ${questionId} AND i.status = ${AUTONOMOUS_QUESTION_STATUS}
       AND q.created_at = (
         SELECT max(k.created_at) FROM kernel_transitions k
          WHERE k.entity = 'issue' AND k.entity_id = q.issue_id
            AND k.to_status = ${AUTONOMOUS_QUESTION_STATUS})`)) as unknown as { hit: number }[];
  return hit !== undefined;
}

export async function voidQuestionAs(args: {
  questionId: string;
  userId: string;
  agency: ActorAgency;
  reason: string;
}): Promise<{ id: string; status: 'void'; voidReason: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.id, args.questionId))
      .limit(1)
      .for('update');
    if (!row?.projectId) throw notFound(`no question ${args.questionId}`);
    const facts = await permissionFactsOf(args.userId, row.projectId);
    if (facts.role === null) throw notFound(`no question ${args.questionId}`);
    requireHeld(facts, 'project.write', 'voiding a question');
    if (row.status !== 'open') {
      throw refuseQuestion(
        'QUESTION_NOT_OPEN',
        `this question is ${row.status} — only an open question is voided`,
      );
    }
    if (await isParkQuestion(tx, row.id)) {
      throw refuseQuestion(
        'QUESTION_IS_PARK',
        `this question is the park of its issue: it ends when the issue leaves ${AUTONOMOUS_QUESTION_STATUS}; move the issue (POST /api/issues/${row.issueId}/transition), which withdraws it`,
      );
    }
    await transition(tx, QUESTION_MACHINE, {
      to: 'void',
      from: 'open',
      set: {
        voidReason: args.reason,
        endedBy: args.userId,
        endedReason: QUESTION_WITHDRAWN,
        updatedAt: new Date(),
      },
      where: eq(agentQuestions.id, row.id),
      reason: args.reason,
      actor: { type: 'user', id: args.userId, agency: args.agency },
      source: 'questions',
      returning: ['id'],
    });
    return { id: row.id, status: 'void' as const, voidReason: args.reason };
  });
}
