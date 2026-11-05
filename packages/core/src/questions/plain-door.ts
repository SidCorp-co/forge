// Write the plain text a person decides a pending question from (`PUT /api/questions/:id/plain`,
// ISS-1006 round 2): the asker's three plain lines (`@forge/contracts/plain-decision`), set on the
// open round of a question already asked. A run's question or a steward decision raised before its
// asker was taught reads "No summary" where the person decides; this is how it gains its text
// without being asked again. It is the agents' door, never a person's word: the asker itself (the
// run's session, the steward), the project's master (an agent's credential that writes the project,
// `isMasterCredential`), or a project admin writes it. A settled question is refused by name, and a
// caller with no role on the question's project is answered not found, as every question door does.

import type { ActorAgency } from '@forge/contracts/permissions';
import { plainOf } from '@forge/contracts/plain-decision';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import { notFound } from '../middleware/route-errors.js';
import { holds, isMasterCredential, permissionFactsOf, requireHeld } from '../permissions/index.js';
import { refuseQuestion } from './write.js';

export interface PlainWritten {
  id: string;
  /** The round the text was written on: the question's open one. */
  round: number;
  plain: string;
}

/** Sets `plain` on the open round of an open question, as the asker, the master or an admin. */
export async function writePlainAs(args: {
  questionId: string;
  userId: string;
  agency: ActorAgency;
  plain: string;
}): Promise<PlainWritten> {
  const plain = plainOf(args.plain);
  if (!plain) throw new Error('questions: an empty plain text reached the door past its schema');
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
    const writer =
      row.askedBy === args.userId ||
      isMasterCredential(facts, args.agency) ||
      holds(facts, 'project.admin');
    if (!writer) {
      requireHeld(
        facts,
        'project.admin',
        "writing the plain text of a decision another asked (its asker, the project's master or the steward writes it too)",
      );
    }
    if (row.status !== 'open') {
      throw refuseQuestion(
        'QUESTION_NOT_OPEN',
        `this question is ${row.status}: its plain text is written while it waits on the person, and nothing was written`,
      );
    }
    const steps = row.steps;
    const open = steps.at(-1);
    if (!open) throw new Error(`questions: open question ${row.id} carries no round`);
    await tx
      .update(agentQuestions)
      .set({ steps: [...steps.slice(0, -1), { ...open, plain }], updatedAt: new Date() })
      .where(eq(agentQuestions.id, row.id));
    return { id: row.id, round: open.round, plain };
  });
}
