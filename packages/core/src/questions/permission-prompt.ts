// A Claude Code permission prompt a resident session raised, relayed by the runner's
// `PermissionRequest` hook (ISS-1268 B3): asked as a person's question on no issue, with the session
// and the tool as its origin, answered allow or deny in Approvals. The hook waits for the answer for a
// bound it names; past it, the box denies the call itself and ends the question here, so an answer
// given afterwards cannot read as one the session acted on. That end is a void with its own reason,
// which `notifications/notify-questions.ts` tells the project's admins: the timeout is never silent.

import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import { PERMISSION_RELAY_TIMEOUT } from '@forge/contracts/questions';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import { transition } from '../lifecycle/index.js';
import { notFound } from '../middleware/route-errors.js';
import { refuseQuestion } from './write.js';

/**
 * End the open permission-prompt question `questionId` of `projectId`: the box denied the call after
 * waiting `waitedSeconds` with no answer. A question that is no permission prompt, or one already
 * answered, is refused by name: the box then reads its answer, never ends it.
 */
export async function expirePermissionPrompt(args: {
  questionId: string;
  projectId: string;
  deviceId: string;
  waitedSeconds: number;
}): Promise<{ id: string; status: 'void'; voidReason: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.id, args.questionId))
      .limit(1)
      .for('update');
    if (!row || row.projectId !== args.projectId) throw notFound(`no question ${args.questionId}`);
    if (row.origin?.kind !== 'permission_prompt') {
      throw refuseQuestion(
        'QUESTION_SHAPE_INVALID',
        `question ${row.id} relays no permission prompt, so no relay timeout ends it`,
      );
    }
    if (row.status !== 'open') {
      throw refuseQuestion(
        'QUESTION_NOT_OPEN',
        `this question is ${row.status}: read its answer (GET /api/devices/me/questions/${row.id}) instead of ending it`,
      );
    }
    const voidReason = `${PERMISSION_RELAY_TIMEOUT}: nobody allowed or denied ${row.origin.tool} on ${row.origin.session} within ${args.waitedSeconds} s, so the Forge runner denied it`;
    await transition(tx, QUESTION_MACHINE, {
      to: 'void',
      from: 'open',
      set: {
        voidReason,
        endedReason: PERMISSION_RELAY_TIMEOUT,
        updatedAt: new Date(),
      },
      where: eq(agentQuestions.id, row.id),
      reason: voidReason,
      actor: { type: 'runner', id: args.deviceId },
      source: 'questions',
      returning: ['id'],
    });
    return { id: row.id, status: 'void' as const, voidReason };
  });
}
