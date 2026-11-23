// Closing a project's open questions when it is archived (ISS-1449): each is withdrawn through the
// question door (`void-door.ts:voidQuestionAs`), as the person archiving it, so a question that door
// refuses stays open and is returned by name rather than closed another way.

import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import { isRefusal } from '../lib/refusal.js';
import { voidQuestionAs } from './void-door.js';

/** What closing the project's questions did: the ones withdrawn, and each the door kept open. */
export interface ProjectQuestionsClosed {
  voided: string[];
  kept: { id: string; code: string }[];
}

/** Withdraw each open question of the project as `userId`, giving `reason`. */
export async function voidProjectQuestions(args: {
  projectId: string;
  userId: string;
  agency: ActorAgency;
  reason: string;
}): Promise<ProjectQuestionsClosed> {
  const open = await db
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.projectId, args.projectId), eq(agentQuestions.status, 'open')));
  const out: ProjectQuestionsClosed = { voided: [], kept: [] };
  for (const { id } of open) {
    try {
      await voidQuestionAs({ questionId: id, ...args });
      out.voided.push(id);
    } catch (err) {
      if (!isRefusal(err)) throw err;
      out.kept.push({ id, code: err.refusals[0]?.code ?? err.fallbackCode });
    }
  }
  return out;
}
